import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type DiffMode = "worktree" | "staged" | "since";
export type DiffKind = "added" | "modified" | "deleted" | "renamed";
export interface LineRange { readonly start: number; readonly count: number }

export interface DiffUnit {
  /** SHA-256 of the exact state sent for review, including both sides of the change. */
  readonly id: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly kind: DiffKind;
  readonly language?: string;
  readonly oldRange: LineRange;
  readonly newRange: LineRange;
  readonly patch: string;
  /** Provider-ready state. Contains repository-relative paths, never the checkout location. */
  readonly state: string;
}

export type SkipReason = "excluded_sensitive" | "excluded_generated" | "binary" | "symlink" | "submodule"
  | "unmerged" | "unsupported_encoding" | "file_too_large" | "hunk_too_large" | "file_limit"
  | "unit_limit" | "total_bytes_limit" | "unreadable" | "changed_during_read" | "diff_too_large"
  | "unsupported_change" | "index_worktree_conflict";

export interface SkippedDiff {
  readonly path: string;
  readonly previousPath?: string;
  readonly reason: SkipReason;
  readonly oldRange?: LineRange;
  readonly newRange?: LineRange;
}

export interface DiffCollection {
  readonly repoRoot: string;
  readonly mode: DiffMode;
  /** Commit before the changes, or null for an unborn repository. */
  readonly base: string | null;
  readonly head: string | null;
  readonly units: DiffUnit[];
  readonly skipped: SkippedDiff[];
  readonly changedFiles: number;
  /** False when any selected change was excluded or could not be represented in full. */
  readonly complete: boolean;
}

export const AUDIT_DIFF_LIMITS = {
  maxFiles: 100,
  maxUnits: 300,
  maxFileBytes: 1_048_576,
  maxUnitBytes: 32_768,
  maxTotalBytes: 8_388_608,
  timeoutMs: 30_000,
} as const;

export interface CollectDiffOptions {
  readonly cwd: string;
  readonly mode: DiffMode;
  /** In since mode, compare this commit with HEAD; unstaged and untracked changes are excluded. */
  readonly since?: string;
  /** Literal repository-relative files or directories. Absolute paths must remain inside the repository. */
  readonly paths?: readonly string[];
  readonly maxFiles?: number;
  readonly maxUnits?: number;
  readonly maxFileBytes?: number;
  readonly maxUnitBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
}

export type DiffErrorCode = "invalid_options" | "not_repository" | "invalid_ref" | "git_failed"
  | "git_output_limit" | "timeout" | "invalid_git_output" | "repository_changed";

/** Diagnostics never include source, Git stderr, or subprocess output. */
export class DiffError extends Error {
  constructor(readonly code: DiffErrorCode, message: string) {
    super(message);
    this.name = "DiffError";
  }
}

const encoder = new TextEncoder();
const bytes = (value: string): number => encoder.encode(value).byteLength;
const zeroOid = /^0+$/;
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const enumerationLimit = 4_194_304;

interface GitResult { readonly output: Uint8Array; readonly exitCode: number }
interface GitRunner {
  readonly run: (args: readonly string[], limit?: number, accept?: readonly number[]) => Promise<GitResult>;
  readonly extraConfig: string[];
}

function gitRunner(cwd: string, deadline: number): GitRunner {
  const env = { ...process.env };
  // Inherited Git overrides can silently redirect the requested checkout or inject command configuration.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" });
  const extraConfig: string[] = [];
  return {
    extraConfig,
    async run(args, limit = enumerationLimit, accept = [0]): Promise<GitResult> {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DiffError("timeout", "Git evidence collection exceeded its time limit");
      const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", ...extraConfig, ...args], {
        cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      let failure: DiffError | undefined;
      const stop = (error: DiffError): void => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop(new DiffError("timeout", "Git evidence collection exceeded its time limit")), remaining);
      const read = async (stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> => {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > maximum) {
              stop(new DiffError("git_output_limit", "Git evidence exceeded its output limit"));
              await reader.cancel();
              return new Uint8Array();
            }
            chunks.push(next.value);
          }
          const output = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
          return output;
        } finally { reader.releaseLock(); }
      };
      try {
        const [output, , exitCode] = await Promise.all([read(child.stdout, limit), read(child.stderr, 16_384), child.exited]);
        if (failure !== undefined) throw failure;
        if (!accept.includes(exitCode)) throw new DiffError("git_failed", "Git could not collect the requested evidence");
        return { output, exitCode };
      } finally {
        clearTimeout(timer);
        // Always collect an owned process, including output-reader errors.
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    },
  };
}

function decode(output: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output); }
  catch { throw new DiffError("invalid_git_output", "Git evidence is not valid UTF-8"); }
}

function nulItems(output: Uint8Array): string[] {
  const text = decode(output);
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new DiffError("invalid_git_output", "Git returned incomplete path metadata");
  return text.slice(0, -1).split("\0");
}

function validPath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\0")
    && !(sep === "\\" && /[\\:]/.test(path))
    && !path.split("/").some((part) => part === ".." || part === "." || part === "");
}

interface Change {
  readonly path: string;
  readonly previousPath?: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
  readonly status: string;
  readonly untracked?: true;
}

function parseChanges(output: Uint8Array): Change[] {
  const fields = nulItems(output);
  const changes: Change[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = header?.match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])\d*$/);
    if (match === null || match === undefined) throw new DiffError("invalid_git_output", "Git returned invalid change metadata");
    const first = fields[index++];
    const renamed = match[5] === "R" || match[5] === "C";
    const path = renamed ? fields[index++] : first;
    if (path === undefined || first === undefined || !validPath(path) || !validPath(first)) {
      throw new DiffError("invalid_git_output", "Git returned an unsafe repository path");
    }
    changes.push({
      path, ...(renamed ? { previousPath: first } : {}),
      oldMode: match[1] as string, newMode: match[2] as string,
      oldOid: match[3] as string, newOid: match[4] as string, status: match[5] as string,
    });
  }
  return changes;
}

function excluded(path: string): SkipReason | undefined {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1) as string;
  if (parts.some((part) => [".git", ".ssh", ".aws", ".gnupg", ".kube", "secrets", "credentials"].includes(part))
    || /(?:^|\.)env(?:\.|$)/.test(name) || name === ".envrc" || /^(?:credentials?|secrets?)(?:\.|$)/.test(name)
    || [".npmrc", ".pypirc", ".netrc", ".git-credentials", "auth.json", "kubeconfig"].includes(name)
    || /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.|$)/.test(name)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name) || /\.tfstate(?:\.|$)/.test(name)
    || /(?:service[-_]?account|credentials?)[^/]*\.json$/.test(name)
    || lower.includes(".config/gcloud/") || lower.includes(".config/gh/") || lower.endsWith(".docker/config.json")) return "excluded_sensitive";
  if (parts.some((part) => ["node_modules", "vendor", "dist", "build", "out", "coverage", "generated", ".next", ".nuxt", ".svelte-kit", ".cache", "target", "__pycache__", ".venv", "venv", "pods", ".terraform"].includes(part))
    || ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "gemfile.lock", "poetry.lock", "uv.lock", "composer.lock", "pipfile.lock", "go.sum", "packages.lock.json", "gradle.lockfile"].includes(name)
    || /(?:\.min\.(?:js|css)|\.map|\.generated\.[^.]+|\.g\.(?:ts|cs|dart))$/.test(name)) return "excluded_generated";
  return undefined;
}

export function languageFor(path: string): string | undefined {
  const extension = path.toLowerCase().split(".").at(-1) as string;
  const languages: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", pyi: "python",
    rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sh: "shell", bash: "shell",
    zsh: "shell", fish: "shell", ps1: "powershell", sql: "sql", md: "markdown", mdx: "markdown",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", html: "html", css: "css", scss: "scss",
    vue: "vue", svelte: "svelte", xml: "xml", tf: "terraform", lua: "lua", ex: "elixir", exs: "elixir",
  };
  return languages[extension];
}

function numberOption(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new DiffError("invalid_options", "A diff limit is outside its supported range");
  }
  return selected;
}

async function selectors(root: string, paths: readonly string[] | undefined): Promise<string[]> {
  if (paths === undefined) return [];
  if (paths.length > 1_024) throw new DiffError("invalid_options", "Too many path selectors");
  const selected: string[] = [];
  for (const path of paths) {
    if (!path || path.includes("\0") || bytes(path) > 4_096) throw new DiffError("invalid_options", "Invalid path selector");
    let absolute = resolve(root, path);
    // Canonicalize absolute aliases such as macOS /var -> /private/var. A
    // deleted selected path need not exist, so resolve its nearest existing parent.
    if (isAbsolute(path)) {
      let current = absolute;
      const missing: string[] = [];
      for (;;) {
        try { absolute = resolve(await realpath(current), ...missing); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) {
            throw new DiffError("invalid_options", "The absolute path selector cannot be resolved");
          }
          missing.unshift(basename(current));
          current = dirname(current);
        }
      }
    }
    const rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new DiffError("invalid_options", "Path selectors must stay inside the repository");
    }
    selected.push(rel.split(sep).join("/"));
  }
  return selected;
}

interface Signature { readonly size: number; readonly identity: string }
class SkipFile extends Error { constructor(readonly reason: SkipReason) { super(reason); } }

/** Inspect each component before descending. Git may represent deleted parents that no longer exist. */
async function signature(root: string, path: string, allowMissing: boolean): Promise<Signature | undefined> {
  const parts = path.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index] as string);
    const rel = relative(root, current);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SkipFile("unsupported_change");
    let info;
    try { info = await lstat(current, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
      throw new SkipFile("unreadable");
    }
    if (info.isSymbolicLink()) throw new SkipFile("symlink");
    if (index < parts.length - 1) {
      if (!info.isDirectory()) throw new SkipFile("unsupported_change");
      continue;
    }
    if (!info.isFile()) throw new SkipFile("unsupported_change");
    return { size: Number(info.size), identity: `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
  }
  throw new SkipFile("unsupported_change");
}

const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--ignore-submodules=none", "--find-renames", "--no-abbrev"];
const patchFlags = ["--patch", "--unified=15", "--inter-hunk-context=0", "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= "];

interface Hunk { readonly oldRange: LineRange; readonly newRange: LineRange; readonly text: string }
function patchForChange(output: string, change: Change): string {
  const boundary = output.indexOf("\0\0");
  if (boundary === -1) throw new SkipFile("changed_during_read");
  const metadata = parseChanges(encoder.encode(output.slice(0, boundary + 1)));
  const patches = output.slice(boundary + 2).split(/(?=^diff --git )/m).filter((part) => part !== "");
  if (metadata.length !== patches.length) throw new DiffError("invalid_git_output", "Git patch sections do not match their path metadata");
  const index = metadata.findIndex((item) => item.path === change.path && item.previousPath === change.previousPath
    && item.oldOid === change.oldOid && item.newOid === change.newOid && item.oldMode === change.oldMode && item.newMode === change.newMode
    && item.status === change.status);
  if (index === -1) throw new SkipFile("changed_during_read");
  return patches[index] as string;
}

function hunks(patch: string): Hunk[] {
  if (patch.includes("\0") || /^(?:Binary files |GIT binary patch)/m.test(patch)) throw new SkipFile("binary");
  const result: Hunk[] = [];
  let current: { oldRange: LineRange; newRange: LineRange; lines: string[] } | undefined;
  const flush = (): void => {
    if (current !== undefined) result.push({ oldRange: current.oldRange, newRange: current.newRange, text: `${current.lines.join("\n")}\n` });
    current = undefined;
  };
  // The final empty split field is not a context line.
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match !== null) {
      flush();
      current = {
        oldRange: { start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) },
        newRange: { start: Number(match[3]), count: match[4] === undefined ? 1 : Number(match[4]) },
        lines: [line],
      };
    } else if (line.startsWith("diff --git ")) flush();
    else if (current !== undefined) {
      if (!/^[ +\-\\]/.test(line)) throw new DiffError("invalid_git_output", "Git returned an invalid patch hunk");
      current.lines.push(line);
    }
  }
  flush();
  return result;
}

function buildUnit(change: Change, hunk: Hunk): DiffUnit {
  const kind: DiffKind = change.status === "A" ? "added" : change.status === "D" ? "deleted" : change.previousPath === undefined ? "modified" : "renamed";
  const language = languageFor(change.path);
  const previousPath = change.previousPath;
  const metadata = {
    path: change.path, ...(previousPath === undefined ? {} : { previousPath }), kind,
    ...(language === undefined ? {} : { language }), oldRange: hunk.oldRange, newRange: hunk.newRange,
  };
  const header = [
    `diff --git ${JSON.stringify(`a/${previousPath ?? change.path}`)} ${JSON.stringify(`b/${change.path}`)}`,
    ...(change.oldMode === change.newMode ? [] : [`old mode ${change.oldMode}`, `new mode ${change.newMode}`]),
    ...(previousPath === undefined ? [] : [`rename from ${JSON.stringify(previousPath)}`, `rename to ${JSON.stringify(change.path)}`]),
    `--- ${kind === "added" ? "/dev/null" : JSON.stringify(`a/${previousPath ?? change.path}`)}`,
    `+++ ${kind === "deleted" ? "/dev/null" : JSON.stringify(`b/${change.path}`)}`,
  ].join("\n");
  const patch = `${header}\n${hunk.text}`;
  const state = JSON.stringify({ ...metadata, patch });
  return { id: createHash("sha256").update(state).digest("hex"), ...metadata, patch, state };
}

/**
 * Collect advisory evidence without changing the repository. Git keeps removed
 * lines and coalesces overlapping 15-line context windows. A hunk that cannot
 * fit is reported, never truncated. This is change coverage, not a correctness verdict.
 */
export async function collectDiff(options: CollectDiffOptions): Promise<DiffCollection> {
  const maxFiles = numberOption(options.maxFiles, AUDIT_DIFF_LIMITS.maxFiles, 1_000);
  const maxUnits = numberOption(options.maxUnits, AUDIT_DIFF_LIMITS.maxUnits, 2_000);
  const maxFileBytes = numberOption(options.maxFileBytes, AUDIT_DIFF_LIMITS.maxFileBytes, 4_194_304);
  const maxUnitBytes = numberOption(options.maxUnitBytes, AUDIT_DIFF_LIMITS.maxUnitBytes, 131_072);
  const maxTotalBytes = numberOption(options.maxTotalBytes, AUDIT_DIFF_LIMITS.maxTotalBytes, 33_554_432);
  const timeoutMs = numberOption(options.timeoutMs, AUDIT_DIFF_LIMITS.timeoutMs, 60_000);
  if (!["worktree", "staged", "since"].includes(options.mode) || (options.mode !== "since" && options.since !== undefined)) {
    throw new DiffError("invalid_options", "Select one supported diff mode");
  }
  const deadline = Date.now() + timeoutMs;
  const initial = gitRunner(options.cwd, deadline);
  let repoRoot: string;
  try {
    const value = decode((await initial.run(["rev-parse", "--show-toplevel"], 16_384)).output);
    if (!value.endsWith("\n")) throw new Error("missing root");
    repoRoot = await realpath(value.slice(0, -1));
  } catch (error) {
    if (error instanceof DiffError && error.code !== "git_failed") throw error;
    throw new DiffError("not_repository", "The working directory is not a Git worktree");
  }
  const selected = await selectors(repoRoot, options.paths);
  const git = gitRunner(repoRoot, deadline);
  // Working-tree comparison can invoke clean/process filters. Disable their
  // configured commands as well as external diff and textconv, without disabling ignores.
  const filterKeys = nulItems((await git.run(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], 32_768, [0, 1])).output);
  if (filterKeys.length > 128) throw new DiffError("invalid_git_output", "Too many configured Git filters");
  for (const key of filterKeys) git.extraConfig.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
  const resolveCommit = async (ref: string, optional = false): Promise<string | null> => {
    const result = await git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], 256, [0, 1]);
    if (result.exitCode !== 0) {
      if (optional) return null;
      throw new DiffError("invalid_ref", "The since reference does not name a commit");
    }
    const oid = decode(result.output).trim();
    if (!oidPattern.test(oid)) throw new DiffError("invalid_git_output", "Git returned an invalid commit identity");
    return oid;
  };
  const head = await resolveCommit("HEAD", true);
  let base = head;
  if (options.mode === "since") {
    if (!options.since || options.since.includes("\0") || bytes(options.since) > 1_024) throw new DiffError("invalid_options", "Since mode requires a bounded commit reference");
    base = await resolveCommit(options.since);
    if (head === null) throw new DiffError("invalid_ref", "Since mode requires a committed HEAD");
  }
  const comparisonBase = base ?? decode((await git.run(["hash-object", "-t", "tree", "--stdin"], 256)).output).trim();
  if (!oidPattern.test(comparisonBase)) throw new DiffError("invalid_git_output", "Git returned an invalid tree identity");
  const revisions = options.mode === "since" ? [comparisonBase, head as string] : options.mode === "staged" ? ["--cached", comparisonBase] : [comparisonBase];
  const rawArgs = ["diff", ...diffFlags, "--raw", "-z", ...revisions, "--"];
  const originalRaw = (await git.run(rawArgs)).output;
  const byPath = new Map(parseChanges(originalRaw).map((change) => [change.path, change]));
  const renamedSources = new Set([...byPath.values()].flatMap((change) => change.previousPath === undefined ? [] : [change.previousPath]));
  const ambiguousWorktreePaths = new Set<string>();
  let originalUntracked: Uint8Array | undefined;
  const unmerged = new Set<string>();
  if (options.mode !== "since") {
    for (const entry of nulItems((await git.run(["ls-files", "--unmerged", "-z"])).output)) {
      const match = entry.match(/^[0-7]{6} (?:[0-9a-f]{40}|[0-9a-f]{64}) [123]\t([\s\S]+)$/);
      const path = match?.[1];
      if (path === undefined || !validPath(path)) throw new DiffError("invalid_git_output", "Git returned an unsafe unmerged path");
      unmerged.add(path);
      if (!byPath.has(path)) byPath.set(path, { path, oldMode: "000000", newMode: "000000", oldOid: "0", newOid: "0", status: "U" });
    }
  }
  if (options.mode === "worktree") {
    originalUntracked = (await git.run(["ls-files", "--others", "--exclude-standard", "-z"])).output;
    for (const path of nulItems(originalUntracked)) {
      if (!validPath(path)) throw new DiffError("invalid_git_output", "Git returned an unsafe untracked path");
      // An index deletion can coexist with an untracked replacement at the
      // same path. Do not overwrite the old identity and silently lose it.
      if (byPath.has(path)) continue;
      if (renamedSources.has(path)) ambiguousWorktreePaths.add(path);
      byPath.set(path, { path, oldMode: "000000", newMode: "100644", oldOid: "0", newOid: "0", status: "A", untracked: true });
    }
  }
  const matches = (path: string): boolean => selected.length === 0 || selected.some((prefix) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`));
  const changes = [...byPath.values()].filter((change) => matches(change.path) || (change.previousPath !== undefined && matches(change.previousPath)))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const units: DiffUnit[] = [];
  const skipped: SkippedDiff[] = [];
  const skip = (change: Change, reason: SkipReason, hunk?: Hunk): void => {
    skipped.push({ path: change.path, ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }), reason,
      ...(hunk === undefined ? {} : { oldRange: hunk.oldRange, newRange: hunk.newRange }) });
  };
  let visited = 0;
  let totalBytes = 0;
  const worktreeSignatures = new Map<string, string | undefined>();
  const blobSizes = new Map<string, number>();
  const blobSize = async (oid: string): Promise<number> => {
    if (zeroOid.test(oid)) return 0;
    const existing = blobSizes.get(oid);
    if (existing !== undefined) return existing;
    const text = decode((await git.run(["cat-file", "-s", oid], 64)).output).trim();
    const size = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(size)) throw new DiffError("invalid_git_output", "Git returned an invalid blob size");
    blobSizes.set(oid, size);
    return size;
  };
  for (const change of changes) {
    if (Date.now() >= deadline) throw new DiffError("timeout", "Git evidence collection exceeded its time limit");
    const excludedReason = excluded(change.path) ?? (change.previousPath === undefined ? undefined : excluded(change.previousPath));
    if (excludedReason !== undefined) { skip(change, excludedReason); continue; }
    if (visited++ >= maxFiles) { skip(change, "file_limit"); continue; }
    if (units.length >= maxUnits) { skip(change, "unit_limit"); continue; }
    if (ambiguousWorktreePaths.has(change.path)) { skip(change, "index_worktree_conflict"); continue; }
    if (unmerged.has(change.path) || change.status === "U") { skip(change, "unmerged"); continue; }
    if ([change.oldMode, change.newMode].includes("120000")) { skip(change, "symlink"); continue; }
    if ([change.oldMode, change.newMode].includes("160000")) { skip(change, "submodule"); continue; }
    if (!["A", "M", "D", "R", "T"].includes(change.status)
      || [change.oldMode, change.newMode].some((mode) => mode !== "000000" && !mode.startsWith("100"))) {
      skip(change, "unsupported_change"); continue;
    }
    try {
      let before: Signature | undefined;
      let previousBefore: Signature | undefined;
      if (options.mode === "worktree") {
        before = await signature(repoRoot, change.path, change.status === "D");
        if (change.previousPath !== undefined) previousBefore = await signature(repoRoot, change.previousPath, true);
        // Git's tracked diff calls this deleted even when the index-removed
        // path has been recreated. Its patch would omit the replacement, so
        // report the ambiguous index/worktree combination instead of asking
        // a model to judge an incomplete before/after pair.
        if ((change.status === "D" && before !== undefined) || previousBefore !== undefined) throw new SkipFile("index_worktree_conflict");
      }
      if ((before?.size ?? 0) > maxFileBytes || await blobSize(change.oldOid) > maxFileBytes
        || (options.mode !== "worktree" && await blobSize(change.newOid) > maxFileBytes)) throw new SkipFile("file_too_large");
      const args = change.untracked
        ? ["diff", "--no-index", ...diffFlags, ...patchFlags, "--", "/dev/null", change.path]
        : ["diff", ...diffFlags, ...patchFlags, "--raw", "-z", ...revisions, "--", ...(change.previousPath === undefined ? [] : [change.previousPath]), change.path];
      let patch: string;
      try { patch = decode((await git.run(args, maxFileBytes * 3 + 65_536, [0, 1])).output); }
      catch (error) {
        if (error instanceof DiffError && error.code === "git_output_limit") throw new SkipFile("diff_too_large");
        if (error instanceof DiffError && error.code === "invalid_git_output") throw new SkipFile("unsupported_encoding");
        throw error;
      }
      if (!change.untracked) patch = patchForChange(patch, change);
      if (options.mode === "worktree") {
        const after = await signature(repoRoot, change.path, change.status === "D");
        const previousAfter = change.previousPath === undefined ? undefined : await signature(repoRoot, change.previousPath, true);
        if (before?.identity !== after?.identity || previousBefore?.identity !== previousAfter?.identity) throw new SkipFile("changed_during_read");
        worktreeSignatures.set(change.path, after?.identity);
        if (change.previousPath !== undefined) worktreeSignatures.set(change.previousPath, previousAfter?.identity);
      }
      const collected = hunks(patch);
      // Renames, mode changes, and empty-file additions/deletions still need explicit coverage.
      if (collected.length === 0) collected.push({ oldRange: { start: 0, count: 0 }, newRange: { start: 0, count: 0 }, text: "" });
      for (const hunk of collected) {
        if (units.length >= maxUnits) { skip(change, "unit_limit", hunk); continue; }
        const unit = buildUnit(change, hunk);
        const size = bytes(JSON.stringify(unit.state));
        if (size > maxUnitBytes) { skip(change, "hunk_too_large", hunk); continue; }
        if (totalBytes + size > maxTotalBytes) { skip(change, "total_bytes_limit", hunk); continue; }
        units.push(unit);
        totalBytes += size;
      }
    } catch (error) {
      if (error instanceof SkipFile) { skip(change, error.reason); continue; }
      throw error;
    }
  }
  if (options.mode !== "since") {
    const finalRaw = (await git.run(rawArgs)).output;
    if (!Buffer.from(originalRaw).equals(Buffer.from(finalRaw))) throw new DiffError("repository_changed", "The Git diff changed during evidence collection");
  }
  if (originalUntracked !== undefined) {
    const finalUntracked = (await git.run(["ls-files", "--others", "--exclude-standard", "-z"])).output;
    if (!Buffer.from(originalUntracked).equals(Buffer.from(finalUntracked))) throw new DiffError("repository_changed", "The untracked file set changed during evidence collection");
    for (const [path, expected] of worktreeSignatures) {
      try {
        if ((await signature(repoRoot, path, true))?.identity !== expected) {
          throw new DiffError("repository_changed", "A reviewed worktree file changed during evidence collection");
        }
      } catch (error) {
        if (error instanceof SkipFile) throw new DiffError("repository_changed", "A reviewed worktree path changed during evidence collection");
        throw error;
      }
    }
  }
  if (Date.now() >= deadline) throw new DiffError("timeout", "Git evidence collection exceeded its time limit");
  return { repoRoot, mode: options.mode, base, head, units, skipped, changedFiles: changes.length, complete: skipped.length === 0 };
}
