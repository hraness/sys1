import { LocalInputError } from "./input.ts";

import type {
  Answer,
  EntryType,
  Question,
  SystemOneRequest,
} from "../protocol.ts";
import { confidenceOf } from "./decide.ts";
import { NEEDLE_LIMITS } from "./needle.ts";
import { SCORER_LIMITS } from "./scorer.ts";

/**
 * Question → engine-contract adapters.
 *
 * `scorer`: the option-attention contract is (context string, option strings)
 * → per-option probabilities. The mapping preserves real distributions — the
 * checkpoint's domain limits (form-shaped tasks, 224-byte context, 96-byte
 * options) are disclosed via the adapter header, not hidden.
 *
 * `needle`: the tool-call contract is one `evaluate` tool whose arguments are
 * the request's questions. Needle returns values plus a calibrated turn
 * confidence — not per-option probabilities — so probabilities are a
 * disclosed top-label approximation (confidence on the pick, remaining mass
 * split uniformly), reported as `needle-extract`.
 */

export const SCORER_ADAPT_LIMITS = {
  maxContextBytes: 4_096,
  maxOptionBytes: 512,
  maxNoulOptions: 2,
} as const;

function renderEntry(value: EntryType | undefined, max = 512): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > max) throw new LocalInputError(`local field exceeds ${max} characters`);
  return text;
}

function boundedBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= max) return text;
  throw new LocalInputError(`local field exceeds ${max} UTF-8 bytes`);
}

// ---------- option scorer ----------

/** The (context, options) pair one question scores against. */
export function scorerInput(
  state: EntryType,
  question: Question,
  contextBytes: number,
  optionBytes: number,
): { context: string; options: string[]; keys: string[] } {
  const stateText = renderEntry(state, SCORER_ADAPT_LIMITS.maxContextBytes);
  const instruction = renderEntry(question.instructions ?? undefined, 256);
  const context = boundedBytes(
    instruction.length === 0 ? stateText : `${stateText}\n${instruction}`,
    contextBytes,
  );
  switch (question.type) {
    case "noul": {
      const trueLabel = renderEntry(question.criteria?.true ?? undefined, 48) || "yes";
      const falseLabel = renderEntry(question.criteria?.false ?? undefined, 48) || "no";
      return {
        context,
        options: [trueLabel, falseLabel].map((o) => boundedBytes(o, optionBytes)),
        keys: ["true", "false"],
      };
    }
    case "choice": {
      const entries = Object.entries(question.criteria).slice(0, SCORER_LIMITS.maxOptions);
      return {
        context,
        options: entries.map(([key, desc]) =>
          boundedBytes(
            desc === null ? key : `${key}: ${renderEntry(desc, 96)}`,
            optionBytes,
          ),
        ),
        keys: entries.map(([key]) => key),
      };
    }
    case "score": {
      const entries = question.criteria.slice(0, SCORER_LIMITS.maxOptions);
      return {
        context,
        options: entries.map((desc, i) =>
          boundedBytes(
            desc === null ? `level ${i}` : `${i}: ${renderEntry(desc, 96)}`,
            optionBytes,
          ),
        ),
        keys: entries.map((_, i) => String(i)),
      };
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Map a scorer option distribution to the official answer shape. */
export function scorerAnswer(question: Question, keys: string[], distribution: number[]): Answer {
  const confidence = round(confidenceOf(distribution));
  const top = distribution.indexOf(Math.max(...distribution));
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: round(distribution[0] ?? 0) };
    case "choice": {
      const probabilities: Record<string, number> = {};
      keys.forEach((key, i) => {
        probabilities[key] = round(distribution[i] ?? 0);
      });
      const selected = keys[top];
      if (selected === undefined) throw new Error("scorer outcome has no selected option");
      return { type: "choice", choice: selected, probabilities, confidence };
    }
    case "score": {
      const legend: Record<string, EntryType> = {};
      const probabilities: Record<string, number> = {};
      let score = 0;
      question.criteria.forEach((criterion, i) => {
        const key = String(i);
        const probability = distribution[i] ?? 0;
        legend[key] = criterion;
        probabilities[key] = round(probability);
        score += i * probability;
      });
      return { type: "score", score: round(score), legend, probabilities, confidence };
    }
  }
}

// ---------- needle ----------

interface NeedleArgument {
  type: "boolean" | "string";
  description: string;
  enum?: string[];
}

/** One `evaluate` tool; every question becomes one argument. */
export function needleTools(request: SystemOneRequest): {
  toolsJson: string;
  argumentNames: Record<string, string>;
} {
  const properties: Record<string, NeedleArgument> = {};
  const required: string[] = [];
  const argumentNames: Record<string, string> = {};
  const questions = Object.entries(request.questions).slice(0, NEEDLE_LIMITS.maxArguments);
  for (const [name, question] of questions) {
    const instruction = renderEntry(question.instructions ?? undefined, 200);
    let argument: NeedleArgument;
    switch (question.type) {
      case "noul": {
        const detail = [
          renderEntry(question.criteria?.true ?? undefined, 96),
          renderEntry(question.criteria?.false ?? undefined, 96),
        ]
          .filter((part) => part.length > 0)
          .join(" / ");
        argument = {
          type: "boolean",
          description: detail.length === 0 ? instruction : `${instruction} (${detail})`,
        };
        break;
      }
      case "choice": {
        const entries = Object.entries(question.criteria);
        const detail = entries
          .map(([key, desc]) => `${key}${desc === null ? "" : `: ${renderEntry(desc, 64)}`}`)
          .join("; ");
        argument = {
          type: "string",
          enum: entries.map(([key]) => key),
          description: detail.length === 0 ? instruction : `${instruction} (${detail})`,
        };
        break;
      }
      case "score": {
        const detail = question.criteria
          .map((desc, i) => `${i}${desc === null ? "" : `: ${renderEntry(desc, 64)}`}`)
          .join("; ");
        argument = {
          type: "string",
          enum: question.criteria.map((_, i) => String(i)),
          description: detail.length === 0 ? instruction : `${instruction} (${detail})`,
        };
        break;
      }
    }
    // Argument names must be safe enum/JSON keys; keep the question name
    // verbatim (needle validates on its side and we bound the count).
    argumentNames[name] = name;
    properties[name] = argument;
    required.push(name);
  }
  const tools = [
    {
      name: "evaluate",
      description: "Evaluate the input and fill every field.",
      parameters: { type: "object", properties, required },
    },
  ];
  return { toolsJson: JSON.stringify(tools), argumentNames };
}

/** The prompt fed to needle: directive framing + serialized state. */
export function needlePrompt(state: EntryType): string {
  const stateText = renderEntry(state, NEEDLE_LIMITS.maxPromptBytes - 64);
  return `Evaluate this input: ${stateText}`;
}

function needleProbabilities(keys: string[], selectedIndex: number, confidence: number): Record<string, number> {
  const pick = keys.length === 1 ? 1 : Math.min(1, Math.max(0, confidence));
  const rest = keys.length > 1 ? (1 - pick) / (keys.length - 1) : 0;
  const probabilities: Record<string, number> = {};
  keys.forEach((key, i) => {
    probabilities[key] = round(i === selectedIndex ? pick : rest);
  });
  return probabilities;
}

function needleValue(callArguments: Record<string, unknown>, name: string): unknown {
  return callArguments[name];
}

/**
 * Build answers from one needle turn. `evaluate` arguments carry every
 * question's extracted value; `confidence` is the engine's calibrated turn
 * score applied to every answer — the disclosed `needle-extract`
 * approximation.
 */
export function needleAnswers(
  request: SystemOneRequest,
  callsArguments: Record<string, unknown>,
  confidence: number | null,
): { answers: Record<string, Answer>; missing: string[] } {
  const answers: Record<string, Answer> = {};
  const missing: string[] = [];
  if (confidence === null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { answers, missing: Object.keys(request.questions) };
  }
  const conf = round(confidence);
  for (const [name, question] of Object.entries(request.questions)) {
    const value = needleValue(callsArguments, name);
    switch (question.type) {
      case "noul": {
        if (typeof value !== "boolean" || confidence < 0.5) {
          missing.push(name);
          continue;
        }
        answers[name] = { type: "noul", noul: value ? conf : round(1 - conf) };
        break;
      }
      case "choice": {
        const keys = Object.keys(question.criteria);
        const index = typeof value === "string" ? keys.indexOf(value) : -1;
        if (index < 0 || (keys.length > 1 && confidence < 1 / keys.length)) {
          missing.push(name);
          continue;
        }
        answers[name] = {
          type: "choice",
          choice: keys[index] as string,
          probabilities: needleProbabilities(keys, index, confidence ?? 0.5),
          confidence: conf,
        };
        break;
      }
      case "score": {
        const keys = question.criteria.map((_, i) => String(i));
        const index = typeof value === "string" ? keys.indexOf(value) : typeof value === "number" ? value : -1;
        if (!Number.isInteger(index) || index < 0 || index >= question.criteria.length || confidence < 1 / keys.length) {
          missing.push(name);
          continue;
        }
        const probabilities = needleProbabilities(keys, index, confidence ?? 0.5);
        const legend: Record<string, EntryType> = {};
        let score = 0;
        question.criteria.forEach((criterion, i) => {
          const key = String(i);
          legend[key] = criterion;
          score += i * (probabilities[key] ?? 0);
        });
        answers[name] = {
          type: "score",
          score: round(score),
          legend,
          probabilities,
          confidence: conf,
        };
        break;
      }
    }
  }
  return { answers, missing };
}
