import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAuditCli } from "../src/audit/cli.ts";
import { configSchema, saveConfig } from "../src/config.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): { repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "sys1-audit-cli-"));
  scratch.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const result = Bun.spawnSync(["git", "init", "--quiet"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("fixture init failed");
  writeFileSync(join(repo, "code.ts"), "export function fetchData() { try { fetch(); } catch {} }\n");
  return { repo, home };
}
async function invoke(args: string[], repo: string, home: string): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, CLI, "audit", ...args], { cwd: repo, env: { ...process.env, SYS1_HOME: home, HRANESS_AUDIENCE: "quiet", TYPESAFE_API_KEY: "" }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

describe("audit command integration", () => {
  test("preview works in an unborn Git repository without credentials", async () => {
    const { repo, home } = fixture();
    const result = await invoke(["--worktree", "--model", "typesafe/jev-1.13.0", "--dry-run", "--json"], repo, home);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({ status: "planned", complete: false, requests: 0, planned_requests: 1, targets: [{ path: "code.ts", units: 1 }] });
    expect(report.rules.length).toBeGreaterThan(0);
    expect(result.out).not.toContain("export function");
    expect(result.err).toBe("");
  });

  test("bad flags and ambiguous scopes fail before provider calls", async () => {
    const { repo, home } = fixture();
    for (const args of [
      ["--staged", "--worktree", "--model", "fake/model"],
      ["--worktree", "--modle", "fake/model"],
      ["--worktree", "--model", "auto"],
      ["--worktree", "--model", "fake/model", "--max-requests", "-1"],
      ["--worktree", "--worktree", "--model", "fake/model"],
      ["--worktree", "--model", "fake/model", "--model=fake/other"],
      ["--worktree", "--model", "fake/model", "--dry-run", "--dry-run"],
      ["--worktree", "--model", "fake/model", "code.ts"],
      ["--worktree", "--model", "fake/model", "--", "../outside"],
    ]) {
      const result = await invoke(["--json", ...args], repo, home);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "usage" } });
    }
  });

  test("literal path flags cannot trigger help or version and agent errors stay JSON", async () => {
    const { repo, home } = fixture();
    for (const path of ["--help", "--version", "-h", "-V"]) {
      writeFileSync(join(repo, path), "literal selected file\n");
      const result = await invoke(["--worktree", "--model", "fake/model", "--dry-run", "--json", "--", path], repo, home);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({ status: "planned", changed_files: 1 });
    }
    const invalid = await invoke(["--agent", "--worktree", "--model", "auto"], repo, home);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.out)).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(invalid.err).toBe("");
  });

  test("a global JSON flag before the audit command is preserved", async () => {
    const { repo, home } = fixture();
    const child = Bun.spawn([process.execPath, CLI, "--json", "audit", "--worktree", "--model", "fake/model", "--dry-run"], {
      cwd: repo, env: { ...process.env, SYS1_HOME: home, HRANESS_AUDIENCE: "quiet", TYPESAFE_API_KEY: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ status: "planned", requests: 0 });
  });

  test("hosted default stays disabled and incomplete coverage has exit 8", async () => {
    const { repo, home } = fixture();
    const result = await invoke(["--worktree", "--model", "typesafe/jev-1.13.0", "--json"], repo, home);
    expect(result.code).toBe(8);
    expect(JSON.parse(result.out)).toMatchObject({ complete: false, status: "incomplete", evaluated_units: 0 });
  });

  test("registered loopback backend receives exact evidence and reports advisory findings", async () => {
    const { repo, home } = fixture();
    writeFileSync(join(repo, "code.test.ts"), "export function fetchData() { try { fetch(); } catch {} }\n");
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fake-v1" }] });
      if (new URL(request.url).pathname !== "/v1/systemone") return new Response("", { status: 404 });
      const body = await request.json() as { model: string; state: string; questions: Record<string, { type: string }> };
      calls++;
      expect(body.model).toBe("fake-v1");
      expect(body.state).toContain("+export function");
      expect(body.state).not.toContain(repo);
      expect(Object.keys(body.questions)).toEqual(["core-removed-test-assertions"]);
      return Response.json({ model: "fake-v1", answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, { type: question.type, noul: 0.01 }])), usage: { input_tokens: 100, output_tokens: 4 } });
    } });
    saveConfig(home, configSchema.parse({ version: 1, local: { enabled: false }, backends: [{ name: "fake", base_url: `http://127.0.0.1:${server.port}`, model: "fake-v1" }] }));
    try {
      const report = await runAuditCli(["--worktree", "--model", "fake/fake-v1", "--rule", "core-removed-test-assertions", "--", "code.test.ts"], home, repo);
      expect(calls).toBe(1);
      expect(report).toMatchObject({ complete: true, status: "complete", requests: 1, route: "fake/fake-v1" });
      expect(report.findings.length).toBeGreaterThan(0);
    } finally { server.stop(true); }
  });
});
