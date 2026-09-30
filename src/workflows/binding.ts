import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "../audit/schema.ts";
import { checkpointReview, resolveReviewRoot } from "../review/checkpoint.ts";
import { inside } from "./files.ts";
import { requireWorkflowPlatform, validateCommand } from "./command.ts";
import { WORKFLOW_LIMITS, WorkflowError, type WorkflowIntent, type WorkflowOptions } from "./types.ts";
import pkg from "../../package.json";

const exec = promisify(execFile);
export const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface LiveBinding { intent: WorkflowIntent; executable: string; env: NodeJS.ProcessEnv }

async function git(cwd: string, args: string[], allowMissing = false): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  try {
    const result = await exec("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", ...args],
      { cwd, env, encoding: "buffer", timeout: 15_000, maxBuffer: 4_194_304 });
    return result.stdout;
  } catch (error) {
    if (allowMissing && (error as { code?: unknown }).code === 128) return Buffer.alloc(0);
    throw new WorkflowError("git_failed", "Cannot bind the workflow to bounded Git evidence");
  }
}

async function fileDigest(path: string, maxBytes: number): Promise<{ sha256: string; bytes: number; mode: number }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes) throw new WorkflowError("source_limit", "Workflow input exceeds its file or byte limit");
    const hash = createHash("sha256"), buffer = Buffer.alloc(262_144);
    let bytes = 0;
    for (;;) {
      const read = await file.read(buffer);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw new WorkflowError("source_limit", "Workflow input exceeds its file or byte limit");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await file.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== after.size) {
      throw new WorkflowError("source_changed", "Workflow inputs changed while their identity was being read");
    }
    return { sha256: hash.digest("hex"), bytes, mode: after.mode & 0o777 };
  } finally { await file.close(); }
}

async function sourceIdentity(repo: string): Promise<{ head: string | null; sourceDigest: string }> {
  const head = (await git(repo, ["rev-parse", "--verify", "HEAD"], true)).toString("utf8").trim() || null;
  const status = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const listed = await git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  let names: string[];
  try { names = [...new Set(new TextDecoder("utf-8", { fatal: true }).decode(listed).split("\0").filter(Boolean))].sort(); }
  catch { throw new WorkflowError("unsupported_source", "Workflow paths must use UTF-8 names"); }
  if (names.length > WORKFLOW_LIMITS.maxSourceFiles) throw new WorkflowError("source_limit", "Workflow source exceeds its file limit");
  const hash = createHash("sha256").update("sys1-workflow-source-v1\0").update(status);
  let total = 0;
  for (const name of names) {
    const path = resolve(repo, name);
    if (!inside(repo, path) || isAbsolute(name)) throw new WorkflowError("unsafe_source", "Workflow source escaped its repository");
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { hash.update(canonicalJson({ name, missing: true })); continue; }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const link = await readlink(path);
      hash.update(canonicalJson({ name, link }));
      let target: string;
      try { target = await realpath(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!inside(repo, target)) throw new WorkflowError("unsupported_source", "Workflow source contains a link outside its repository");
      const file = await fileDigest(target, WORKFLOW_LIMITS.maxSourceBytes - total);
      total += file.bytes; hash.update(canonicalJson({ target: target.slice(repo.length + 1), ...file }));
      continue;
    }
    if (!stat.isFile()) throw new WorkflowError("unsupported_source", "Workflow source includes unsupported submodules or special files");
    const target = await realpath(path);
    if (!inside(repo, target)) throw new WorkflowError("unsupported_source", "Workflow source contains a link outside its repository");
    const file = await fileDigest(target, WORKFLOW_LIMITS.maxSourceBytes - total);
    total += file.bytes; hash.update(canonicalJson({ name, ...file }));
  }
  // Bind staged content and index flags, excluding Git's mutable filesystem-stat cache.
  hash.update(await git(repo, ["ls-files", "--stage", "-z"]));
  hash.update(await git(repo, ["ls-files", "-v", "-z"]));
  if (!(await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).equals(status)
    || ((await git(repo, ["rev-parse", "--verify", "HEAD"], true)).toString("utf8").trim() || null) !== head) {
    throw new WorkflowError("source_changed", "Git inputs changed while their identity was being read");
  }
  return { head, sourceDigest: hash.digest("hex") };
}

async function executableFor(name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = name.includes("/") ? [resolve(cwd, name)] : (env.PATH ?? "").split(":").slice(0, 512).map(path => resolve(cwd, path || ".", name));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); const path = await realpath(candidate); if ((await lstat(path)).isFile()) return candidate; }
    catch { /* A missing PATH candidate is not a diagnostic. */ }
  }
  throw new WorkflowError("command_missing", "Workflow command executable is unavailable", 127);
}

export async function bindWorkflow(options: WorkflowOptions, createdAt = Date.now(), logId = `${randomBytes(16).toString("hex")}.log`): Promise<LiveBinding> {
  requireWorkflowPlatform();
  const timeoutMs = options.timeoutMs ?? WORKFLOW_LIMITS.defaultTimeoutMs;
  validateCommand(options.command, timeoutMs);
  if (!/^[a-f0-9]{64}$/.test(options.configurationIdentity)) throw new WorkflowError("invalid_identity", "Workflow configuration identity must be a SHA-256 digest");
  if (options.signal?.aborted) throw new WorkflowError("cancelled", "Workflow cancelled before execution", 130);
  if (options.pauseAfterCheck && !options.review) throw new WorkflowError("invalid_pause", "Pausing after checks requires a review stage");
  const cwd = await realpath(options.cwd);
  const repo = await resolveReviewRoot(cwd);
  if (inside(repo, resolve(options.home))) throw new WorkflowError("unsafe_store", "Set SYS1_HOME outside the repository before saving a workflow");
  const liveEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["_", "SHLVL", "OLDPWD", "TERM_SESSION_ID"]) delete liveEnv[name];
  liveEnv.PWD = cwd;
  const env = Object.freeze(liveEnv);
  const executable = await executableFor(options.command[0]!, cwd, env);
  const source = await sourceIdentity(repo);
  const runtime = await realpath(process.execPath);
  const resolvedExecutable = await realpath(executable);
  const executableIdentity = await fileDigest(resolvedExecutable, 536_870_912);
  const runtimeIdentity = resolvedExecutable === runtime ? executableIdentity : await fileDigest(runtime, 536_870_912);
  const intent: WorkflowIntent = {
    version: 1, logId, createdAt, repo, cwd, ...source, timeoutMs, review: null,
    commandDigest: digest(options.command), environmentDigest: digest(env), configurationIdentity: options.configurationIdentity,
    toolchainDigest: digest({ adapter: 1, sys1: pkg.version, executable, resolvedExecutable, executableIdentity, runtime, runtimeIdentity, versions: process.versions }),
  };
  if (options.review) {
    const r = options.review;
    const reviewTimeout = r.timeoutMs ?? WORKFLOW_LIMITS.defaultReviewTimeoutMs;
    if (!/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/.test(r.route) || r.route.length > 128
      || !Number.isInteger(r.maxRequests) || r.maxRequests < 1 || r.maxRequests > WORKFLOW_LIMITS.maxRequests
      || !Number.isInteger(reviewTimeout) || reviewTimeout < 1 || reviewTimeout > WORKFLOW_LIMITS.maxReviewTimeoutMs
      || (r.paths?.length ?? 0) > WORKFLOW_LIMITS.maxPaths) throw new WorkflowError("invalid_review", "Workflow review route, selection, or limits are invalid");
    const rules = await r.loadRules(repo);
    const preview = await checkpointReview({ home: options.home, cwd, ...r, timeoutMs: reviewTimeout, dryRun: true, loadRules: async () => rules });
    // Resolve a moving revision before persisting the intent; never retain a branch alias.
    const since = r.mode === "since" ? (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${r.since ?? ""}^{commit}`])).toString("utf8").trim() : null;
    intent.review = { mode: r.mode, since, paths: [...new Set(r.paths ?? [])].sort(), route: r.route, gateway: r.gateway ?? false,
      maxRequests: r.maxRequests, timeoutMs: reviewTimeout, snapshot: preview.snapshot,
      rulesDigest: digest(rules.rules.map(rule => [rule.id, rule.revision])),
    };
  }
  return { intent, executable, env };
}

export function sameIntent(expected: WorkflowIntent, actual: WorkflowIntent): boolean { return digest(expected) === digest(actual); }
