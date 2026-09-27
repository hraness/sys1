import { createHash } from "node:crypto";
import { z } from "zod";
import { PROTOCOL_LIMITS } from "../protocol.ts";

/**
 * Rule pack grammar. Every schema is strict and parses foreign values from
 * `unknown`; unknown keys, missing sentences, and oversized text are rejected
 * rather than dropped or truncated.
 */

export const PACK_LIMITS = {
  maxPackFileBytes: 1_048_576,
  maxPacksPerLayer: 64,
  maxRulesPerPack: 256,
  maxMergedRules: 256,
  maxIdChars: 64,
  maxDescriptionChars: 1_024,
  maxGlobs: 32,
  maxGlobChars: 256,
  maxLanguages: 32,
  maxOverlaps: 32,
  maxOverlapChars: 128,
  maxSourceFileChars: 512,
  /** Node budget for copying parsed YAML, which also stops alias expansion bombs. */
  maxYamlNodes: 200_000,
} as const;

export const DEFAULT_TIERS = Object.freeze({ high: 0.85, medium: 0.6 });

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ruleIdSchema = z.string().min(1).max(PACK_LIMITS.maxIdChars)
  .regex(kebab, "must be a kebab-case identifier");
export const packNameSchema = z.string().min(1).max(PACK_LIMITS.maxIdChars)
  .regex(kebab, "must be a kebab-case identifier");
const revisionSchema = z.union([
  z.string().min(1).max(PACK_LIMITS.maxIdChars).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "must be a plain revision identifier"),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String),
]);

function sentence(maxBytes: number) {
  return z.string()
    .refine((value) => value.trim().length > 0, "must not be empty")
    .refine((value) => byteLength(value) <= maxBytes, `must be at most ${maxBytes} bytes`);
}
/** A criterion sentence (`ensure`, `breaks`, `true`, `false`, an option, a level). */
const criterionSentence = sentence(PROTOCOL_LIMITS.maxCriterionChars);
/**
 * Reserve space for the compiler's shared diff and untrusted-evidence instructions.
 */
const askSentence = sentence(PROTOCOL_LIMITS.maxInstructionsChars - 1_024);

/** Repository-relative glob: no absolute paths, backslashes, or `..` segments. */
const globSchema = z.string().min(1).max(PACK_LIMITS.maxGlobChars)
  .refine((value) => !value.startsWith("/") && !value.includes("\\"), "must be a repository-relative glob using /")
  .refine((value) => !value.split("/").includes(".."), "must not contain .. segments");
const languageSchema = z.string().min(1).max(PACK_LIMITS.maxIdChars)
  .regex(/^[a-z0-9][a-z0-9+#._-]*$/, "must be a lowercase language name");

export const appliesSchema = z.strictObject({
  paths: z.array(globSchema).min(1).max(PACK_LIMITS.maxGlobs),
  except: z.array(globSchema).max(PACK_LIMITS.maxGlobs).optional(),
  languages: z.array(languageSchema).min(1).max(PACK_LIMITS.maxLanguages).optional(),
});

const probability = z.number().min(0).max(1);
export const tiersSchema = z.strictObject({
  high: probability.refine((value) => value > 0, "must be above 0"),
  medium: probability.refine((value) => value > 0, "must be above 0"),
}).refine((tiers) => tiers.medium <= tiers.high, "medium must not exceed high");

const ruleTiersSchema = z.strictObject({
  high: probability.refine((value) => value > 0, "must be above 0").default(DEFAULT_TIERS.high),
  medium: probability.refine((value) => value > 0, "must be above 0").default(DEFAULT_TIERS.medium),
}).refine((tiers) => tiers.medium <= tiers.high, "medium must not exceed high");

const sourceSchema = z.strictObject({
  kind: z.enum(["builtin", "guide"]),
  file: z.string().min(1).max(PACK_LIMITS.maxSourceFileChars)
    .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
      "must be a repository-relative path using /")
    .optional(),
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

const optionKeySchema = z.string().min(1).max(PACK_LIMITS.maxIdChars)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a lowercase option key");

const commonFields = {
  id: ruleIdSchema,
  applies: appliesSchema,
  unit: z.literal("hunk").default("hunk"),
  tiers: ruleTiersSchema.default({ ...DEFAULT_TIERS }),
  /** Audit results are advisory. Execution gates are not supported. */
  gate: z.literal(false).default(false),
  severity: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  overlaps: z.array(z.string().min(1).max(PACK_LIMITS.maxOverlapChars)).max(PACK_LIMITS.maxOverlaps).optional(),
  source: sourceSchema.optional(),
};

/** Shorthand: the unit should satisfy `ensure`; `breaks` names what violates it. Violation = `false`. */
export const noulEnsureRuleSchema = z.strictObject({
  ...commonFields,
  type: z.literal("noul").default("noul"),
  ensure: criterionSentence,
  breaks: criterionSentence,
});

/** Longhand yes/no. As with `ensure`, a violation is a `false` answer. */
export const noulAskRuleSchema = z.strictObject({
  ...commonFields,
  type: z.literal("noul").default("noul"),
  ask: askSentence,
  true: criterionSentence,
  false: criterionSentence,
});

/** The model score is the summed probability of the `violations` options. */
export const choiceRuleSchema = z.strictObject({
  ...commonFields,
  type: z.literal("choice"),
  ask: askSentence,
  options: z.record(optionKeySchema, criterionSentence),
  violations: z.array(optionKeySchema).min(1),
}).superRefine((rule, ctx) => {
  const keys = Object.keys(rule.options);
  if (keys.length < 2 || keys.length > PROTOCOL_LIMITS.maxChoiceOptions) {
    ctx.addIssue({ code: "custom", path: ["options"], message: `needs 2..${PROTOCOL_LIMITS.maxChoiceOptions} options` });
  }
  const seen = new Set<string>();
  rule.violations.forEach((violation, index) => {
    if (!Object.hasOwn(rule.options, violation)) {
      ctx.addIssue({ code: "custom", path: ["violations", index], message: `names unknown option ${violation}` });
    }
    if (seen.has(violation)) {
      ctx.addIssue({ code: "custom", path: ["violations", index], message: `repeats option ${violation}` });
    }
    seen.add(violation);
  });
  if (keys.length > 0 && keys.every((key) => seen.has(key))) {
    ctx.addIssue({ code: "custom", path: ["violations"], message: "must leave at least one option that is not a violation" });
  }
});

/** The model score is the probability mass at level index >= `violation_at`. */
export const scoreRuleSchema = z.strictObject({
  ...commonFields,
  type: z.literal("score"),
  ask: askSentence,
  levels: z.array(criterionSentence).min(PROTOCOL_LIMITS.minScoreLevels).max(PROTOCOL_LIMITS.maxScoreLevels),
  violation_at: z.number().int().min(1),
}).superRefine((rule, ctx) => {
  if (rule.violation_at > rule.levels.length - 1) {
    ctx.addIssue({ code: "custom", path: ["violation_at"], message: "must be a level index below the number of levels" });
  }
});

export type NoulEnsureRule = z.output<typeof noulEnsureRuleSchema>;
export type NoulAskRule = z.output<typeof noulAskRuleSchema>;
export type ChoiceRule = z.output<typeof choiceRuleSchema>;
export type ScoreRule = z.output<typeof scoreRuleSchema>;
export type NoulRule = NoulEnsureRule | NoulAskRule;
export type Rule = NoulRule | ChoiceRule | ScoreRule;
export type RuleTiers = z.output<typeof tiersSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Dispatches to one strict form so errors name the real problem
 * ("ensure needs breaks") instead of a four-way union mismatch.
 */
export const ruleSchema: z.ZodType<Rule, unknown> = z.unknown().transform((value, ctx): Rule => {
  if (!isRecord(value)) {
    ctx.addIssue({ code: "custom", message: "rule must be a mapping" });
    return z.NEVER;
  }
  if ("when" in value) {
    ctx.addIssue({ code: "custom", path: ["when"], message: "when is not supported; audit rules are independent advisory questions" });
    return z.NEVER;
  }
  const type = value["type"] ?? "noul";
  let schema: z.ZodType<Rule, unknown>;
  if (type === "noul") {
    if ("ensure" in value && !("breaks" in value)) {
      ctx.addIssue({ code: "custom", path: ["breaks"], message: "a noul rule with ensure needs a breaks sentence naming what violates it" });
      return z.NEVER;
    }
    if ("breaks" in value && !("ensure" in value)) {
      ctx.addIssue({ code: "custom", path: ["ensure"], message: "breaks needs an ensure sentence" });
      return z.NEVER;
    }
    schema = "ensure" in value ? noulEnsureRuleSchema : noulAskRuleSchema;
  } else if (type === "choice") {
    schema = choiceRuleSchema;
  } else if (type === "score") {
    schema = scoreRuleSchema;
  } else {
    ctx.addIssue({ code: "custom", path: ["type"], message: "must be noul, choice, or score" });
    return z.NEVER;
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    return z.NEVER;
  }
  return result.data;
});

export const packFileSchema = z.strictObject({
  version: z.literal(1),
  pack: packNameSchema,
  revision: revisionSchema,
  description: z.string().min(1).max(PACK_LIMITS.maxDescriptionChars),
  rules: z.array(ruleSchema).min(1).max(PACK_LIMITS.maxRulesPerPack),
}).superRefine((pack, ctx) => {
  const seen = new Set<string>();
  pack.rules.forEach((rule, index) => {
    if (seen.has(rule.id)) {
      ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: `duplicate rule id ${rule.id}` });
    }
    seen.add(rule.id);
  });
});

export type PackFile = z.output<typeof packFileSchema>;

/** JSON with object keys sorted at every depth. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("canonicalJson: unsupported value");
}

/**
 * SHA-256 (lowercase hex) of the canonical JSON of the parsed rule, defaults
 * included. YAML key order, quoting, and whitespace do not affect it; writing
 * a default explicitly is the same rule as omitting it. Every field counts,
 * including metadata such as `severity` and `source`.
 */
export function ruleRevision(rule: Rule): string {
  return createHash("sha256").update(canonicalJson(rule)).digest("hex");
}
