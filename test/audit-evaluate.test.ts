import { describe, expect, test } from "bun:test";
import { evaluateAudit, violationScore } from "../src/audit/evaluate.ts";
import { ruleSchema } from "../src/audit/schema.ts";
import type { LoadedPack, LoadedRule, RuleSet } from "../src/audit/pack.ts";
import type { DiffCollection, DiffUnit } from "../src/audit/diff.ts";
import type { Sys1Client } from "../src/client.ts";
import { renderAudit } from "../src/audit/cli.ts";

const rule = ruleSchema.parse({ id: "catch-observable", applies: { paths: ["**/*.ts"] }, ensure: "Errors stay observable.", breaks: "The added catch ignores the error." });
const pack = { name: "checks", rules: [rule] } as unknown as LoadedPack;
const loaded = { id: rule.id, rule, revision: "a".repeat(64), pack } as LoadedRule;
const rules: RuleSet = { packs: [pack], rules: [loaded], get: (id) => id === rule.id ? loaded : undefined, pack: () => pack };
function unit(path = "src/code.ts"): DiffUnit {
  return { id: "evidence", path, language: "typescript", kind: "modified", oldRange: { start: 10, count: 4 }, newRange: { start: 10, count: 4 }, patch: "-catch(e) { throw e; }\n+catch(e) {}", state: "PRIVATE_SOURCE_SENTINEL" };
}
function diff(units = [unit()]): DiffCollection {
  return { repoRoot: "/repo-a", mode: "worktree", base: "a".repeat(40), head: "a".repeat(40), units, skipped: [], changedFiles: new Set(units.map((entry) => entry.path)).size, complete: true };
}
function decider(noul = 0.01): Sys1Client {
  return { async evaluate(request) { return { response: { model: "model-v1", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul }])), usage: { input_tokens: 30, output_tokens: 2 } }, metadata: { backend: "fake", attempts: 1 } }; } };
}
const route = "fake/model-v1";

describe("advisory audit", () => {
  test("candidate output has precise identity, score, coverage, and no source", async () => {
    const report = await evaluateAudit({ diff: diff(), rules, route, decider: decider() });
    expect(report).toMatchObject({ complete: true, status: "complete", advisory: true, qualification: "unqualified", requests: 1, evaluated_units: 1, usage: { input_tokens: 30, output_tokens: 2 } });
    expect(report.findings[0]).toMatchObject({ rule: rule.id, line: 10, side: "after", model_score: 0.99, qualification: "unqualified" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SOURCE_SENTINEL");
    expect(JSON.stringify(report)).not.toContain("/repo-a");
    const other = await evaluateAudit({ diff: { ...diff(), repoRoot: "/repo-b" }, rules, route, decider: decider() });
    expect(other.findings[0]!.id).not.toBe(report.findings[0]!.id);
  });

  test("deletion findings point to before lines", async () => {
    const deleted = { ...unit(), kind: "deleted" as const, newRange: { start: 0, count: 0 } };
    const report = await evaluateAudit({ diff: diff([deleted]), rules, route, decider: decider() });
    expect(report.findings[0]).toMatchObject({ side: "before", line: 10 });
  });

  test("preview performs no evaluation and exposes affected paths", async () => {
    let calls = 0;
    const report = await evaluateAudit({ diff: diff(), rules, route, dryRun: true, decider: { evaluate() { calls++; throw new Error("must not call"); } } });
    expect(calls).toBe(0);
    expect(report).toMatchObject({ status: "planned", complete: false, planned_requests: 1, requests: 0, targets: [{ path: "src/code.ts", units: 1 }] });
  });

  test("request cap accounts for every skipped unit", async () => {
    const report = await evaluateAudit({ diff: diff([unit("a.ts"), unit("b.ts"), unit("c.ts")]), rules, route, decider: decider(), maxRequests: 1 });
    expect(report).toMatchObject({ complete: false, status: "incomplete", requests: 1, evaluated_units: 1 });
    expect(report.skipped).toEqual([{ path: "b.ts", reason: "request_limit" }, { path: "c.ts", reason: "request_limit" }]);
  });

  test("no applicable rules is incomplete coverage, not a clean audit", async () => {
    const report = await evaluateAudit({ diff: diff([unit("readme.md")]), rules, route, decider: decider() });
    expect(report).toMatchObject({ complete: false, status: "incomplete", requests: 0, skipped: [{ path: "readme.md", reason: "no_matching_rules" }] });
  });

  test("backend errors are private and stop additional spend", async () => {
    const report = await evaluateAudit({ diff: diff([unit("a.ts"), unit("b.ts")]), rules, route, decider: { async evaluate() { throw new Error("PRIVATE_PROVIDER_RESPONSE"); } } });
    expect(report).toMatchObject({ complete: false, requests: 1, evaluated_units: 0 });
    expect(report.usage).toMatchObject({ known_requests: 0, unknown_requests: 1 });
    expect(report.skipped).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PROVIDER_RESPONSE");
  });

  test("cancellation before the next chunk prevents another request within the same unit", async () => {
    const many = Array.from({ length: 65 }, (_, index) => ({ ...loaded, id: `rule-${index}`, rule: { ...rule, id: `rule-${index}` } }));
    const manyRules: RuleSet = { ...rules, rules: many, get: (id) => many.find(item => item.id === id) };
    const controller = new AbortController();
    let calls = 0;
    const backend = decider();
    const report = await evaluateAudit({ diff: diff(), rules: manyRules, route, signal: controller.signal, decider: {
      async evaluate(request) {
        calls++;
        const result = await backend.evaluate(request);
        // Abort after the first response arrives and before the next chunk.
        Object.defineProperty(result.metadata, "backend", { get() { controller.abort(); return "fake"; } });
        return result;
      },
    } });
    expect(calls).toBe(1);
    expect(report).toMatchObject({ complete: false, requests: 1, planned_requests: 2, evaluated_units: 0 });
    expect(report.findings).toHaveLength(0);
    expect(report.skipped[0]?.reason).toBe("timeout_or_cancelled");
  });

  test("missing answers and a mismatched route fail closed", async () => {
    for (const variant of ["answer", "route", "model", "retry"] as const) {
      const real = decider();
      const invalid: Sys1Client = { async evaluate(request) {
        const response = await real.evaluate(request);
        if (variant === "answer") response.response.answers = {};
        if (variant === "route") response.metadata.backend = "other";
        if (variant === "model") response.response.model = "other";
        if (variant === "retry") response.metadata.attempts = 2;
        return response;
      } };
      const report = await evaluateAudit({ diff: diff(), rules, route, decider: invalid });
      expect(report.complete).toBe(false);
      expect(report.findings).toHaveLength(0);
    }
  });

  test("timeout bounds even a decider that ignores cancellation", async () => {
    const before = performance.now();
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    const report = await evaluateAudit({ diff: diff([unit("a.ts"), unit("b.ts")]), rules, route, timeoutMs: 20, decider: {
      evaluate(_request, options) {
        calls++;
        observedSignal = options?.signal;
        return new Promise(() => {});
      },
    } });
    expect(performance.now() - before).toBeLessThan(1000);
    expect(calls).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(report).toMatchObject({ complete: false, requests: 1, evaluated_units: 0, findings: [] });
    expect(report.skipped).toEqual([{ path: "a.ts", reason: "timeout_or_cancelled" }, { path: "b.ts", reason: "timeout_or_cancelled" }]);
  });

  test("no candidates never renders an all-clear claim", async () => {
    const report = await evaluateAudit({ diff: diff(), rules, route, decider: decider(0.99) });
    expect(report.findings).toHaveLength(0);
    expect(renderAudit(report)).toContain("does not establish");
  });

  test("rejects unpinned routes and invalid bounds before invoking the backend", async () => {
    for (const invalid of [{ route: "auto" }, { maxRequests: 0 }, { timeoutMs: Infinity }]) {
      await expect(evaluateAudit({ diff: diff(), rules, route, decider: decider(), ...invalid })).rejects.toThrow();
    }
  });

  test("choice and score select only the specified violation mass", () => {
    const choice = ruleSchema.parse({ id: "choice", applies: { paths: ["**/*"] }, type: "choice", ask: "Which?", options: { ok: "Valid", bad: "Invalid" }, violations: ["bad"] });
    expect(violationScore(choice, { type: "choice", choice: "ok", probabilities: { ok: 0.6, bad: 0.4 }, confidence: 0.6 })).toBe(0.4);
    const score = ruleSchema.parse({ id: "score", applies: { paths: ["**/*"] }, type: "score", ask: "How much?", levels: ["None", "Some", "Much"], violation_at: 2 });
    expect(violationScore(score, { type: "score", score: 1.3, legend: { "0": "None", "1": "Some", "2": "Much" }, probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 }, confidence: 0.5 })).toBe(0.5);
  });
});
