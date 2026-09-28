import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointReview, feedbackReview, listReviewIssues, recheckReview, REVIEW_RECEIPT_TTL_MS, type ReviewCheckpointOptions } from "../src/review/checkpoint.ts";
import { mutateReviewState, readReviewState, reviewStatePath } from "../src/review/state.ts";
import { ruleRevision, ruleSchema } from "../src/audit/schema.ts";
import type { LoadedPack, LoadedRule, RuleSet } from "../src/audit/pack.ts";
import { selectRules } from "../src/audit/select.ts";
import type { Sys1Client } from "../src/client.ts";

// These integration workflows create real repositories and collect multiple
// Git snapshots. Allow shared-runner process/IO overhead without changing
// product deadlines or treating Bun's default five seconds as a latency claim.
const GIT_WORKFLOW_TIMEOUT_MS = 20_000;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function ruleset(wording = "The changed code keeps errors visible.", id = "errors-visible"): RuleSet {
  const rule = ruleSchema.parse({ id, applies: { paths: ["**/*.ts"] }, ensure: wording, breaks: "The changed code hides errors." });
  const pack = { name: "test", rules: [rule] } as unknown as LoadedPack;
  const loaded = { id: rule.id, rule, revision: ruleRevision(rule), pack, overrides: [] } satisfies LoadedRule;
  return { rules: [loaded], packs: [pack], get: id => id === rule.id ? loaded : undefined, pack: () => pack };
}
const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(["git", "-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
};
async function fixture(repoName = "repo") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sys1-review-checkpoint-")); roots.push(root);
  const cwd = join(root, repoName); const home = join(root, "home"); await mkdir(cwd);
  await git(cwd, "init", "--quiet");
  await writeFile(join(cwd, "code.ts"), "export const before = 1;\n");
  await git(cwd, "add", "."); await git(cwd, "commit", "--quiet", "-m", "base");
  await writeFile(join(cwd, "code.ts"), "export const SOURCE_SENTINEL = 2;\n");
  let calls = 0;
  const decider: Sys1Client = { async evaluate(request) {
    calls++;
    return { response: { model: request.model!.split("/")[1]!, answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.01 }])), usage: { input_tokens: 5, output_tokens: 1 } }, metadata: { backend: request.model!.split("/")[0]!, attempts: 1 } };
  } };
  const options: ReviewCheckpointOptions = { home, cwd, mode: "worktree", route: "fake/model", decider, loadRules: async () => ruleset() };
  return { root, cwd, home, options, decider, calls: () => calls };
}

describe("agent review checkpoint", () => {
  test("preview creates no state; exact repeated checkpoint avoids model calls", async () => {
    const f = await fixture();
    const preview = await checkpointReview({ ...f.options, dryRun: true });
    expect(preview).toMatchObject({ status: "planned", requests: 0, audit: { planned_requests: 1 } });
    await expect(lstat(f.home)).rejects.toMatchObject({ code: "ENOENT" });
    const first = await checkpointReview(f.options);
    expect(first).toMatchObject({ status: "complete", requests: 1, suppressed_count: 0 });
    expect(first.findings).toHaveLength(1);
    const second = await checkpointReview(f.options);
    expect(second).toMatchObject({ status: "unchanged", requests: 0, findings: [], suppressed_count: 1, receipt_ttl_ms: REVIEW_RECEIPT_TTL_MS });
    expect(second.checked_at).toBe(first.checked_at);
    expect(f.calls()).toBe(1);
    expect((await readFile(reviewStatePath(f.home, f.cwd))).includes(Buffer.from("SOURCE_SENTINEL"))).toBe(false);
    const issue = (await listReviewIssues(f.options)).issues[0]!;
    expect(issue).not.toHaveProperty("model_score"); expect(issue).not.toHaveProperty("summary");
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("unrelated edit rechecks snapshot but suppresses existing unchanged findings", async () => {
    const f = await fixture();
    const first = await checkpointReview(f.options);
    await writeFile(join(f.cwd, "other.ts"), "export const other = 3;\n");
    const next = await checkpointReview(f.options);
    expect(next).toMatchObject({ status: "complete", requests: 2, suppressed_count: 1 });
    expect(next.findings).toHaveLength(1);
    expect(next.findings[0]!.id).not.toBe(first.findings[0]!.id);
    expect(next.audit!.findings).toEqual(next.findings);
    expect((await listReviewIssues(f.options)).issues).toHaveLength(2);
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("a cached snapshot becoming stale during rule loading is never returned as unchanged", async () => {
    for (const change of ["source", "rule"] as const) {
      const f = await fixture(); await checkpointReview(f.options);
      let loads = 0;
      const cached = await checkpointReview({ ...f.options, loadRules: async () => {
        loads++;
        if (change === "source" && loads === 1) await writeFile(join(f.cwd, "code.ts"), "export const changedDuringRead = 3;\n");
        return change === "rule" && loads > 1 ? ruleset("A revised condition.") : ruleset();
      } });
      expect(cached).toMatchObject({ status: "stale", complete: false, requests: 0, findings: [] });
      expect(f.calls()).toBe(1);
      expect((await readReviewState(f.home, f.cwd)).generation).toBe(1);
    }
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("absolute temporary aliases have the same selection and recheck identity", async () => {
    if (process.platform !== "darwin") return;
    const f = await fixture();
    const alias = join(f.cwd, "code.ts").replace(/^\/private\/(var|tmp)\//, "/$1/");
    expect(alias).not.toBe(join(f.cwd, "code.ts"));
    const first = await checkpointReview({ ...f.options, paths: [alias] });
    expect(first.status).toBe("complete");
    expect(await checkpointReview({ ...f.options, paths: ["code.ts"] })).toMatchObject({ status: "unchanged", requests: 0 });
    expect(await recheckReview({ ...f.options, id: first.findings[0]!.id })).toMatchObject({ status: "reported" });
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("a worktree with a trailing space keeps one canonical identity", async () => {
    if (process.platform === "win32") return; // Windows normalizes trailing spaces in ordinary paths.
    const f = await fixture("repo ");
    const first = await checkpointReview(f.options);
    const id = first.findings[0]!.id;
    expect((await listReviewIssues(f.options)).issues[0]!.id).toBe(id);
    expect((await feedbackReview({ ...f.options, id, feedback: "useful" })).issue.feedback).toBe("useful");
    expect(await recheckReview({ ...f.options, id })).toMatchObject({ status: "reported" });
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("source, route and rule revisions invalidate receipts and finding identities", async () => {
    const f = await fixture();
    const first = await checkpointReview(f.options);
    const route = await checkpointReview({ ...f.options, route: "fake/other" });
    const rules = await checkpointReview({ ...f.options, loadRules: async () => ruleset("Errors are reported by changed code.") });
    await writeFile(join(f.cwd, "code.ts"), "export const SOURCE_SENTINEL = 3;\n");
    const source = await checkpointReview(f.options);
    expect(new Set([first, route, rules, source].map(item => item.snapshot)).size).toBe(4);
    expect(new Set([first, route, rules, source].map(item => item.findings[0]!.id)).size).toBe(4);
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("selected rules govern receipt identity and recheck retains the finding's original rule", async () => {
    const f = await fixture();
    let firstWording = "The first condition holds.";
    let secondWording = "The second condition holds.";
    const loadRules = (ids?: readonly string[]) => async (): Promise<RuleSet> => {
      const entries = [...ruleset(firstWording, "first-rule").rules, ...ruleset(secondWording, "second-rule").rules];
      return selectRules({ rules: entries, packs: entries.map(rule => rule.pack), get: id => entries.find(rule => rule.id === id), pack: () => entries[0]!.pack }, ids);
    };
    const questions: string[][] = [];
    const decider: Sys1Client = { evaluate(request, options) {
      questions.push(Object.keys(request.questions));
      return f.decider.evaluate(request, options);
    } };
    const base = { ...f.options, decider };
    const selected = { ...base, loadRules: loadRules(["first-rule"]) };
    const first = await checkpointReview(selected);
    expect(first.status).toBe("complete");
    expect(questions).toEqual([["first-rule"]]);
    const all = await checkpointReview({ ...base, loadRules: loadRules() });
    expect(all.status).toBe("complete");
    expect(all.snapshot).not.toBe(first.snapshot);
    expect(questions[1]).toEqual(["first-rule", "second-rule"]);
    expect(await checkpointReview(selected)).toMatchObject({ status: "unchanged", snapshot: first.snapshot, requests: 0 });
    expect(await checkpointReview({ ...base, loadRules: loadRules(["second-rule", "first-rule", "second-rule"]) })).toMatchObject({ status: "unchanged", snapshot: all.snapshot, requests: 0 });
    expect(f.calls()).toBe(2);

    secondWording = "The unselected condition has changed.";
    expect(await checkpointReview(selected)).toMatchObject({ status: "unchanged", snapshot: first.snapshot, requests: 0 });
    const id = first.findings[0]!.id;
    expect(await recheckReview({ ...base, loadRules: loadRules(), id })).toMatchObject({ status: "reported" });
    expect(questions[2]).toEqual(["first-rule"]);
    expect(f.calls()).toBe(3);

    firstWording = "The selected condition has changed.";
    expect(await recheckReview({ ...base, loadRules: loadRules(), id })).toMatchObject({ status: "superseded", reason: "rule_changed" });
    expect(f.calls()).toBe(3);
    const revised = await checkpointReview(selected);
    expect(revised.status).toBe("complete");
    expect(revised.snapshot).not.toBe(first.snapshot);
    expect(f.calls()).toBe(4);
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("expired receipts trigger a fresh evaluation without repeating unchanged findings", async () => {
    const f = await fixture(); await checkpointReview(f.options);
    await mutateReviewState(f.home, f.cwd, state => { state.receipts[0]!.created_at = Date.now() - REVIEW_RECEIPT_TTL_MS - 1; });
    const refreshed = await checkpointReview(f.options);
    expect(refreshed).toMatchObject({ status: "complete", requests: 1, findings: [], suppressed_count: 1 });
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("partial results are retryable and failed/cancelled calls never become a receipt", async () => {
    const f = await fixture(); await writeFile(join(f.cwd, "other.ts"), "export const other = 3;\n");
    const partial = await checkpointReview({ ...f.options, maxRequests: 1 });
    expect(partial).toMatchObject({ status: "incomplete", complete: false, requests: 1 });
    expect((await readReviewState(f.home, f.cwd)).receipts).toHaveLength(0);
    const retried = await checkpointReview(f.options);
    expect(retried).toMatchObject({ status: "complete", requests: 2, suppressed_count: 1 });
    const failing = await fixture();
    const failure = await checkpointReview({ ...failing.options, decider: { async evaluate() { throw new Error("ANSWER_SENTINEL"); } } });
    expect(failure).toMatchObject({ status: "incomplete", requests: 1, findings: [] });
    expect((await readReviewState(failing.home, failing.cwd)).receipts).toHaveLength(0);
    expect((await readFile(reviewStatePath(failing.home, failing.cwd))).includes(Buffer.from("ANSWER_SENTINEL"))).toBe(false);
    const cancelled = new AbortController(); cancelled.abort();
    expect(await checkpointReview({ ...failing.options, signal: cancelled.signal })).toMatchObject({ status: "incomplete", requests: 0 });
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("midflight source or rule changes report stale and persist nothing", async () => {
    for (const change of ["source", "rule"] as const) {
      const f = await fixture(); let current = ruleset();
      const stale = await checkpointReview({ ...f.options, loadRules: async () => current, decider: { async evaluate(request, options) {
        const answer = await f.decider.evaluate(request, options);
        if (change === "source") await writeFile(join(f.cwd, "code.ts"), "export const later = 4;\n");
        else current = ruleset("A newly revised criterion.");
        return answer;
      } } });
      expect(stale).toMatchObject({ status: "stale", complete: false, findings: [], audit: { findings: [] } });
      await expect(lstat(f.home)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("overlapping checkpoints report each finding once and retain concurrent feedback", async () => {
    const f = await fixture();
    let entered = 0; let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const concurrent = { ...f.options, decider: { async evaluate(request: Parameters<Sys1Client["evaluate"]>[0]) {
      entered++; if (entered === 2) release(); await ready; return f.decider.evaluate(request);
    } } };
    const results = await Promise.all([checkpointReview(concurrent), checkpointReview(concurrent)]);
    expect(results.reduce((sum, item) => sum + item.findings.length, 0)).toBe(1);
    const issue = (await listReviewIssues(f.options)).issues[0]!;
    await feedbackReview({ ...f.options, id: issue.id, feedback: "useful" });
    expect((await listReviewIssues(f.options)).issues).toHaveLength(1);
    expect((await listReviewIssues(f.options)).issues[0]!.feedback).toBe("useful");
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("recheck always evaluates exact evidence and never claims a missing or changed hunk fixed", async () => {
    const f = await fixture(); const first = await checkpointReview(f.options); const id = first.findings[0]!.id;
    await feedbackReview({ ...f.options, id, feedback: "incorrect" });
    expect(await recheckReview({ ...f.options, id })).toMatchObject({ status: "reported", audit: { requests: 1 } });
    expect(await recheckReview({ ...f.options, id, dryRun: true })).toMatchObject({ status: "planned", audit: { requests: 0 } });
    expect(await recheckReview({ ...f.options, id, route: "fake/other" })).toMatchObject({ status: "unavailable", reason: "route_changed" });
    expect(await recheckReview({ ...f.options, id, loadRules: async () => ruleset("A revised rule.") })).toMatchObject({ status: "superseded", reason: "rule_changed" });
    await writeFile(join(f.cwd, "code.ts"), "export const before = 1;\n");
    expect(await recheckReview({ ...f.options, id })).toMatchObject({ status: "superseded", reason: "evidence_changed", audit: null });
    expect((await listReviewIssues(f.options)).issues[0]!.feedback).toBe("incorrect");
    expect(f.calls()).toBe(2);
  }, GIT_WORKFLOW_TIMEOUT_MS);

  test("feedback rejects unknown identifiers and freeform judgments without creating state", async () => {
    const f = await fixture();
    await expect(feedbackReview({ ...f.options, id: "a".repeat(16), feedback: "useful" })).rejects.toThrow("not recorded");
    await expect(feedbackReview({ ...f.options, id: "a".repeat(16), feedback: "PRIVATE_FEEDBACK" as "useful" })).rejects.toThrow("Choose");
    await expect(lstat(f.home)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
