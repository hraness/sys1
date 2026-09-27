import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { loadBenchmarkFixtures } from "../src/audit/benchmark.ts";
import { AUDIT_CONTEXT, compileUnit, ruleApplies } from "../src/audit/compile.ts";
import { loadPack } from "../src/audit/pack.ts";
import { systemOneRequestSchema } from "../src/protocol.ts";

const PACK = join(import.meta.dir, "..", "packs", "core");
const range = z.strictObject({ start: z.number().int().nonnegative(), count: z.number().int().nonnegative() });
const stateSchema = z.strictObject({
  path: z.string(), kind: z.enum(["added", "modified", "deleted"]), language: z.string(),
  oldRange: range, newRange: range, patch: z.string(),
});

describe("built-in audit corpus", () => {
  test("keeps the shipped checks narrow, advisory, and selected only for JS/TS paths", async () => {
    const pack = await loadPack(PACK, "builtin");
    expect(pack.rules.map(rule => rule.id)).toEqual(["core-new-empty-catch", "core-removed-test-assertions"]);
    for (const rule of pack.rules) {
      expect(rule.gate).toBe(false);
      expect(rule.unit).toBe("hunk");
      expect(ruleApplies(rule, { path: "test/read_test.py", language: "python" })).toBe(false);
      expect(ruleApplies(rule, { path: "docs/example.md", language: "typescript" })).toBe(false);
      expect(ruleApplies(rule, { path: "test/source.test.ts", language: "typescript" })).toBe(true);
      expect(ruleApplies(rule, { path: "__tests__/source.mjs", language: "javascript" })).toBe(true);
    }
    expect(ruleApplies(pack.rules[1]!, { path: "src/source.ts", language: "typescript" })).toBe(false);
  });

  for (const split of ["calibration", "heldout"] as const) {
    test(`${split} contains both labels and languages for each rule with valid diff evidence`, async () => {
      const pack = await loadPack(PACK, "builtin");
      const corpus = await loadBenchmarkFixtures(PACK, split);
      expect(corpus.fixtures).toHaveLength(40);
      for (const rule of pack.rules) {
        for (const label of ["clean", "violation"] as const) {
          const cases = corpus.fixtures.filter(fixture => fixture.rule === rule.id && fixture.label === label);
          expect(cases).toHaveLength(10);
          expect(new Set(cases.map(fixture => fixture.language))).toEqual(new Set(["javascript", "typescript"]));
        }
      }
      for (const fixture of corpus.fixtures) {
        const state = stateSchema.parse(JSON.parse(fixture.state) as unknown);
        expect(state.path).toBe(fixture.path);
        expect(fixture.language).toBe(state.language);
        const lines = state.patch.trimEnd().split("\n");
        expect(lines[0]).toStartWith("diff --git ");
        expect(lines[1]).toStartWith("--- ");
        expect(lines[2]).toStartWith("+++ ");
        const header = lines[3]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        expect(header).not.toBeNull();
        expect(state.oldRange).toEqual({ start: Number(header![1]), count: Number(header![2] ?? 1) });
        expect(state.newRange).toEqual({ start: Number(header![3]), count: Number(header![4] ?? 1) });
        const body = lines.slice(4);
        expect(body.every(line => /^[ +\-]/.test(line))).toBe(true);
        expect(body.filter(line => line.startsWith(" ") || line.startsWith("-")).length).toBe(state.oldRange.count);
        expect(body.filter(line => line.startsWith(" ") || line.startsWith("+")).length).toBe(state.newRange.count);
        const rules = pack.rules.filter(rule => ruleApplies(rule, fixture));
        expect(rules.some(rule => rule.id === fixture.rule)).toBe(true);
        const requests = compileUnit(rules, fixture.state);
        expect(requests).toHaveLength(1);
        expect(systemOneRequestSchema.safeParse(requests[0]).success).toBe(true);
        expect(requests[0]!.state).toBe(fixture.state);
        for (const question of Object.values(requests[0]!.questions)) {
          expect(question.instructions).toStartWith(AUDIT_CONTEXT);
        }
      }
    });

    test(`${split} includes deletions, incomplete evidence, and instruction-like source data`, async () => {
      const corpus = await loadBenchmarkFixtures(PACK, split);
      const states = corpus.fixtures.map(fixture => ({ fixture, state: stateSchema.parse(JSON.parse(fixture.state) as unknown) }));
      // Empty after-code must remain distinct from a newly emptied retained construct.
      expect(states.some(({ fixture, state }) => fixture.label === "clean" && state.kind === "deleted")).toBe(true);
      expect(states.some(({ fixture, state }) => fixture.label === "violation" && state.kind === "modified"
        && !state.patch.split("\n").slice(4).some(line => line.startsWith("+")))).toBe(true);
      for (const rule of ["core-new-empty-catch", "core-removed-test-assertions"]) {
        const cases = states.filter(({ fixture }) => fixture.rule === rule);
        expect(cases.some(({ fixture }) => fixture.label === "clean" && /incomplete|truncated|callback-end|partial/.test(fixture.id))).toBe(true);
        expect(cases.some(({ fixture, state }) => fixture.label === "violation" && /SYSTEM|<system>/.test(state.patch))).toBe(true);
      }
    });
  }
});
