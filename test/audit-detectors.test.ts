import { describe, expect, test } from "bun:test";
import { detectNewEmptyCatch, maskSource } from "../src/audit/detectors.ts";
import { evaluateAudit } from "../src/audit/evaluate.ts";
import { ruleSchema } from "../src/audit/schema.ts";
import type { LoadedPack, LoadedRule, RuleSet } from "../src/audit/pack.ts";
import type { DiffCollection, DiffUnit } from "../src/audit/diff.ts";
import type { Sys1Client } from "../src/client.ts";

const hunk = (start: number, lines: string[]): string => `--- a/f.ts\n+++ b/f.ts\n@@ -${start} +${start} @@\n${lines.join("\n")}\n`;
const hits = (lines: string[], start = 1): number[] => detectNewEmptyCatch(hunk(start, lines)).map(hit => hit.line);

describe("empty-catch detector", () => {
  test("reports an added empty catch at its after line", () => {
    expect(hits([" try {", "   run();", "-} finally {}", "+} catch (e) {", "+}"], 20)).toEqual([22]);
  });

  test("reports a catch emptied by removing its statements", () => {
    expect(hits([" try {", "   run();", " } catch (e) {", "-  log(e);", "-  retry();", " }"])).toEqual([3]);
  });

  test("an explanatory comment excuses only a new catch", () => {
    expect(hits(["+try { run(); } catch { /* optional */ ; // later", "+}"])).toEqual([]);
    expect(hits(["+try { run(); } catch { ; }"])).toEqual([1]);
    expect(hits(["+try { run(); } catch { // eslint-disable-line no-empty", "+}"])).toEqual([1]);
    expect(hits([" try {", "   run();", " } catch (e) {", "-  log(e);", "+  // ignored", " }"])).toEqual([3]);
  });

  test("a moved explained catch is not paired with an unrelated rewritten one", () => {
    expect(hits([
      "-} catch (error) {",
      "-  report(error);",
      "-}",
      "+} catch (error) {",
      "+  try {",
      "+    notify();",
      "+  } catch { /* observers cannot retry */ }",
      "-try { notify(); } catch { /* observers cannot retry */ }",
      "+}",
    ])).toEqual([]);
  });

  test("ignores nonempty, unchanged, reformatted, and moved empty catches", () => {
    expect(hits(["+try { run(); } catch (e) { return; }"])).toEqual([]);
    expect(hits([" try { run(); } catch (e) {}", "+next();"])).toEqual([]);
    expect(hits(["-try { run(); } catch (e) {}", "+try { run(); } catch (e) {", "+}"])).toEqual([]);
    expect(hits(["-try { a(); } catch {}", " keep();", "+try { a(); } catch {}"])).toEqual([]);
  });

  test("ignores Promise.catch, catch text in strings and comments, and incomplete bodies", () => {
    expect(hits(["+promise.catch(() => {});"])).toEqual([]);
    expect(hits(["+const text = '} catch (e) {}';", "+// } catch {}"])).toEqual([]);
    expect(hits(["+try { run(); } catch (e) {", "+  // body continues past the hunk"])).toEqual([]);
  });

  test("masking keeps offsets and newlines", () => {
    const source = "a('x}') // y\n/* z */ b(/}/g)";
    const masked = maskSource(source);
    expect(masked.length).toBe(source.length);
    expect(masked.split("\n").length).toBe(2);
    expect(masked).not.toContain("}");
  });
});

describe("detector rules in the audit", () => {
  const detected = ruleSchema.parse({ id: "empty-catch", applies: { paths: ["**/*.ts"] }, ensure: "No new empty catch.", breaks: "A new empty catch.", detector: "empty-catch" });
  const asked = ruleSchema.parse({ id: "asked", applies: { paths: ["**/*.ts"] }, ensure: "Fine.", breaks: "Not fine." });
  const pack = { name: "checks", rules: [detected, asked] } as unknown as LoadedPack;
  const load = (rule: typeof detected): LoadedRule => ({ id: rule.id, rule, revision: "a".repeat(64), pack }) as LoadedRule;
  const set = (list: LoadedRule[]): RuleSet => ({ packs: [pack], rules: list, get: (id) => list.find(item => item.id === id), pack: () => pack });
  const unit: DiffUnit = { id: "u", path: "src/a.ts", language: "typescript", kind: "modified", oldRange: { start: 5, count: 1 }, newRange: { start: 5, count: 1 }, patch: hunk(5, ["+try { run(); } catch {}"]), state: "{}" };
  const diff: DiffCollection = { repoRoot: "/r", mode: "worktree", base: "a".repeat(40), head: "a".repeat(40), units: [unit], skipped: [], changedFiles: 1, complete: true };
  const route = "fake/model-v1";

  test("a detector-only rule set needs no model request", async () => {
    const decider: Sys1Client = { async evaluate() { throw new Error("must not be called"); } };
    const report = await evaluateAudit({ diff, rules: set([load(detected)]), route, decider });
    expect(report).toMatchObject({ status: "complete", requests: 0, evaluated_units: 1 });
    expect(report.findings).toEqual([expect.objectContaining({ rule: "empty-catch", line: 5, model_score: 1, tier: "high" })]);
  });

  test("the model is asked only the other rules", async () => {
    const seen: string[][] = [];
    const decider: Sys1Client = { async evaluate(request) {
      seen.push(Object.keys(request.questions));
      return { response: { model: "model-v1", answers: { asked: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 1, output_tokens: 1 } }, metadata: { backend: "fake", attempts: 1 } };
    } };
    const report = await evaluateAudit({ diff, rules: set([load(detected), load(asked)]), route, decider });
    expect(seen).toEqual([["asked"]]);
    expect(report).toMatchObject({ status: "complete", evaluated_units: 1 });
    expect(report.findings.map(item => item.rule)).toEqual(["empty-catch"]);
  });
});
