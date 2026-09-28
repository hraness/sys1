import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

export const WORKFLOWS = ["failure-triage", "evidence-relevance", "claim-support"] as const;
export type Workflow = typeof WORKFLOWS[number];
export type Prediction = Record<string, string | number>;
export interface BaselineCase {
  id: string;
  state: unknown;
  expected: Prediction;
  split?: string | undefined;
  family?: string | undefined;
}

// These comparators are intentionally small and frozen before any model calls.
// They are useful controls, not general semantic classifiers.
const triageSchema = z.object({
  command_purpose: z.string().max(16_384),
  exit_status: z.number().int().nullable().optional(),
  excerpts: z.array(z.string().max(65_536)).max(128),
});
const relevanceSchema = z.object({ task: z.string().max(65_536), excerpt: z.string().max(65_536) });
const supportSchema = z.object({ claim: z.string().max(65_536), excerpt: z.string().max(65_536) });

const signatures: ReadonlyArray<readonly [string, RegExp]> = [
  ["inspect_source", /\b(?:SyntaxError|error TS\d+|error\[E\d+\]|syntax error|parse error|type mismatch|mismatched types)\b/i],
  ["inspect_assertion", /\b(?:AssertionError|assertion failed|assertion failure|expected .{1,100}(?:received|actual))\b/i],
  ["inspect_dependencies", /\b(?:Cannot find (?:package|module)|MODULE_NOT_FOUND|ModuleNotFoundError|GemNotFound|dependency conflict|unable to resolve dependency|no matching distribution)\b/i],
  ["inspect_access", /\b(?:HTTP\s+(?:401|403)|EACCES|EPERM|permission denied|access denied|authentication required|unauthorized|forbidden)\b/i],
  ["inspect_environment", /\b(?:UnsupportedClassVersionError|unsupported runtime|unsupported platform|command not found|requires (?:Node(?:\.js)?|Python|Java|Bun)|bad CPU type|exec format error)\b/i],
  ["inspect_connectivity", /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|SSL_ERROR_SYSCALL|DNS lookup failed|connection refused|TLS handshake failed|network is unreachable)\b/i],
];

/** Match diagnostic signatures; abstain when zero or several categories match. */
export function failureTriageBaseline(state: unknown): Prediction {
  const input = triageSchema.parse(state);
  if (input.exit_status === undefined || input.exit_status === null || input.exit_status === 0) {
    return { investigation: "unknown" };
  }
  const text = input.excerpts.join("\n");
  const matches = signatures.filter(([, pattern]) => pattern.test(text));
  return { investigation: matches.length === 1 ? matches[0]![0] : "unknown" };
}

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from", "has", "have",
  "how", "i", "in", "is", "it", "its", "may", "must", "of", "on", "or", "s", "should", "that", "the", "their",
  "them", "these", "this", "to", "was", "were", "what", "when", "where", "which", "who", "why", "will", "with",
]);

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((token) => !stopWords.has(token)));
}

/** Unweighted fraction of task tokens present in the excerpt; no semantic inference. */
export function evidenceRelevanceBaseline(state: unknown): Prediction {
  const input = relevanceSchema.parse(state);
  const task = tokens(input.task);
  const excerpt = tokens(input.excerpt);
  if (task.size === 0) return { relevance: 0 };
  const overlap = [...task].filter((token) => excerpt.has(token)).length / task.size;
  return { relevance: overlap === 0 ? 0 : overlap < 0.3 ? 1 : overlap < 0.65 ? 2 : 3 };
}

function literal(text: string): string {
  return text.toLowerCase()
    .replace(/\b(?:doesn't|don't|isn't|aren't|cannot|can't)\b/g, "not")
    .replace(/\b(?:version|does|do|is|are|can)\b/g, " ")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ").trim();
}

function containsStatement(haystack: string, needle: string): boolean {
  return (` ${haystack} `).includes(` ${needle} `);
}

/**
 * Weak literal comparator: full normalized claim match, or the same complete
 * statement with one added/removed "not". It does not resolve paraphrases,
 * quotations, quantifiers, numbers, compound claims, or subject references.
 */
export function claimSupportBaseline(state: unknown): Prediction {
  const input = supportSchema.parse(state);
  const claim = literal(input.claim);
  const excerpt = literal(input.excerpt);
  if (claim.length === 0) return { support: "insufficient_evidence" };
  if (containsStatement(excerpt, claim)) return { support: "supported" };
  const words = claim.split(" ");
  if (words.includes("not")) {
    const positive = words.filter((word) => word !== "not").join(" ");
    if (positive.length > 0 && containsStatement(excerpt, positive)) return { support: "contradicted" };
  } else {
    for (let index = 1; index < words.length; index++) {
      const negative = [...words.slice(0, index), "not", ...words.slice(index)].join(" ");
      if (containsStatement(excerpt, negative)) return { support: "contradicted" };
    }
  }
  return { support: "insufficient_evidence" };
}

export function baselinePrediction(workflow: Workflow, state: unknown): Prediction {
  switch (workflow) {
    case "failure-triage": return failureTriageBaseline(state);
    case "evidence-relevance": return evidenceRelevanceBaseline(state);
    case "claim-support": return claimSupportBaseline(state);
  }
}

export function runBaseline(workflow: Workflow, cases: readonly BaselineCase[]) {
  const predictions = cases.map((example) => {
    const predicted = baselinePrediction(workflow, example.state);
    const correct = Object.keys(predicted).length === Object.keys(example.expected).length
      && Object.entries(example.expected).every(([key, value]) => predicted[key] === value);
    return {
      id: example.id, split: example.split ?? null, family: example.family ?? null,
      expected: example.expected, predicted, correct,
    };
  });
  const correct = predictions.filter((prediction) => prediction.correct).length;
  return {
    workflow,
    baseline_revision: "synthetic-screening-1",
    cases: cases.length,
    correct,
    accuracy: cases.length === 0 ? null : correct / cases.length,
    predictions,
  };
}

if (import.meta.main) {
  try {
    const [workflowValue, file, ...extra] = process.argv.slice(2);
    const workflow = z.enum(WORKFLOWS).parse(workflowValue);
    if (!file || extra.length > 0) throw new Error("arguments");
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("fixture size");
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("fixture size");
    const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    const cases = z.array(z.object({
      id: identifier,
      state: z.unknown(),
      expected: z.record(z.string(), z.union([z.string(), z.number().finite()])),
      split: identifier.optional(),
      family: identifier.optional(),
    }).strict()).min(1).max(1000).parse(JSON.parse(text) as unknown);
    if (new Set(cases.map(({ id }) => id)).size !== cases.length) throw new Error("duplicate IDs");
    process.stdout.write(`${JSON.stringify(runBaseline(workflow, cases), null, 2)}\n`);
  } catch {
    process.stderr.write("Use: bun scripts/workflow-baselines.ts <failure-triage|evidence-relevance|claim-support> <fixtures.json>\nInvalid arguments, fixture file, or workflow state.\n");
    process.exitCode = 1;
  }
}
