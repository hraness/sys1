import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema, saveConfig } from "../src/config.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
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
  });
  test("literal path flags do not become help/version and invalid commands stay JSON", async () => {
    const { repo, home } = fixture();
    for (const path of ["--help", "--version"]) {
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
      ["rules", "list", "--ensure", "anything"],
    ]) {
      const result = await invoke(["--agent", ...args], repo, home);
      expect(result.code).toBe(2); expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "usage" } });
    }
  });
  test("full loop records feedback, avoids repeat inference, and never calls changed evidence fixed", async () => {
    const { repo, home } = fixture();
    let calls = 0;
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "v1" }] });
      if (path !== "/v1/systemone") return new Response("", { status: 404 });
      calls++;
      const body = await request.json() as { questions: Record<string, { type: string }> };
      return Response.json({ model: "v1", answers: Object.fromEntries(Object.entries(body.questions).map(([id]) => [id, { type: "noul", noul: 0.01 }])), usage: { input_tokens: 10, output_tokens: 1 } });
    } });
    saveConfig(home, configSchema.parse({ version: 1, local: { enabled: false }, backends: [{ name: "fake", model: "v1", base_url: `http://127.0.0.1:${backend.port}` }] }));
    try {
      const checkpoint = ["review", "checkpoint", "--worktree", "--model", "fake/v1", "--json", "--", "code.ts"];
      const first = await invoke(checkpoint, repo, home);
      expect(first.code).toBe(0);
      const observed = JSON.parse(first.out);
      expect(observed.status).toBe("complete");
      expect(observed.findings).toHaveLength(1);
      const id = observed.findings[0].id;
      const repeated = await invoke(checkpoint, repo, home);
      expect(JSON.parse(repeated.out)).toMatchObject({ status: "unchanged", requests: 0, suppressed_count: 1 });
      expect(calls).toBe(1);
      const feedback = await invoke(["review", "feedback", id, "useful", "--json"], repo, home);
      expect(JSON.parse(feedback.out).issue.feedback).toBe("useful");
      const recheck = await invoke(["review", "recheck", id, "--model", "fake/v1", "--json"], repo, home);
      expect(recheck.code).toBe(0); expect(JSON.parse(recheck.out).status).toBe("reported"); expect(calls).toBe(2);
      writeFileSync(join(repo, "code.ts"), "try { persist(); } catch (error) { throw error; }\n");
      const changed = await invoke(["review", "recheck", id, "--model", "fake/v1", "--json"], repo, home);
      expect(changed.code).toBe(8); expect(JSON.parse(changed.out).status).toBe("superseded"); expect(calls).toBe(2);
    } finally { backend.stop(true); }
  });
});
