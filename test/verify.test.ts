import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sys1Client } from "../src/client.ts";
import type { SystemOneRequest } from "../src/protocol.ts";
import { parseVerifyArgs, renderVerify, verifyExitCode } from "../src/verify/cli.ts";
import { gitEvidence, pageUrls, prUrls, type CommandRunner } from "../src/verify/evidence.ts";
import { devinTurn, resolveMessage, VerifyError } from "../src/verify/message.ts";
import { CLAIMS, runVerify, type VerifyOptions } from "../src/verify/verify.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function fakeDecider(probabilities: Record<string, number>, calls?: { n: number }): Sys1Client {
  return {
    async evaluate(request: SystemOneRequest) {
      if (calls !== undefined) calls.n += 1;
      const answers = Object.fromEntries(Object.keys(request.questions).map(name => {
        const noul = probabilities[name] ?? probabilities["*"] ?? 0.9;
        return [name, { type: "noul" as const, noul }];
      }));
      return {
        response: { model: "fake", answers, usage: { input_tokens: 1, output_tokens: 1 } },
        metadata: { backend: "fake", attempts: 1 },
      };
    },
  };
}

const cleanRunner: CommandRunner = async command => {
  const key = command.join(" ");
  if (key.includes("rev-parse --show-toplevel")) return { code: 0, out: "/tmp/repo\n" };
  if (key.includes("status --porcelain")) return { code: 0, out: "" };
  if (key.includes("--abbrev-ref @{upstream}")) return { code: 0, out: "origin/main\n" };
  if (key.includes("rev-list --count")) return { code: 0, out: "0\n" };
  return { code: 128, out: "" };
};

async function repoDir(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sys1-verify-"));
  roots.push(root);
  return root;
}

function options(overrides: Partial<VerifyOptions> = {}): VerifyOptions {
  return { home: "/nonexistent-sys1-home", cwd: "/tmp", route: "fake/model", decider: fakeDecider({}), run: cleanRunner, ...overrides };
}

describe("sys1 verify argument parsing", () => {
  test("requires an explicit model route", () => {
    expect(() => parseVerifyArgs([])).toThrow(VerifyError);
    expect(() => parseVerifyArgs(["--model", "local-qwen"])).toThrow(VerifyError);
    expect(parseVerifyArgs(["--model", "typesafe/jev-1.13.0"]).model).toBe("typesafe/jev-1.13.0");
  });
  test("rejects unknown and repeated-singular flags", () => {
    expect(() => parseVerifyArgs(["--model", "a/b", "--bogus"])).toThrow(VerifyError);
    expect(() => parseVerifyArgs(["--model", "a/b", "--url"])).toThrow(VerifyError);
  });
  test("collects repeated urls and bounds the timeout", () => {
    const args = parseVerifyArgs(["--model", "a/b", "--url", "https://a.example", "--url=https://b.example", "--timeout-ms", "5000"]);
    expect(args.urls).toEqual(["https://a.example", "https://b.example"]);
    expect(args.timeoutMs).toBe(5_000);
    expect(() => parseVerifyArgs(["--model", "a/b", "--timeout-ms", "999999"])).toThrow(VerifyError);
  });
});

describe("url extraction", () => {
  test("finds https pages and skips private or credential-bearing hosts", () => {
    const text = "Deployed https://sys1.io/ and https://app.example.com/x. Also http://localhost:13900 and https://user:pw@bad.example";
    expect(pageUrls(text)).toEqual(["https://sys1.io/", "https://app.example.com/x"]);
  });
  test("extracts pull request links", () => {
    expect(prUrls("merged https://github.com/hraness/sys1/pull/60 now")).toEqual(["https://github.com/hraness/sys1/pull/60"]);
  });
});

describe("message resolution", () => {
  test("reads a message file and stdin is bounded", async () => {
    const dir = await repoDir();
    const file = join(dir, "message.txt");
    await writeFile(file, "Deployed and verified.\n");
    const message = await resolveMessage({ cwd: dir, messageFile: file, devinDb: join(dir, "missing.db") });
    expect(message.source).toBe("file");
    expect(message.text).toContain("Deployed");
    await expect(resolveMessage({ cwd: dir, messageFile: join(dir, "absent.txt") })).rejects.toThrow();
    await expect(resolveMessage({ cwd: dir, devinDb: join(dir, "missing.db") })).rejects.toThrow(VerifyError);
  });

  test("reads the last assistant message and check evidence from a Devin session", async () => {
    const dir = await repoDir();
    const cwd = join(dir, "repo");
    await mkdir(cwd);
    const dbPath = join(dir, "sessions.db");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT, model TEXT, agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER)");
    db.run("CREATE TABLE message_nodes (session_id TEXT, created_at INTEGER, chat_message TEXT)");
    db.run("INSERT INTO sessions VALUES ('s1', ?, 'devin', 'm', 'a', 1, 10)", [dir]);
    const node = (created: number, message: unknown) => db.run("INSERT INTO message_nodes VALUES ('s1', ?, ?)", [created, JSON.stringify(message)]);
    node(1, { role: "user", content: "please ship it" });
    node(2, { role: "assistant", tool_calls: [{ id: "c1", name: "exec", arguments: { command: "bun run check" } }] });
    node(3, { role: "tool", tool_call_id: "c1", content: "all green\nExit code: 0", metadata: { extensions: { "chisel/tool_result_meta": { success: true } } } });
    node(4, { role: "assistant", content: "Done. All checks pass and the site is deployed." });
    db.close();
    const found = devinTurn(dbPath, cwd);
    expect(found?.source).toBe("devin");
    expect(found?.text).toContain("checks pass");
    expect(found?.turn?.commands).toEqual(["bun run check"]);
    expect(found?.turn?.outputs[0]?.failed).toBe(false);
    expect(devinTurn(dbPath, join(await realpath(tmpdir()), "sys1-verify-elsewhere"))).toBeUndefined();
  });
});

describe("claim verification", () => {
  const allClaims = Object.fromEntries(Object.keys(CLAIMS).map(kind => [`claim_${kind}`, 0.95])) as Record<string, number>;
  const message = "All done: committed, pushed, checks pass, and it is deployed at https://sys1.io now.";

  test("clean evidence confirms claims and reports exit 0", async () => {
    const dir = await repoDir();
    const file = join(dir, "m.txt");
    await writeFile(file, message);
    const calls = { n: 0 };
    const report = await runVerify(options({
      cwd: dir, messageFile: file, devinDb: "/missing",
      decider: fakeDecider({ ...allClaims, page_reflects: 0.9 }, calls),
      fetchImpl: async () => new Response("<html>new hero</html>", { status: 200 }),
    }));
    expect(report.status).toBe("complete");
    expect(report.contradictions).toBe(0);
    expect(report.claims.find(item => item.kind === "deployed_or_live")!.verdict).toBe("confirmed");
    expect(report.claims.find(item => item.kind === "checks_passed")!.verdict).toBe("unverifiable");
    expect(verifyExitCode(report)).toBe(0);
    expect(calls.n).toBe(2);
  });

  test("contradicts a pushed claim when commits are unpushed", async () => {
    const dir = await repoDir();
    const file = join(dir, "m.txt");
    await writeFile(file, message);
    const runner: CommandRunner = async command => {
      const key = command.join(" ");
      if (key.includes("rev-list --count")) return { code: 0, out: "2\n" };
      return cleanRunner(command, dir, 10_000);
    };
    const report = await runVerify(options({
      cwd: dir, messageFile: file, devinDb: "/missing",
      decider: fakeDecider({ ...allClaims, claim_deployed_or_live: 0.01, claim_checks_passed: 0.01 }),
      run: runner,
      fetchImpl: async () => new Response("", { status: 200 }),
    }));
    expect(report.status).toBe("complete");
    const pushed = report.claims.find(item => item.kind === "merged_or_pushed")!;
    expect(pushed.verdict).toBe("contradicted");
    expect(pushed.evidence.join(" ")).toContain("ahead of");
    expect(report.contradictions).toBeGreaterThan(0);
    expect(verifyExitCode(report)).toBe(7);
  });

  test("contradicts a deployed claim when the fetched page lacks the change", async () => {
    const dir = await repoDir();
    const file = join(dir, "m.txt");
    await writeFile(file, message);
    const report = await runVerify(options({
      cwd: dir, messageFile: file, devinDb: "/missing",
      decider: fakeDecider({ claim_deployed_or_live: 0.95, page_reflects: 0.05, "*": 0.01 }),
      fetchImpl: async () => new Response("<html><body>old placeholder</body></html>", { status: 200 }),
    }));
    const live = report.claims.find(item => item.kind === "deployed_or_live")!;
    expect(live.verdict).toBe("contradicted");
    expect(verifyExitCode(report)).toBe(7);
  });

  test("unreachable pages are unverifiable, never contradicted", async () => {
    const dir = await repoDir();
    const file = join(dir, "m.txt");
    await writeFile(file, message);
    const report = await runVerify(options({
      cwd: dir, messageFile: file, devinDb: "/missing",
      decider: fakeDecider({ claim_deployed_or_live: 0.95, "*": 0.01 }),
      fetchImpl: async () => { throw new Error("network down"); },
    }));
    expect(report.claims.find(item => item.kind === "deployed_or_live")!.verdict).toBe("unverifiable");
    expect(report.contradictions).toBe(0);
    expect(verifyExitCode(report)).toBe(0);
  });

  test("a failed check command in the turn contradicts checks_passed", async () => {
    const dir = await repoDir();
    const cwd = join(dir, "repo");
    await mkdir(cwd);
    const dbPath = join(dir, "sessions.db");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT, model TEXT, agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER)");
    db.run("CREATE TABLE message_nodes (session_id TEXT, created_at INTEGER, chat_message TEXT)");
    db.run("INSERT INTO sessions VALUES ('s1', ?, 'devin', 'm', 'a', 1, 10)", [dir]);
    const node = (created: number, m: unknown) => db.run("INSERT INTO message_nodes VALUES ('s1', ?, ?)", [created, JSON.stringify(m)]);
    node(1, { role: "user", content: "fix it" });
    node(2, { role: "assistant", tool_calls: [{ id: "c1", name: "exec", arguments: { command: "bun test" } }] });
    node(3, { role: "tool", tool_call_id: "c1", content: "3 fail\nExit code: 1" });
    node(4, { role: "assistant", content: "All tests pass now." });
    db.close();
    const report = await runVerify(options({
      cwd, devinDb: dbPath,
      decider: fakeDecider({ claim_checks_passed: 0.95, "*": 0.01 }),
      fetchImpl: async () => new Response(""),
    }));
    const claim = report.claims.find(item => item.kind === "checks_passed")!;
    expect(claim.verdict).toBe("contradicted");
    expect(claim.evidence.join(" ")).toContain("bun test");
    expect(verifyExitCode(report)).toBe(7);
  });

  test("dry-run plans claims without a decider, fetch, or contradiction", async () => {
    const dir = await repoDir();
    const file = join(dir, "m.txt");
    await writeFile(file, message);
    const { decider: _unused, ...rest } = options({ cwd: dir, messageFile: file, dryRun: true });
    const report = await runVerify(rest);
    expect(report.status).toBe("planned");
    expect(report.requests).toBe(0);
    expect(report.claims.every(claim => claim.verdict === "unverifiable")).toBe(true);
  });
});

describe("rendering and git evidence", () => {
  test("renders claim verdicts and exit codes", async () => {
    const dir = await repoDir();
    const file = join(dir, "m.txt");
    await writeFile(file, "Nothing to verify.");
    const report = await runVerify(options({
      cwd: dir, messageFile: file, decider: fakeDecider({ "*": 0.01 }),
    }));
    expect(report.claims.every(claim => claim.verdict === "not_claimed")).toBe(true);
    expect(verifyExitCode(report)).toBe(0);
    expect(renderVerify(report)).toContain("0 contradictions");
  });

  test("gitEvidence reports a non-repository without throwing", async () => {
    const dir = await repoDir();
    const evidence = await gitEvidence(dir);
    expect(evidence.repo).toBe(false);
  });
});
