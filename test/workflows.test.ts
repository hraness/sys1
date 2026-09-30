import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectWorkflow, listWorkflows, resumeWorkflow, startWorkflow, verifyWorkflow, workflowLogPath, type WorkflowOptions } from "../src/workflows/index.ts";
import { WORKFLOW_LIMITS } from "../src/workflows/types.ts";
import { ruleRevision, ruleSchema } from "../src/audit/schema.ts";
import type { LoadedPack, LoadedRule, RuleSet } from "../src/audit/pack.ts";
import { Sys1ClientError, type Sys1Client } from "../src/client.ts";
import { AlgalError } from "@hraness/algal/errors";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const TIMEOUT = 30_000;
async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-c", "user.name=Workflow Test", "-c", "user.email=workflow@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
}
function ruleset(ensure = "PRIVATE_RULE_SENTINEL"): RuleSet {
  const rule = ruleSchema.parse({ id: "errors-visible", applies: { paths: ["**/*.ts"] }, ensure, breaks: "Errors disappear." });
  const pack = { name: "test", rules: [rule] } as unknown as LoadedPack;
  const loaded = { id: rule.id, rule, revision: ruleRevision(rule), pack, overrides: [] } satisfies LoadedRule;
  return { rules: [loaded], packs: [pack], get: id => id === rule.id ? loaded : undefined, pack: () => pack };
}
async function files(directory: string): Promise<string[]> {
  const names = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(names.map(item => item.isDirectory() ? files(join(directory, item.name)) : [join(directory, item.name)]))).flat();
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sys1-workflow-test-")); roots.push(root);
  const cwd = join(root, "repo"), home = join(root, "home"), counter = join(root, "check-count"); await mkdir(cwd);
  await git(cwd, "init", "--quiet");
  await writeFile(join(cwd, "code.ts"), "export const before = 1;\n");
  await git(cwd, "add", "."); await git(cwd, "commit", "--quiet", "-m", "base");
  await writeFile(join(cwd, "code.ts"), "export const PRIVATE_SOURCE_SENTINEL = 2;\n");
  let calls = 0;
  const decider: Sys1Client = { async evaluate(request) {
    calls++;
    return { response: { model: "model", answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.01 }])), usage: { input_tokens: 5, output_tokens: 1 } }, metadata: { backend: "fake", attempts: 1 } };
  } };
  const options: WorkflowOptions = { home, cwd, configurationIdentity: "a".repeat(64), command: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x'); process.stdout.write('PRIVATE_CHECK_LOG_SENTINEL');`], timeoutMs: 5_000 };
  const review: NonNullable<WorkflowOptions["review"]> = { mode: "worktree", route: "fake/model", maxRequests: 10, decider, loadRules: async () => ruleset() };
  return { root, cwd, home, counter, options, review, calls: () => calls };
}

// Every scenario below previews or executes a workflow and needs supported process
// groups. The CLI separately covers Windows rejection before effects.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("saved workflow engine", () => {
  test("preview and empty readers create no store or model requests", async () => {
    const f = await fixture();
    expect(await listWorkflows(f)).toEqual([]);
    expect(await startWorkflow({ ...f.options, review: f.review, dryRun: true })).toMatchObject({ status: "planned", check: null, review: null });
    expect(f.calls()).toBe(0);
    expect(await Bun.file(f.counter).exists()).toBe(false);
    expect((await readdir(f.root)).sort()).toEqual(["repo"]);
  }, TIMEOUT);

  test("pause, resume, and offline verification preserve checks and private metadata", async () => {
    const f = await fixture(), options = { ...f.options, review: f.review, pauseAfterCheck: true };
    const first = await startWorkflow(options);
    expect(first).toMatchObject({ status: "paused", exitCode: 0, check: { status: "passed", bindingStatus: "unchanged" }, review: null });
    expect(f.calls()).toBe(0);
    const next = await resumeWorkflow({ ...options, id: first.id });
    expect(next).toMatchObject({ status: "complete", reused: true, review: { advisory: true, complete: true, requests: 1 } });
    expect(next.review?.findings).toHaveLength(1);
    expect(next.review?.usage).toEqual({ input_tokens: 5, output_tokens: 1, known_requests: 1, unknown_requests: 0 });
    expect(await readFile(f.counter, "utf8")).toBe("x");
    expect(f.calls()).toBe(1);
    expect(await resumeWorkflow({ ...options, id: first.id })).toMatchObject({ status: "complete", reused: true });
    expect(await verifyWorkflow({ home: f.home, id: first.id })).toMatchObject({ ok: true, receipts: 2 });
    expect(f.calls()).toBe(1);
    const metadata = Buffer.concat(await Promise.all((await files(join(f.home, "workflows", "engine"))).map(path => readFile(path)))).toString("utf8");
    for (const sentinel of ["PRIVATE_SOURCE_SENTINEL", "PRIVATE_RULE_SENTINEL", "PRIVATE_CHECK_LOG_SENTINEL", "appendFileSync", '"noul"', '"model_score"']) expect(metadata).not.toContain(sentinel);
    expect(await readFile(workflowLogPath(f.home, next.intent.logId), "utf8")).toContain("PRIVATE_CHECK_LOG_SENTINEL");
  }, TIMEOUT);

  test("command failures preserve exact exit status and skip review", async () => {
    const f = await fixture();
    const report = await startWorkflow({ ...f.options, review: f.review, command: [process.execPath, "-e", "process.exit(7)"] });
    expect(report).toMatchObject({ status: "failed", exitCode: 7, check: { exitCode: 7, status: "failed" }, review: null });
    expect(f.calls()).toBe(0);
  }, TIMEOUT);

  test("source, command, configuration, and actual environment changes reject resume", async () => {
    const f = await fixture(), options = { ...f.options, review: f.review, pauseAfterCheck: true };
    const first = await startWorkflow(options);
    await expect(resumeWorkflow({ ...options, id: first.id, command: [process.execPath, "-e", "process.exit(0)"] })).rejects.toMatchObject({ code: "stale" });
    await expect(resumeWorkflow({ ...options, id: first.id, configurationIdentity: "b".repeat(64) })).rejects.toMatchObject({ code: "stale" });
    process.env.SYS1_WORKFLOW_TEST_INPUT = "changed";
    try { await expect(resumeWorkflow({ ...options, id: first.id })).rejects.toMatchObject({ code: "stale" }); }
    finally { delete process.env.SYS1_WORKFLOW_TEST_INPUT; }
    await writeFile(join(f.cwd, "code.ts"), "export const changed = 3;\n");
    await expect(resumeWorkflow({ ...options, id: first.id })).rejects.toMatchObject({ code: "stale" });
    expect(await readFile(f.counter, "utf8")).toBe("x"); expect(f.calls()).toBe(0);
  }, TIMEOUT);

  test("shell bookkeeping and Git stat cache changes do not invalidate source", async () => {
    const f = await fixture();
    const first = await startWorkflow({ ...f.options, command: ["git", "status", "--short"] });
    expect(first).toMatchObject({ status: "complete", check: { bindingStatus: "unchanged" } });
    const saved = { SHLVL: process.env.SHLVL, TERM_SESSION_ID: process.env.TERM_SESSION_ID, PWD: process.env.PWD };
    Object.assign(process.env, { SHLVL: "99", TERM_SESSION_ID: "another-shell", PWD: "/some/previous/path" });
    try { expect(await resumeWorkflow({ ...f.options, id: first.id, command: ["git", "status", "--short"] })).toMatchObject({ status: "complete", reused: true }); }
    finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  }, TIMEOUT);

  test("a successful check that changes source is stale and never reviews", async () => {
    const f = await fixture();
    const report = await startWorkflow({ ...f.options, review: f.review, command: [process.execPath, "-e", "require('node:fs').writeFileSync('new.ts', 'export const changed = true;')"] });
    expect(report).toMatchObject({ status: "stale", exitCode: 2, check: { status: "passed", exitCode: 0, bindingStatus: "changed" }, review: null });
    expect(f.calls()).toBe(0);
  }, TIMEOUT);

  test("a temporary rule change cannot send or complete an unbound review", async () => {
    const f = await fixture(); let reads = 0;
    const original = ruleset(), changed = ruleset("PRIVATE_TEMPORARY_RULE_SENTINEL");
    const review = { ...f.review, loadRules: async () => {
      // Initial binding and the three command/review binding checks see the
      // original rules. Only checkpoint collection and its own final check
      // see changed rules; the workflow's final binding sees the original again.
      reads++;
      return reads === 5 || reads === 6 ? changed : original;
    } };
    const report = await startWorkflow({ ...f.options, review });
    expect(f.calls()).toBe(0);
    expect(report).toMatchObject({ status: "stale", exitCode: 2,
      check: { status: "passed", bindingStatus: "unchanged" },
      review: { status: "stale", complete: false, requests: 0, findings: [] },
    });
    expect(await readFile(f.counter, "utf8")).toBe("x");
  }, TIMEOUT);

  test("a since revision resumes from its recorded commit identity", async () => {
    const f = await fixture(); await git(f.cwd, "add", "."); await git(f.cwd, "commit", "--quiet", "-m", "change");
    const options = { ...f.options, review: { ...f.review, mode: "since" as const, since: "HEAD~1" }, pauseAfterCheck: true };
    const first = await startWorkflow(options);
    expect(first.status).toBe("paused"); expect(first.intent.review?.since).toMatch(/^[a-f0-9]{40}$/);
    const result = await resumeWorkflow({ ...options, id: first.id, review: { ...options.review, since: first.intent.review!.since! } });
    expect(result).toMatchObject({ status: "complete", reused: true, review: { complete: true, requests: 1 } });
    expect(await readFile(f.counter, "utf8")).toBe("x");
  }, TIMEOUT);

  test("concurrent continuations execute the model stage only once", async () => {
    const f = await fixture(), options = { ...f.options, review: f.review, pauseAfterCheck: true };
    const first = await startWorkflow(options);
    const results = await Promise.allSettled([resumeWorkflow({ ...options, id: first.id }), resumeWorkflow({ ...options, id: first.id })]);
    expect(results.some(result => result.status === "fulfilled" && result.value.status === "complete")).toBe(true);
    expect(f.calls()).toBe(1); expect(await readFile(f.counter, "utf8")).toBe("x");
  }, TIMEOUT);

  test("external ALGAL-shaped exceptions cannot put private text into history", async () => {
    const f = await fixture(); let reads = 0;
    const review = { ...f.review, loadRules: async () => {
      if (++reads === 2) throw new AlgalError("TOOL_FAILED", "PRIVATE_EXCEPTION_SENTINEL", { untrusted: "PRIVATE_EXCEPTION_SENTINEL" });
      return ruleset();
    } };
    const report = await startWorkflow({ ...f.options, review });
    expect(report.status).toBe("failed"); expect(f.calls()).toBe(0);
    const metadata = Buffer.concat(await Promise.all((await files(join(f.home, "workflows", "engine"))).map(path => readFile(path)))).toString("utf8");
    expect(metadata).not.toContain("PRIVATE_EXCEPTION_SENTINEL");
  }, TIMEOUT);

  test("internal symlink content is bound while external links refuse execution", async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, ".git", "info", "exclude"), "private-target.ts\n");
    await writeFile(join(f.cwd, "private-target.ts"), "target v1"); await symlink("private-target.ts", join(f.cwd, "linked.ts"));
    const first = await startWorkflow(f.options); expect(first.status).toBe("complete");
    await writeFile(join(f.cwd, "private-target.ts"), "target v2");
    await expect(resumeWorkflow({ ...f.options, id: first.id })).rejects.toMatchObject({ code: "stale" });
    await writeFile(join(f.root, "external.ts"), "external"); await symlink(join(f.root, "external.ts"), join(f.cwd, "external.ts"));
    await expect(startWorkflow(f.options)).rejects.toMatchObject({ code: "unsupported_source" });
    expect(await readFile(f.counter, "utf8")).toBe("x");
  }, TIMEOUT);

  test("unknown paid-call outcomes remain uncertain and cannot be repeated", async () => {
    const f = await fixture(); let calls = 0;
    const decider: Sys1Client = { async evaluate() { calls++; const error = new Sys1ClientError("transport_error"); error.message = "PRIVATE_TRANSPORT_SENTINEL"; throw error; } };
    const options = { ...f.options, review: { ...f.review, decider } };
    const report = await startWorkflow(options);
    expect(report).toMatchObject({ status: "uncertain", exitCode: 2 });
    await expect(resumeWorkflow({ ...options, id: report.id })).rejects.toMatchObject({ code: "uncertain" });
    expect(calls).toBe(1);
    expect(await Bun.file(workflowLogPath(f.home, report.intent.logId)).exists()).toBe(true);
    const metadata = Buffer.concat(await Promise.all((await files(join(f.home, "workflows", "engine"))).map(path => readFile(path)))).toString("utf8");
    expect(metadata).not.toContain("PRIVATE_TRANSPORT_SENTINEL");
  }, TIMEOUT);

  test("expired checks and modified evidence fail closed without rerunning", async () => {
    const f = await fixture(), report = await startWorkflow(f.options);
    const now = Date.now;
    Date.now = () => now() + WORKFLOW_LIMITS.maxReuseAgeMs + 1_000;
    try { await expect(resumeWorkflow({ ...f.options, id: report.id })).rejects.toMatchObject({ code: "expired" }); }
    finally { Date.now = now; }
    const evidence = (await files(join(f.home, "workflows", "engine"))).find(path => path.includes("/runs/") && path.endsWith(".json"));
    expect(evidence).toBeDefined();
    await writeFile(evidence!, "{}");
    await expect(verifyWorkflow({ home: f.home, id: report.id })).rejects.toMatchObject({ code: "workflow_failed" });
    expect(await readFile(f.counter, "utf8")).toBe("x");
  }, TIMEOUT);

  test("symlink stores fail before command execution", async () => {
    const f = await fixture(); await mkdir(f.home); await mkdir(join(f.root, "elsewhere"));
    await symlink(join(f.root, "elsewhere"), join(f.home, "workflows"));
    await expect(startWorkflow(f.options)).rejects.toMatchObject({ code: "unsafe_store" });
    expect(await Bun.file(f.counter).exists()).toBe(false);
  }, TIMEOUT);

  test("a killed owner leaves uncertain intent and an inspectable log", async () => {
    const f = await fixture();
    const command = [process.execPath, "-e", "process.stdout.write('CRASH_LOG'); if(process.ppid === Number(process.env.SYS1_FIXTURE_OWNER)) process.kill(process.ppid, 'SIGKILL');"];
    const helper = join(f.root, "crash.ts");
    await writeFile(helper, `import { startWorkflow } from ${JSON.stringify(fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)))};\nprocess.env.SYS1_FIXTURE_OWNER = String(process.pid);\nawait startWorkflow(${JSON.stringify({ ...f.options, command })});\n`);
    const child = Bun.spawn([process.execPath, helper], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    const reports = await listWorkflows(f);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "uncertain", exitCode: 2 });
    const report = await inspectWorkflow({ home: f.home, id: reports[0]!.id });
    expect(await Bun.file(workflowLogPath(f.home, report.intent.logId)).exists()).toBe(true);
    await expect(resumeWorkflow({ ...f.options, command, id: report.id })).rejects.toMatchObject({ code: "uncertain" });
  }, TIMEOUT);
});
