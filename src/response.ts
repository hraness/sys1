import { systemOneResponseSchema, type EntryType, type SystemOneRequest, type SystemOneResponse } from "./protocol.ts";

function sameEntry(left: EntryType, right: EntryType): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) =>
    Object.hasOwn(b, key) && sameEntry(a[key] as EntryType, b[key] as EntryType),
  );
}

function matchesRequest(request: SystemOneRequest, response: SystemOneResponse): boolean {
  const questionNames = Object.keys(request.questions);
  if (questionNames.length !== Object.keys(response.answers).length) return false;
  return questionNames.every((name) => {
    const question = request.questions[name]!;
    if (!Object.hasOwn(response.answers, name)) return false;
    const answer = response.answers[name]!;
    if (question.type !== answer.type) return false;
    if (question.type === "choice" && answer.type === "choice") {
      const options = Object.keys(question.criteria);
      return Object.hasOwn(question.criteria, answer.choice) &&
        options.length === Object.keys(answer.probabilities).length &&
        options.every((option) => Object.hasOwn(answer.probabilities, option));
    }
    if (question.type === "score" && answer.type === "score") {
      return question.criteria.length === Object.keys(answer.legend).length &&
        question.criteria.every((criterion, index) => sameEntry(criterion, answer.legend[String(index)]!));
    }
    return true;
  });
}

interface ProbabilityBounds {
  lower: number;
  upper: number;
}

/** Extreme mean attainable inside the rounding intervals while totaling one. */
function scoreEndpoint(bounds: ProbabilityBounds[], lowerTotal: number, maximum: boolean): number {
  let expected = bounds.reduce((sum, bound, level) => sum + level * bound.lower, 0);
  let remaining = Math.max(0, 1 - lowerTotal);
  // Starting at every lower bound, assign remaining mass to the least or most
  // valuable level first. Score keys are validated as contiguous from zero.
  for (let position = 0; position < bounds.length && remaining > 0; position++) {
    const level = maximum ? bounds.length - 1 - position : position;
    const bound = bounds[level]!;
    const added = Math.min(remaining, bound.upper - bound.lower);
    expected += level * added;
    remaining -= added;
  }
  return expected;
}

/**
 * Validate the wire shape and its relationship to the original questions.
 * Three decimal places remain the default. A protocol adapter may explicitly
 * select two decimal places for a backend that publishes that precision.
 * Require a normalized distribution inside the half-unit rounding intervals,
 * and a compatible expected score within its own half-unit interval.
 * This is arithmetic consistency, not an assessment of calibration or accuracy.
 */
export function validateResponseForRequest(
  request: SystemOneRequest,
  value: unknown,
  roundingDecimals: 2 | 3 = 3,
): SystemOneResponse {
  try {
    if (roundingDecimals !== 2 && roundingDecimals !== 3) throw new Error();
    const rounding = 0.5 * 10 ** -roundingDecimals;
    const response = systemOneResponseSchema.parse(value);
    if (!matchesRequest(request, response)) throw new Error();
    for (const answer of Object.values(response.answers)) {
      if (answer.type === "noul") continue;
      const values = Object.values(answer.probabilities);
      const total = values.reduce((sum, probability) => sum + probability, 0);
      const bounds = values.map((probability) => ({
        lower: Math.max(0, probability - rounding),
        upper: Math.min(1, probability + rounding),
      }));
      const lowerTotal = bounds.reduce((sum, bound) => sum + bound.lower, 0);
      const upperTotal = bounds.reduce((sum, bound) => sum + bound.upper, 0);
      if (total <= 0 || lowerTotal > 1 + 1e-9 || upperTotal < 1 - 1e-9) throw new Error();
      if (answer.type === "choice") {
        // A rounded tie is allowed; a strictly lower probability is not.
        if (answer.probabilities[answer.choice]! + 1e-9 < Math.max(...values)) throw new Error();
      } else {
        const minimum = scoreEndpoint(bounds, lowerTotal, false);
        const maximum = scoreEndpoint(bounds, lowerTotal, true);
        if (answer.score + rounding < minimum - 1e-9 || answer.score - rounding > maximum + 1e-9) {
          throw new Error();
        }
      }
    }
    return response;
  } catch {
    throw new Error("Invalid or mismatched System One response");
  }
}
