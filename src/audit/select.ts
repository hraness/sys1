import type { RuleSet } from "./pack.ts";
import { PACK_LIMITS, ruleIdSchema } from "./schema.ts";

export class RuleSelectionError extends Error {}

/** Resolve exact active IDs without changing their winning definitions or order. */
export function selectRules(loaded: RuleSet, ids?: readonly string[]): RuleSet {
  if (ids === undefined) return loaded;
  if (ids.length === 0 || ids.length > PACK_LIMITS.maxMergedRules) {
    throw new RuleSelectionError(`Select between 1 and ${PACK_LIMITS.maxMergedRules} rule IDs`);
  }
  const selected = new Set<string>();
  for (const id of ids) {
    if (!ruleIdSchema.safeParse(id).success) throw new RuleSelectionError("--rule needs a valid rule ID from sys1 rules list");
    if (loaded.get(id) === undefined) throw new RuleSelectionError(`Unknown active rule ${id}; run sys1 rules list`);
    selected.add(id);
  }
  // Preserve pack order, independent of CLI order or duplicate selections.
  const rules = loaded.rules.filter(rule => selected.has(rule.id));
  const byId = new Map(rules.map(rule => [rule.id, rule]));
  return { packs: loaded.packs, rules, get: id => byId.get(id), pack: name => loaded.pack(name) };
}
