import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema, saveConfig } from "../src/config.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// These workflows launch several CLI processes and collect real Git snapshots.
// Keep their integration budget separate from single-invocation tests and
// product deadlines so shared-runner process/IO overhead has bounded headroom.
const CLI_WORKFLOW_TIMEOUT_MS = 20_000;
const scratch: string[] = [];
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sys1-review-cli-")));
  scratch.push(root);
  const repo = join(root, "repo"); const home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  const result = Bun.spawnSync(["git", "init", "--quiet"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("fixture init failed");
  writeFileSync(join(repo, "code.ts"), "try { persist(); } catch {}\n");
  return { repo, home };
}
async function invoke(args: string[], repo: string, home: string) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: repo, env: { ...process.env, SYS1_HOME: home, HRANESS_AUDIENCE: "quiet", TYPESAFE_API_KEY: "" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}
describe("review command", () => {
  test("preview, project setup, and rules work through the actual CLI", async () => {
    const { repo, home } = fixture();
    for (const args of [
      ["--json", "review", "checkpoint", "--worktree", "--model", "fake/v1", "--dry-run"],
      ["review", "setup", "codex", "--dry-run", "--json"],
      ["review", "issues", "--json"], ["rules", "list", "--json"],
    ]) {
      const result = await invoke(args, repo, home);
      expect(result.code).toBe(0); expect(result.err).toBe("");
      expect(JSON.parse(result.out).version).toBe(1);
    }
  }, CLI_WORKFLOW_TIMEOUT_MS);
  test("literal path flags do not become help/version and invalid commands stay JSON", async () => {
    const { repo, home } = fixture();
    for (const path of ["--help", "--version", "--rule"]) {
      writeFileSync(join(repo, path), "path is literal\n");
      const result = await invoke(["review", "checkpoint", "--worktree", "--model", "fake/v1", "--dry-run", "--json", "--", path], repo, home);
      expect(result.code).toBe(0); expect(JSON.parse(result.out).status).toBe("planned");
    }
    for (const args of [
      ["review", "issues", "--model", "fake/v1"],
      ["review", "checkpoint", "--worktree", "--staged", "--model", "fake/v1"],
      ["review", "checkpoint", "--worktree", "--model", "auto"],
      ["review", "checkpoint", "--worktree", "--model", "fake/v1", "code.ts"],
      ["review", "checkpoint", "--worktree", "--model", "fake/v1", "--max-requests", "201"],
      ["review", "setup", "codex", "--gateway"], ["review", "issues", "--", "code.ts"],
      ["review", "recheck", "a".repeat(16), "--model", "fake/v1", "--rule", "core-new-empty-catch"],
      ["review", "setup", "codex", "--rule", "core-new-empty-catch"],
      ["rules", "list", "--ensure", "anything"],
    ]) {
      const result = await invoke(["--agent", ...args], repo, home);
      expect(result.code).toBe(2); expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "usage" } });
    }
  }, CLI_WORKFLOW_TIMEOUT_MS);
  test("audit and checkpoint select the same exact rules, including repeated and equals options", async () => {
    const { repo, home } = fixture();
    writeFileSync(join(repo, "code.test.ts"), "test('example', () => { expect(true).toBe(true); });\n");
    const all = ["core-new-empty-catch", "core-removed-test-assertions"];
    for (const [selection, expected] of [
      [[], all],
      [["--rule", all[1]!], [all[1]!]],
      [[`--rule=${all[1]}`, "--rule", all[0]!, "--rule", all[1]!], all],
    ]) {
      for (const command of [["audit"], ["review", "checkpoint"]]) {
        const result = await invoke([...command, "--worktree", "--model", "fake/v1", "--dry-run", "--json", ...selection!, "--", "code.test.ts"], repo, home);
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.out);
        const report = parsed.audit ?? parsed;
        expect(report.rules.map((rule: { id: string }) => rule.id)).toEqual(expected);
        expect(report.planned_requests).toBe(1);
        expect(report.skipped).toEqual([]);
        expect(existsSync(join(home, "review"))).toBe(false);
      }
    }
  }, CLI_WORKFLOW_TIMEOUT_MS);
  const invalidRuleSelections: [string, string[]][] = [
    ["unknown rule", ["--rule", "missing-rule"]],
    ["known and unknown rules", ["--rule", "core-new-empty-catch", "--rule=missing-rule"]],
    ["malformed rule", ["--rule=BAD"]],
    ["empty rule", ["--rule="]],
  ];
  const invalidRuleCases = [["audit"], ["review", "checkpoint"]].flatMap(command =>
    [false, true].flatMap(empty => invalidRuleSelections.map(([name, selection]) =>
      [`${command.join(" ")} rejects ${name} with ${empty ? "no diff" : "a changed file"}`, command, empty, selection] as const)));
  test.each(invalidRuleCases)("%s before any backend request or state write", async (_name, command, empty, selection) => {
    const { repo, home } = fixture();
    if (empty) rmSync(join(repo, "code.ts"));
    let requests = 0;
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("", { status: 500 }); } });
    try {
      saveConfig(home, configSchema.parse({ version: 1, local: { enabled: false }, backends: [{ name: "fake", model: "v1", base_url: `http://127.0.0.1:${backend.port}` }] }));
      const result = await invoke([...command, "--worktree", "--model", "fake/v1", "--json", ...selection], repo, home);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "usage" } });
      expect(existsSync(join(home, "review"))).toBe(false);
      expect(requests).toBe(0);
    } finally { await backend.stop(true); }
  });
  test("full loop records feedback, avoids repeat inference, and never calls changed evidence fixed", async () => {
    const { repo, home } = fixture();
    let calls = 0;
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "v1" }] });
      if (path !== "/v1/systemone") return new Response("", { status: 404 });
      // The empty-catch rule is decided locally, so the model is never asked.
      calls++;
      const body = await request.json() as { questions: Record<string, { type: string }> };
      return Response.json({ model: "v1", answers: Object.fromEntries(Object.entries(body.questions).map(([id]) => [id, { type: "noul", noul: 0.01 }])), usage: { input_tokens: 10, output_tokens: 1 } });
    } });
    saveConfig(home, configSchema.parse({ version: 1, local: { enabled: false }, backends: [{ name: "fake", model: "v1", base_url: `http://127.0.0.1:${backend.port}` }] }));
    try {
      const checkpoint = ["review", "checkpoint", "--worktree", "--model", "fake/v1", "--rule", "core-new-empty-catch", "--json", "--", "code.ts"];
      const first = await invoke(checkpoint, repo, home);
      expect(first.code).toBe(0);
      const observed = JSON.parse(first.out);
      expect(observed.status).toBe("complete");
      expect(observed.findings).toHaveLength(1);
      const id = observed.findings[0].id;
      const repeated = await invoke(checkpoint, repo, home);
      expect(JSON.parse(repeated.out)).toMatchObject({ status: "unchanged", requests: 0, suppressed_count: 1 });
      expect(calls).toBe(0);
      const feedback = await invoke(["review", "feedback", id, "useful", "--json"], repo, home);
      expect(JSON.parse(feedback.out).issue.feedback).toBe("useful");
      const recheck = await invoke(["review", "recheck", id, "--model", "fake/v1", "--json"], repo, home);
      expect(recheck.code).toBe(0); expect(JSON.parse(recheck.out).status).toBe("reported"); expect(calls).toBe(0);
      writeFileSync(join(repo, "code.ts"), "try { persist(); } catch (error) { throw error; }\n");
      const changed = await invoke(["review", "recheck", id, "--model", "fake/v1", "--json"], repo, home);
      expect(changed.code).toBe(8); expect(JSON.parse(changed.out).status).toBe("superseded"); expect(calls).toBe(0);
    } finally { backend.stop(true); }
  }, CLI_WORKFLOW_TIMEOUT_MS);
});
