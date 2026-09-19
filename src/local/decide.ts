import type {
  ChoiceQuestion,
  JsonValue,
  NoulQuestion,
  Question,
  ScoreQuestion,
  SystemOneRequest,
} from "../protocol.ts";

/**
 * Generic-LLM decision adapter. A GGUF chat/base model is not a trained
 * System One model, so this layer approximates the contract: render a bounded
 * prompt that ends at the answer position, then read the model's first-token
 * vocabulary distribution and aggregate probability mass over every spelling
 * of each allowed answer label.
 *
 * The result is a Jev-style answer object. `confidence` reports how
 * concentrated the model's belief is over the allowed labels; `coverage`
 * reports what fraction of total token mass landed on labels at all — a
 * generic model that ignores the instruction gets low coverage, not a
 * silently wrong answer.
 */

export const DECISION_LABELS = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
] as const;

export const DECIDE_LIMITS = {
  maxStateChars: 6_000,
  maxPromptChars: 16_000,
  maxInstructionChars: 2_000,
  maxOptionChars: 96,
  maxCriterionChars: 96,
  maxLabels: DECISION_LABELS.length,
} as const;

export const NOUL_LABELS = ["yes", "no"] as const;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function renderState(state: JsonValue): string {
  const text = typeof state === "string" ? state : JSON.stringify(state);
  return truncate(text, DECIDE_LIMITS.maxStateChars);
}

function clamp(text: string): string {
  if (text.length > DECIDE_LIMITS.maxPromptChars) {
    throw new Error(`decision prompt exceeds ${DECIDE_LIMITS.maxPromptChars} characters`);
  }
  return text;
}

function noulPrompt(state: JsonValue, q: NoulQuestion): string {
  const criteria: string[] = [];
  if (q.criteria?.true !== undefined) {
    criteria.push(`YES means: ${truncate(q.criteria.true, DECIDE_LIMITS.maxCriterionChars)}`);
  }
  if (q.criteria?.false !== undefined) {
    criteria.push(`NO means: ${truncate(q.criteria.false, DECIDE_LIMITS.maxCriterionChars)}`);
  }
  return clamp(
    [
      "You are a decision engine. Read the state, then answer the question with exactly one word: YES or NO.",
      "",
      "State:",
      '"""',
      renderState(state),
      '"""',
      `Question: ${truncate(q.instructions ?? "Is the claim true?", DECIDE_LIMITS.maxInstructionChars)}`,
      ...(criteria.length > 0 ? [criteria.join(" ")] : []),
      "Answer:",
    ].join("\n"),
  );
}

function choicePrompt(state: JsonValue, q: ChoiceQuestion): string {
  const lines = Object.entries(q.criteria)
    .slice(0, DECIDE_LIMITS.maxLabels)
    .map(([option, desc], i) => {
      const name = truncate(option, DECIDE_LIMITS.maxOptionChars);
      const detail =
        desc === null ? "" : ` — ${truncate(desc, DECIDE_LIMITS.maxCriterionChars)}`;
      return `${DECISION_LABELS[i]}: ${name}${detail}`;
    });
  return clamp(
    [
      "You are a decision engine. Read the state, then answer with exactly one option label from the list. Answer with the label only.",
      "",
      "State:",
      '"""',
      renderState(state),
      '"""',
      `Question: ${truncate(q.instructions ?? "Choose the best option.", DECIDE_LIMITS.maxInstructionChars)}`,
      "Options:",
      ...lines,
      "Answer:",
    ].join("\n"),
  );
}

function scorePrompt(state: JsonValue, q: ScoreQuestion): string {
  const lines = q.criteria.map(
    (desc, i) => `${DECISION_LABELS[i]}: ${truncate(desc, DECIDE_LIMITS.maxCriterionChars)}`,
  );
  return clamp(
    [
      "You are a decision engine. Read the state, then rate it on the given scale. Answer with the level label only.",
      "",
      "State:",
      '"""',
      renderState(state),
      '"""',
      `Question: ${truncate(q.instructions ?? "Rate the state.", DECIDE_LIMITS.maxInstructionChars)}`,
      "Scale (lowest to highest):",
      ...lines,
      "Answer:",
    ].join("\n"),
  );
}

/**
 * The allowed answer labels for one question, in answer order. noul fixes
 * YES/NO; choice and score use the unique one-character label table.
 */
export function answerLabels(question: Question): string[] {
  switch (question.type) {
    case "noul":
      return [...NOUL_LABELS];
    case "choice":
      return DECISION_LABELS.slice(0, Object.keys(question.criteria).length);
    case "score":
      return DECISION_LABELS.slice(0, question.criteria.length);
  }
}

export function decisionPrompt(state: JsonValue, question: Question): string {
  switch (question.type) {
    case "noul":
      return noulPrompt(state, question);
    case "choice":
      return choicePrompt(state, question);
    case "score":
      return scorePrompt(state, question);
  }
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Attribute one vocabulary token to a label. A token counts toward a label
 * when its normalized text equals the label, is a strict prefix of it
 * (" urg" completes "urgent"), or extends it ("yes," continues "yes").
 */
function tokenCoversLabel(tokenText: string, label: string): boolean {
  const token = normalize(tokenText);
  if (token.length === 0) return false;
  const norm = normalize(label);
  if (token === norm) return true;
  if (norm.startsWith(token)) return true;
  // Only let a longer token extend a label when the label is a complete
  // word-ish prefix — "yes," counts for "yes" but "yesterday" must not.
  if (token.startsWith(norm)) {
    const rest = token.slice(norm.length);
    return rest.length > 0 && !/^[a-z0-9]/.test(rest);
  }
  return false;
}

export interface LabelMass {
  /** Probability mass per label, same order as `labels`. */
  masses: number[];
  /** Index of the heaviest label, or -1 when no label received mass. */
  top: number;
  /** Fraction of total mass that landed on any label (0..1). */
  coverage: number;
}

/**
 * Aggregate a detokenized vocabulary distribution `{text, p}` over the
 * allowed labels. `entries` need not be normalized or complete; any tail mass
 * not present in the array simply lowers `coverage`.
 */
export function aggregateMass(
  entries: Iterable<readonly [string, number]>,
  labels: string[],
): LabelMass {
  const masses = new Array<number>(labels.length).fill(0);
  let total = 0;
  for (const [text, p] of entries) {
    if (!(p > 0)) continue;
    total += p;
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i];
      if (label !== undefined && tokenCoversLabel(text, label)) {
        masses[i] = (masses[i] ?? 0) + p;
        break;
      }
    }
  }
  let top = -1;
  let topMass = 0;
  for (let i = 0; i < masses.length; i += 1) {
    const mass = masses[i] ?? 0;
    if (mass > topMass) {
      topMass = mass;
      top = i;
    }
  }
  const covered = masses.reduce((a, b) => a + b, 0);
  return { masses, top, coverage: total > 0 ? Math.min(1, covered / total) : 0 };
}

export interface QuestionOutcome {
  label: string;
  /** Label masses renormalized to sum to 1 across labels (coverage < 1 puts
   *  the remainder on "no readable answer", not on a random label). */
  distribution: number[];
  coverage: number;
}

export function outcomeFromMass(mass: LabelMass, labels: string[]): QuestionOutcome | null {
  if (mass.top < 0) return null;
  const covered = mass.masses.reduce((a, b) => a + b, 0);
  const distribution =
    covered > 0 ? mass.masses.map((m) => m / covered) : mass.masses.map(() => 0);
  const label = labels[mass.top];
  if (label === undefined) return null;
  return { label, distribution, coverage: mass.coverage };
}

/** Sharpened 0..1 confidence: how far the top label is from a uniform pick. */
export function confidenceOf(distribution: number[]): number {
  const top = Math.max(...distribution);
  const uniform = 1 / distribution.length;
  if (distribution.length <= 1 || top <= uniform) return 0;
  return Math.min(1, (top - uniform) / (1 - uniform));
}

export interface LocalAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number> | number[];
  confidence: number;
  coverage: number;
}

/**
 * Map one question's label outcome to the wire answer shape. noul reports
 * `noul` = P(yes); choice reports the winning option key plus the per-option
 * distribution; score reports the 1-based level index plus the per-level
 * distribution.
 */
export function toLocalAnswer(question: Question, outcome: QuestionOutcome): LocalAnswer {
  const confidence = Math.round(confidenceOf(outcome.distribution) * 1000) / 1000;
  const coverage = Math.round(outcome.coverage * 1000) / 1000;
  switch (question.type) {
    case "noul": {
      const yes = outcome.distribution[0] ?? 0;
      return {
        type: "noul",
        noul: Math.round(yes * 1000) / 1000,
        confidence,
        coverage,
      };
    }
    case "choice": {
      const keys = Object.keys(question.criteria);
      const probabilities: Record<string, number> = {};
      keys.forEach((key, i) => {
        probabilities[key] = Math.round((outcome.distribution[i] ?? 0) * 1000) / 1000;
      });
      const selected = keys[DECISION_LABELS.indexOf(outcome.label as (typeof DECISION_LABELS)[number])];
      return {
        type: "choice",
        ...(selected === undefined ? {} : { choice: selected }),
        probabilities,
        confidence,
        coverage,
      };
    }
    case "score": {
      const level = DECISION_LABELS.indexOf(outcome.label as (typeof DECISION_LABELS)[number]) + 1;
      return {
        type: "score",
        score: level > 0 ? level : 1,
        probabilities: outcome.distribution.map((p) => Math.round(p * 1000) / 1000),
        confidence,
        coverage,
      };
    }
  }
}

export interface LocalResponse {
  model: string;
  answers: Record<string, LocalAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export function toLocalResponse(
  model: string,
  answers: Record<string, LocalAnswer>,
  usage: { input_tokens: number; output_tokens: number },
): LocalResponse {
  return { model, answers, usage };
}

/** Ordered `[name, question]` pairs for a validated request. */
export function questionEntries(request: SystemOneRequest): [string, Question][] {
  return Object.entries(request.questions).slice(0, 64) as [string, Question][];
}
