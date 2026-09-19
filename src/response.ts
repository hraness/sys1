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

/**
 * Validate the wire shape and its relationship to the original questions.
 * Local adapters round to three decimal places: allow 0.0005 rounding per
 * probability, plus 0.0005 for the score. This is arithmetic consistency,
 * not an assessment of a model's calibration or accuracy.
 */
export function validateResponseForRequest(request: SystemOneRequest, value: unknown): SystemOneResponse {
  try {
    const response = systemOneResponseSchema.parse(value);
    if (!matchesRequest(request, response)) throw new Error();
    for (const answer of Object.values(response.answers)) {
      if (answer.type === "noul") continue;
      const values = Object.values(answer.probabilities);
      const total = values.reduce((sum, probability) => sum + probability, 0);
      if (Math.abs(total - 1) > values.length * 0.0005 + 1e-9) throw new Error();
      if (answer.type === "choice") {
        // A rounded tie is allowed; a strictly lower probability is not.
        if (answer.probabilities[answer.choice]! + 1e-9 < Math.max(...values)) throw new Error();
      } else {
        const expected = Object.entries(answer.probabilities).reduce(
          (sum, [level, probability]) => sum + Number(level) * probability, 0,
        );
        const weightedRounding = values.length * (values.length - 1) / 2 * 0.0005;
        if (Math.abs(answer.score - expected) > weightedRounding + 0.0005 + 1e-9) throw new Error();
      }
    }
    return response;
  } catch {
    throw new Error("Invalid or mismatched System One response");
  }
}
