import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowArgs, renderWorkflow, WorkflowCliError } from "../src/workflows/cli.ts";
import { WORKFLOW_ID, WORKFLOW_LIMITS } from "../src/workflows/types.ts";
import { configSchema, saveConfig } from "../src/config.ts";
import { installReviewSkill } from "../src/review/install.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const roots: string[] = [];
const WORKFLOW_TIMEOUT_MS = 30_000;
const workflowTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sys1-workflow-cli-")));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  const git = (...argv: string[]) => {
    const result = Bun.spawnSync(["git", ...argv], { cwd: repo, stdout: "pipe", stderr: "pipe", env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
    } });
    if (result.exitCode !== 0) throw new Error("fixture git command failed");
  };
  git("init", "--quiet");
  writeFileSync(join(repo, "code.ts"), "export const value = 1;\n");
  git("add", "code.ts");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  return { repo, home, root };
}

async function invoke(args: string[], location: { repo: string; home: string }) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: location.repo,
    env: { ...process.env, SYS1_HOME: location.home, HRANESS_AUDIENCE: "quiet", TYPESAFE_API_KEY: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

function files(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path, readFileSync(path).toString("base64")];
    }));
}

describe("workflow CLI boundary", () => {
  test("keeps child controls literal and binds explicit review limits and paths", () => {
    const command = [process.execPath, "test", "--help", "--version", "--json"];
    expect(parseWorkflowArgs([
      "--agent", "review", "--worktree", "--model=fake/v1", "--max-requests", "3",
      "--path", "src", "--path=--help", "--gateway", "--review-timeout-ms", "1500",
      "--timeout-ms=5000", "--pause-after-check", "--", ...command,
    ])).toEqual({ action: "review", command, timeoutMs: 5000, pauseAfterCheck: true, dryRun: false, json: true,
      review: { mode: "worktree", paths: ["src", "--help"], route: "fake/v1", gateway: true, maxRequests: 3, timeoutMs: 1500 } });
  });

  const review = ["review", "--worktree", "--model", "fake/v1", "--max-requests", "1"];
  const id = `wf-${"a".repeat(24)}`;
  const invalid = [
    [], ["check"], ["check", "--"], ["check", "--", ""], ["check", "--unknown", "--", "test"],
    ["check", "--model", "fake/v1", "--", "test"], ["check", "--pause-after-check", "--", "test"],
    ["check", "--dry-run=true", "--", "test"], ["check", "--timeout-ms=0", "--", "test"],
    ["check", `--timeout-ms=${WORKFLOW_LIMITS.maxTimeoutMs + 1}`, "--", "test"],
    ["check", "--timeout-ms=1.5", "--", "test"], ["check", "--json", "--json", "--", "test"],
    ["review", "--worktree", "--model", "fake/v1", "--", "test"],
    ["review", "--model", "fake/v1", "--max-requests=1", "--", "test"],
    ["review", "--worktree", "--model", "auto", "--max-requests=1", "--", "test"],
    [...review, "--staged", "--", "test"], [...review, "--model=other/v2", "--", "test"],
    [...review, `--review-timeout-ms=${WORKFLOW_LIMITS.maxReviewTimeoutMs + 1}`, "--", "test"],
    ["review", "--worktree", "--model=fake/v1", `--max-requests=${WORKFLOW_LIMITS.maxRequests + 1}`, "--", "test"],
    [...review, "--path=", "--", "test"], [...review, "--path", "--gateway", "--", "test"],
    ["show", "../../state"], ["show", "x".repeat(64)], ["list", "--dry-run"], ["verify", id, "--", "test"],
    ["resume", id], ["resume", id, "--max-requests=2", "--", "test"], ["resume", id, "--model=fake/v1", "--", "test"],
    ["check", "--", ...Array.from({ length: WORKFLOW_LIMITS.maxCommandArgs + 1 }, () => "arg")],
  ];
  test.each(invalid.map((args, index) => [index, args] as const))("rejects invalid boundary %s before execution", (_index, args) => {
    expect(() => parseWorkflowArgs(args)).toThrow(WorkflowCliError);
  });

  workflowTest("preview never runs a child, probes a backend, or creates state", async () => {
    const location = fixture();
    const marker = join(location.root, "child-ran");
    const command = [process.execPath, "-e", "Bun.write(process.argv[1], 'executed')", marker];
    let requests = 0;
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("", { status: 500 }); } });
    try {
      saveConfig(location.home, configSchema.parse({ version: 1, local: { enabled: false }, backends: [{ name: "fake", model: "v1", base_url: `http://127.0.0.1:${backend.port}` }] }));
      writeFileSync(join(location.repo, "code.ts"), "export const value = 2;\n");
      const before = files(location.home);
      for (const args of [["check"], [...review, "--path", "code.ts"]]) {
        const result = await invoke(["--json", "workflow", ...args, "--dry-run", "--", ...command], location);
        expect(result.code).toBe(0); expect(result.err).toBe("");
        expect(JSON.parse(result.out)).toMatchObject({ version: 1, status: "planned", check: null, review: null });
      }
      const missingGateway = await invoke(["workflow", "review", "--worktree", "--model", "local-fixture/v1", "--max-requests=1", "--dry-run", "--json", "--", ...command], location);
      expect(missingGateway.code).toBe(3);
      expect(JSON.parse(missingGateway.out)).toMatchObject({ ok: false, error: { code: "config" } });
      expect(existsSync(marker)).toBe(false);
      expect(files(location.home)).toEqual(before);
      expect(requests).toBe(0);
    } finally { await backend.stop(true); }
  }, WORKFLOW_TIMEOUT_MS);

  test.skipIf(process.platform !== "win32")("unsupported Windows execution fails before running a command or writing state", async () => {
    const location = fixture();
    const marker = join(location.root, "child-ran");
    const result = await invoke(["workflow", "check", "--json", "--", process.execPath, "-e", "Bun.write(process.argv[1], 'executed')", marker], location);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "unsupported_platform" } });
    expect(existsSync(marker)).toBe(false);
    expect(files(location.home)).toEqual({});
  }, WORKFLOW_TIMEOUT_MS);

  workflowTest("the installed review skill's combined preview runs through the shipped CLI", async () => {
    const location = fixture();
    const installed = await installReviewSkill({ repoRoot: location.repo, target: "codex" });
    const skill = readFileSync(join(location.repo, installed.path), "utf8");
    const example = skill.match(/```sh\n(sys1 workflow review[\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    const command = example!.replace(/\\\n/g, " ")
      .replace("<backend/model>", "fake/v1").replace("<path>", "code.ts")
      .replace("<required-check-command>", process.execPath).replace(" [args...]", " --version").trim().split(/\s+/);
    expect(command.shift()).toBe("sys1");
    const result = await invoke(command, location);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ command: "review", status: "planned", intent: { review: { maxRequests: 10, paths: ["code.ts"] } } });
    expect(files(location.home)).toEqual({});
  }, WORKFLOW_TIMEOUT_MS);

  workflowTest("check needs no model config and preserves command failure without leaking arguments", async () => {
    const location = fixture();
    // An unusable model config must not block commands that never use a model.
    writeFileSync(join(location.home, "config.json"), "invalid model config");
    const secret = "workflow-command-private-argument";
    writeFileSync(join(location.repo, "fail.cjs"), "process.exit(17);\n");
    const command = [process.execPath, "fail.cjs", secret, "--help", "--version", "--json"];
    const result = await invoke(["workflow", "check", "--agent", "--", ...command], location);
    expect(result.code, result.out + result.err).toBe(17); expect(result.err).toBe("");
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({ version: 1, command: "check", status: "failed", exitCode: 17, check: { status: "failed", exitCode: 17 }, review: null });
    expect(report.id).toMatch(WORKFLOW_ID);
    const recovery = renderWorkflow({ ...report, command: "show", status: "uncertain", check: null }, location.home);
    expect(recovery).toContain(`Expected private check log (may be absent): ${JSON.stringify(join(location.home, "workflows", "logs", report.intent.logId))}`);
    expect(recovery).toContain("resume will not repeat it");
    expect(result.out).not.toContain(secret);
    for (const [path, encoded] of Object.entries(files(location.home))) {
      if (path.endsWith(".log")) continue;
      expect(Buffer.from(encoded, "base64").includes(Buffer.from(secret))).toBe(false);
    }
    const show = await invoke(["workflow", "show", report.id, "--json"], location);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out)).toMatchObject({ command: "show", id: report.id, exitCode: 17 });
    const list = await invoke(["workflow", "list", "--json"], location);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out).runs.map((run: { id: string }) => run.id)).toEqual([report.id]);
    const verified = await invoke(["workflow", "verify", report.id, "--json"], location);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.out)).toMatchObject({ command: "verify", id: report.id, ok: true });
  }, WORKFLOW_TIMEOUT_MS);

  workflowTest("completed resume returns saved evidence without repeating a command", async () => {
    const location = fixture();
    const count = join(location.root, "execution-count");
    const command = [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'x')", count];
    const started = await invoke(["workflow", "check", "--json", "--", ...command], location);
    expect(started.code, started.out + started.err).toBe(0);
    const first = JSON.parse(started.out);
    expect(first.status).toBe("complete");
    const before = files(location.home);
    const preview = await invoke(["workflow", "resume", first.id, "--dry-run", "--json", "--", ...command], location);
    expect(preview.code).toBe(0);
    expect(files(location.home)).toEqual(before);
    const resumed = await invoke(["workflow", "resume", first.id, "--json", "--", ...command], location);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.out)).toMatchObject({ command: "resume", id: first.id, status: "complete", processDigest: first.processDigest, reused: true });
    expect(readFileSync(count, "utf8")).toBe("x");
  }, WORKFLOW_TIMEOUT_MS);

  workflowTest("review pauses without model traffic and resumes its pinned settings", async () => {
    const location = fixture();
    writeFileSync(join(location.repo, "code.ts"), "try { persist(); } catch {}\n");
    let requests = 0;
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("", { status: 500 }); } });
    try {
      saveConfig(location.home, configSchema.parse({ version: 1, local: { enabled: false }, backends: [{ name: "fake", model: "v1", base_url: `http://127.0.0.1:${backend.port}` }] }));
      const command = [process.execPath, "-e", "process.exit(0)"];
      const paused = await invoke(["workflow", ...review, "--pause-after-check", "--path=code.ts", "--json", "--", ...command], location);
      expect(paused.code, paused.out + paused.err).toBe(0);
      const before = JSON.parse(paused.out);
      expect(before).toMatchObject({ status: "paused", check: { status: "passed" }, review: null });
      expect(requests).toBe(0);
      const resumed = await invoke(["workflow", "resume", before.id, "--json", "--", ...command], location);
      expect(resumed.code, JSON.stringify({ out: resumed.out, err: resumed.err, requests })).toBe(0);
      expect(JSON.parse(resumed.out)).toMatchObject({ status: "complete", advisory: true, intent: { review: { route: "fake/v1", maxRequests: 1, paths: ["code.ts"] } }, review: { requests: 0 } });
      expect(requests).toBe(0);
    } finally { await backend.stop(true); }
  }, WORKFLOW_TIMEOUT_MS);
});
