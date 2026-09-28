import { describe, expect, test } from "bun:test";
import type { LoadedPack, LoadedRule, RuleSet } from "../src/audit/pack.ts";
import { PACK_LIMITS, ruleRevision, ruleSchema } from "../src/audit/schema.ts";
import { RuleSelectionError, selectRules } from "../src/audit/select.ts";

function fixture(): RuleSet {
  const definitions = ["z-rule", "a-rule"].map(id => ruleSchema.parse({
    id, applies: { paths: ["**/*.ts"] }, ensure: "Required work completes.", breaks: "Required work fails.",
  }));
  const pack = { name: "repo", rules: definitions } as unknown as LoadedPack;
  const rules: readonly LoadedRule[] = Object.freeze(definitions.map(rule => ({
    id: rule.id, rule, revision: ruleRevision(rule), pack, overrides: [{ pack: "builtin", layer: "builtin" as const, revision: "old" }],
  })));
  return { rules, packs: [pack], get: id => rules.find(rule => rule.id === id), pack: name => name === pack.name ? pack : undefined };
}

describe("active rule selection", () => {
  test("omission preserves all rules; a subset keeps the winning definition without mutation", () => {
    const loaded = fixture();
    expect(selectRules(loaded)).toBe(loaded);
    const selected = selectRules(loaded, ["a-rule"]);
    expect(selected.rules).toEqual([loaded.get("a-rule")!]);
    expect(selected.get("a-rule")).toBe(loaded.get("a-rule"));
    expect(selected.get("z-rule")).toBeUndefined();
    expect(selected.get("toString")).toBeUndefined();
    expect(selected.pack("repo")).toBe(loaded.pack("repo"));
    expect(loaded.rules).toHaveLength(2);
    expect(loaded.get("z-rule")).toBeDefined();
  });

  test("flag order and repeated IDs preserve the loaded order and do not duplicate questions", () => {
    const loaded = fixture();
    expect(selectRules(loaded, ["a-rule", "z-rule", "a-rule"]).rules).toEqual(loaded.rules);
    expect(selectRules(loaded, ["z-rule", "a-rule"]).rules).toEqual(loaded.rules);
  });

  test("empty, malformed, unknown, and excessive selections fail without widening", () => {
    const loaded = fixture();
    for (const ids of [[], [""], ["A-rule"], ["a_rule"], ["a-rule,z-rule"], ["a".repeat(65)], ["missing"],
      ["a-rule", "missing"], Array(PACK_LIMITS.maxMergedRules + 1).fill("a-rule")]) {
      expect(() => selectRules(loaded, ids)).toThrow(RuleSelectionError);
      expect(loaded.rules).toHaveLength(2);
    }
  });
});
