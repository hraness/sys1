import {
  systemOneResponseSchema,
  type JsonValue,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./protocol.ts";
import { validateResponseForRequest } from "./response.ts";

// Python str.isspace(), used by Kev's render(...).lstrip(). JavaScript's
// trimStart differs for characters such as U+0085 and U+FEFF.
const pythonLeadingWhitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

function renderNumber(value: number): string {
  // Match the number Python receives after the request is JSON-serialized:
  // decimal integer tokens stay integers, while floats use Python's exponent
  // threshold and its two-digit exponent padding.
  const wire = JSON.stringify(value);
  if (!/[.e]/i.test(wire)) return wire;
  if (Math.abs(value) < 1e-4 || Math.abs(value) >= 1e16) {
    return value.toExponential().replace(/e([+-])(\d)$/u, "e$10$2");
  }
  return wire;
}

/** Mirrors kev/api.py render at e943f21e40574d99cefb2d292089333bcda9047c. */
function render(value: JsonValue, indent = 0): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return renderNumber(value);
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    return value.map((entry) => `${pad}- ${render(entry, indent + 1).replace(pythonLeadingWhitespace, "")}`).join("\n");
  }
  return Object.entries(value).map(([key, entry]) =>
    entry !== null && typeof entry === "object"
      ? `${pad}${key}:\n${render(entry, indent + 1)}`
      : `${pad}${key}: ${render(entry)}`,
  ).join("\n");
}

/** Supply Kev's required instructions field without changing caller-owned data. */
export function adaptKevRequest(request: SystemOneRequest): SystemOneRequest {
  const adapted = structuredClone(request);
  for (const question of Object.values(adapted.questions)) {
    if (question.instructions === undefined) question.instructions = null;
  }
  return adapted;
}

/** Preserve native numeric results and restore only verified score legends. */
export function adaptKevResponse(request: SystemOneRequest, value: unknown): SystemOneResponse {
  try {
    const response = systemOneResponseSchema.parse(value);
    if (request.model !== undefined && response.model !== request.model) throw new Error();
    for (const [name, question] of Object.entries(request.questions)) {
      if (question.type !== "score") continue;
      const answer = response.answers[name];
      if (answer?.type !== "score" || Object.keys(answer.legend).length !== question.criteria.length) {
        throw new Error();
      }
      if (!question.criteria.every((criterion, index) => answer.legend[String(index)] === render(criterion))) {
        throw new Error();
      }
      answer.legend = Object.fromEntries(question.criteria.map((criterion, index) =>
        [String(index), structuredClone(criterion)],
      ));
    }
    return validateResponseForRequest(request, response, 2);
  } catch {
    throw new Error("Invalid or mismatched System One response");
  }
}
