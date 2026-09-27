import { describe, expect, test } from "bun:test";
import {
  AUDIT_CONTEXT,
  QUESTION_FORMAT,
  Sys1CompileError,
  compileUnit,
  ensureInstructions,
  ruleApplies,
  ruleQuestion,
} from "../src/audit/compile.ts";
import { ruleSchema, type Rule } from "../src/audit/schema.ts";
import { PROTOCOL_LIMITS, systemOneRequestSchema } from "../src/protocol.ts";

function rule(input: Record<string, unknown>): Rule {
  return ruleSchema.parse({ applies: { paths: ["**/*"] }, ...input });
}

const ensureRule = (id: string, extra: Record<string, unknown> = {}): Rule =>
  rule({ id, ensure: `Rule ${id} holds.`, breaks: `Rule ${id} is broken.`, ...extra });

function compileError(run: () => unknown): Sys1CompileError {
  try {
    run();
  } catch (error) {
    if (error instanceof Sys1CompileError) return error;
    throw error;
  }
  throw new Error("expected a Sys1CompileError");
}

describe("rule questions", () => {
  test("an ensure rule asks whether the unit satisfies it; true is ensure, false is breaks", () => {
    const question = ruleQuestion(rule({ id: "x", ensure: "Errors are surfaced.", breaks: "An error is swallowed." }));
    expect(question).toEqual({
      type: "noul",
      instructions: AUDIT_CONTEXT + "Does the shown change satisfy this rule? Rule: Errors are surfaced.",
      criteria: { true: "Errors are surfaced.", false: "An error is swallowed." },
    });
    expect(ensureInstructions("A.")).toBe(AUDIT_CONTEXT + "Does the shown change satisfy this rule? Rule: A.");
    expect(QUESTION_FORMAT).toBe(2);
  });

  test("all question kinds separate untrusted diff evidence from rule instructions", () => {
    expect(ruleQuestion(rule({ id: "n", ask: "Leads with the point?", true: "Yes.", false: "No." }))).toEqual({
      type: "noul", instructions: AUDIT_CONTEXT + "Leads with the point?", criteria: { true: "Yes.", false: "No." },
    });
    expect(ruleQuestion(rule({ id: "c", type: "choice", ask: "Which?", options: { none: "None.", leak: "Leak." }, violations: ["leak"] }))).toEqual({
      type: "choice", instructions: AUDIT_CONTEXT + "Which?", criteria: { none: "None.", leak: "Leak." },
    });
    expect(ruleQuestion(rule({ id: "s", type: "score", ask: "How bad?", levels: ["Fine.", "Bad.", "Worse."], violation_at: 1 }))).toEqual({
      type: "score", instructions: AUDIT_CONTEXT + "How bad?", criteria: ["Fine.", "Bad.", "Worse."],
    });
  });

  test("questions do not alias the rule", () => {
    const choice = rule({ id: "c", type: "choice", ask: "Which?", options: { a: "A.", b: "B." }, violations: ["b"] });
    const question = ruleQuestion(choice);
    if (question.type !== "choice") throw new Error("expected choice");
    question.criteria["a"] = "changed";
    expect(choice.type === "choice" && choice.options["a"]).toBe("A.");
  });
});

describe("rule selection", () => {
  test("ruleApplies honours paths, except, and languages", () => {
    const ts = rule({ id: "ts", applies: { paths: ["**/*.{ts,tsx}"], except: ["**/*.test.ts"], languages: ["typescript"] }, ensure: "a", breaks: "b" });
    expect(ruleApplies(ts, { path: "src/a.ts", language: "typescript" })).toBe(true);
    expect(ruleApplies(ts, { path: "a.ts", language: "typescript" })).toBe(true);
    expect(ruleApplies(ts, { path: "src/a.test.ts", language: "typescript" })).toBe(false);
    expect(ruleApplies(ts, { path: "src/a.md", language: "typescript" })).toBe(false);
    expect(ruleApplies(ts, { path: "src/a.ts", language: "javascript" })).toBe(false);
    expect(ruleApplies(ts, { path: "src/a.ts" })).toBe(false);
    const docs = rule({ id: "docs", applies: { paths: ["docs/**/*.md"] }, ensure: "a", breaks: "b" });
    expect(ruleApplies(docs, { path: "docs/guide/a.md" })).toBe(true);
    expect(ruleApplies(docs, { path: "README.md" })).toBe(false);
  });

});

describe("compileUnit", () => {
  const state = "src/a.ts (typescript)\nL0001|export const a = 1;\n";

  test("a unit matched by 70 rules compiles to two valid requests", () => {
    const rules = Array.from({ length: 70 }, (_, index) => ensureRule(`rule-${index}`));
    const requests = compileUnit(rules, state);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(systemOneRequestSchema.safeParse(request).success).toBe(true);
      expect(request.state).toBe(state);
      expect(request.model).toBeUndefined();
    }
    expect(Object.keys(requests[0]?.questions ?? {})).toHaveLength(PROTOCOL_LIMITS.maxQuestions);
    const names = requests.flatMap((request) => Object.keys(request.questions));
    expect(names).toEqual(rules.map((item) => item.id));
  });

  test("question names are rule ids and a model pin applies to every request", () => {
    const rules = Array.from({ length: 65 }, (_, index) => ensureRule(`r-${index}`));
    const requests = compileUnit(rules, state, { model: "hosted/jev-1.13.0" });
    expect(requests.map((request) => request.model)).toEqual(["hosted/jev-1.13.0", "hosted/jev-1.13.0"]);
    expect(requests[1]?.questions["r-64"]).toEqual(ruleQuestion(rules[64] as Rule));
  });

  test("splits before the body limit when questions are large", () => {
    const big = "x".repeat(PROTOCOL_LIMITS.maxCriterionChars - 1);
    const options = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`o${index}`, big]));
    const rules = Array.from({ length: 8 }, (_, index) =>
      rule({ id: `wide-${index}`, type: "choice", ask: "Which?", options, violations: ["o1"] }));
    const largeState = "y".repeat(PROTOCOL_LIMITS.maxStateBytes - 2);
    const requests = compileUnit(rules, largeState);
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(systemOneRequestSchema.safeParse(request).success).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(PROTOCOL_LIMITS.maxBodyBytes);
      expect(Object.keys(request.questions).length).toBeLessThan(PROTOCOL_LIMITS.maxQuestions);
    }
    expect(requests.flatMap((request) => Object.keys(request.questions))).toEqual(rules.map((item) => item.id));
  });

  test("packs requests as full as the body limit allows", () => {
    const big = "x".repeat(PROTOCOL_LIMITS.maxCriterionChars - 1);
    const options = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`o${index}`, big]));
    const rules = Array.from({ length: 8 }, (_, index) =>
      rule({ id: `wide-${index}`, type: "choice", ask: "Which?", options, violations: ["o1"] }));
    const largeState = "y".repeat(PROTOCOL_LIMITS.maxStateBytes - 2);
    const requests = compileUnit(rules, largeState);
    for (let index = 0; index < requests.length - 1; index++) {
      const request = requests[index];
      const next = requests[index + 1];
      if (request === undefined || next === undefined) throw new Error("missing request");
      const firstNext = Object.entries(next.questions)[0];
      if (firstNext === undefined) throw new Error("empty request");
      const grown = { ...request, questions: { ...request.questions, [firstNext[0]]: firstNext[1] } };
      expect(new TextEncoder().encode(JSON.stringify(grown)).byteLength).toBeGreaterThan(PROTOCOL_LIMITS.maxBodyBytes);
    }
  });

  test("accepts structured state and returns no requests for no rules", () => {
    expect(compileUnit([], state)).toEqual([]);
    const structured = { path: "src/a.ts", lines: ["L0001|a"] };
    expect(compileUnit([ensureRule("x")], structured)[0]?.state).toEqual(structured);
  });

  test("rejects state over maxStateBytes instead of truncating it", () => {
    const error = compileError(() => compileUnit([ensureRule("x")], "z".repeat(PROTOCOL_LIMITS.maxStateBytes)));
    expect(error.code).toBe("state_too_large");
    expect(error.message).not.toContain("zzz");
  });

  test("rejects state that is not a protocol entry", () => {
    expect(compileError(() => compileUnit([ensureRule("x")], 42 as unknown as string)).code).toBe("invalid_state");
  });

  test("rejects duplicate rule ids", () => {
    expect(compileError(() => compileUnit([ensureRule("x"), ensureRule("x")], state)).code).toBe("duplicate_rule");
  });

  test("property: every rule lands in exactly one valid request, in order", () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 4_294_967_296;
    };
    for (let round = 0; round < 40; round++) {
      const count = 1 + Math.floor(next() * 200);
      const rules = Array.from({ length: count }, (_, index) => next() < 0.5
        ? ensureRule(`p-${index}`)
        : rule({ id: `p-${index}`, type: "score", ask: "How bad?", levels: ["a".repeat(1 + Math.floor(next() * 900)), "b"], violation_at: 1 }));
      const requests = compileUnit(rules, "s".repeat(Math.floor(next() * PROTOCOL_LIMITS.maxStateBytes)));
      expect(requests.length).toBeGreaterThanOrEqual(Math.ceil(count / PROTOCOL_LIMITS.maxQuestions));
      for (const request of requests) expect(systemOneRequestSchema.safeParse(request).success).toBe(true);
      expect(requests.flatMap((request) => Object.keys(request.questions))).toEqual(rules.map((item) => item.id));
    }
  });
});
