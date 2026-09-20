import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DECISIONS_FIXTURE_SHA256,
  decisionsFixtureSchema,
  decisionRequest,
  gradeDecision,
  loadDecisionsFixture,
  parseDecisionOptions,
  permutations,
  summarizeDecisions,
  type DecisionSample,
} from "../scripts/benchmark-decisions.ts";
import { decisionPrompt } from "../src/local/decide.ts";
import type { Answer, ChoiceAnswer, ScoreAnswer } from "../src/protocol.ts";

type Expected = DecisionSample["expected"];
function choiceAnswer(choice: string, probabilities = { a: 1, b: 0, c: 0 }): ChoiceAnswer {
  return { type: "choice", choice, probabilities, confidence: 1 };
}
function scoreAnswer(probabilities: number[]): ScoreAnswer {
  return {
    type: "score",
    score: probabilities.reduce((sum, probability, level) => sum + probability * level, 0),
    legend: Object.fromEntries(probabilities.map((_, level) => [String(level), `Level ${level}`])),
    probabilities: Object.fromEntries(probabilities.map((probability, level) => [String(level), probability])),
    confidence: 0.8,
  };
}
function sample(expected: Expected, answer: Answer | undefined, overrides: Partial<DecisionSample> = {}, inputTokens = 100, outputTokens = 0): DecisionSample {
  const response = answer === undefined ? null : {
    model: "jev-1.13.0",
    answers: { decision: answer },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
  return {
    phase: "measured",
    repetition: 0,
    case_id: `test-${expected.type}`,
    family: `test-${expected.type}`,
    type: expected.type,
    order: expected.type === "choice" ? ["a", "b", "c"] : null,
    elapsed_ms: 10,
    http_status: response === null ? 503 : 200,
    valid: response !== null,
    error: response === null ? "http_error" : null,
    response,
    expected,
    grade: gradeDecision(expected, answer),
    ...overrides,
  };
}

describe("frozen decisions-v2 benchmark", () => {
  test("keeps the independently authored fixture fixed and balanced within request bounds", () => {
    const fixture = loadDecisionsFixture();
    const bytes = readFileSync(new URL("../benchmarks/decisions-v2.json", import.meta.url));
    const frozenHash = "7e1b3e988c9c27eae96efd1782cb301d998204b94a09ed915bebe0ad3d97e69b";
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(frozenHash);
    expect(DECISIONS_FIXTURE_SHA256).toBe(frozenHash);
    expect(fixture.cases).toHaveLength(72);
    expect(fixture.families).toHaveLength(9);
    const typeCounts = { choice: 0, noul: 0, score: 0 };
    const positions = [0, 0, 0];
    const scoreLevels = [0, 0, 0, 0];
    let trueCount = 0;
    for (const family of fixture.families) expect(fixture.cases.filter(item => item.family === family.id)).toHaveLength(8);
    for (const item of fixture.cases) {
      const request = decisionRequest(fixture, item, "qwen3-1.7b");
      expect(Object.keys(request).sort()).toEqual(["model", "questions", "state"]);
      expect(Object.keys(request.questions)).toEqual(["decision"]);
      expect(request.state).toEqual(item.state);
      expect(request).not.toHaveProperty("expected");
      expect(request).not.toHaveProperty("rationale");
      const question = request.questions.decision!;
      expect(question.type).toBe(item.expected.type);
      expect(() => decisionPrompt(request.state, question)).not.toThrow();
      typeCounts[question.type] += 1;
      if (item.expected.type === "choice") {
        const position = item.option_order!.indexOf(item.expected.choice);
        positions[position] = positions[position]! + 1;
        if (question.type !== "choice") throw new Error("question mismatch");
        expect(Object.keys(question.criteria)).toEqual(item.option_order!);
      } else if (item.expected.type === "noul") trueCount += Number(item.expected.noul);
      else scoreLevels[item.expected.level] = scoreLevels[item.expected.level]! + 1;
    }
    expect(typeCounts).toEqual({ choice: 24, noul: 24, score: 24 });
    expect(positions).toEqual([8, 8, 8]);
    expect(trueCount).toBe(12);
    expect(scoreLevels).toEqual([6, 6, 6, 6]);
    const invalid = structuredClone(fixture);
    invalid.cases[0]!.state = "x".repeat(6001);
    expect(decisionsFixtureSchema.safeParse(invalid).success).toBe(false);
    expect(decisionsFixtureSchema.safeParse({ ...fixture, surprise: true }).success).toBe(false);
  });

  test("reorders only choice criteria, without changing case content or family instructions", () => {
    const fixture = loadDecisionsFixture();
    const item = fixture.cases.find(item => item.expected.type === "choice")!;
    const original = decisionRequest(fixture, item, "jev-1.13.0");
    const order = [...item.option_order!].reverse();
    const reordered = decisionRequest(fixture, item, "jev-1.13.0", order);
    const originalQuestion = original.questions.decision!;
    const reorderedQuestion = reordered.questions.decision!;
    if (originalQuestion.type !== "choice" || reorderedQuestion.type !== "choice") throw new Error("question mismatch");
    expect(Object.keys(reorderedQuestion.criteria)).toEqual(order);
    expect(reordered.state).toEqual(original.state);
    expect(reorderedQuestion.instructions).toEqual(originalQuestion.instructions);
    for (const key of order) expect(reorderedQuestion.criteria[key]).toEqual(originalQuestion.criteria[key]);
    expect(() => decisionRequest(fixture, item, "jev-1.13.0", [order[0]!, order[0]!, order[2]!])).toThrow("invalid order");
    expect(() => decisionRequest(fixture, item, "jev-1.13.0", ["unknown", order[1]!, order[2]!])).toThrow("invalid order");
    expect(() => decisionRequest(fixture, { ...item, family: "missing" }, "jev-1.13.0")).toThrow("unknown family");
  });

  test("requires an explicit pinned model, output and local store, while rejecting unrelated options", () => {
    expect(parseDecisionOptions(["--validate-only"])).toBeNull();
    expect(parseDecisionOptions(["--model", "jev-1.13.0", "--output", "work/result.json"])).toEqual({ model: "jev-1.13.0", output: resolve("work/result.json"), home: undefined });
    expect(parseDecisionOptions(["--model", "qwen3-1.7b", "--home", "work/models", "--output", "work/result.json"])).toEqual({ model: "qwen3-1.7b", output: resolve("work/result.json"), home: resolve("work/models") });
    expect(parseDecisionOptions(["--output", "work/result.json", "--home", "work/models", "--model", "qwen3-0.6b"])!.model).toBe("qwen3-0.6b");
    for (const args of [
      [], ["--model", "jev-latest", "--output", "x"], ["--model", "needle3", "--output", "x"],
      ["--model", "qwen3-1.7b", "--output", "x"], ["--model", "jev-1.13.0", "--home", "x", "--output", "y"],
      ["--model", "jev-1.13.0"], ["--model", "jev-1.13.0", "--output", ""],
      ["--model", "jev-1.13.0", "--output", "x", "--output", "y"],
      ["--model", "jev-1.13.0", "--output", "x", "--endpoint", "https://other.example"],
      ["--model", "jev-1.13.0", "--output", "x", "--api-key", "must-not-be-accepted"],
      ["--validate-only", "--model", "jev-1.13.0"], ["--model"],
    ]) expect(() => parseDecisionOptions(args)).toThrow();
  });

  test("grades exact choice labels and records ties without changing the fixed choice rubric", () => {
    expect(gradeDecision({ type: "choice", choice: "a" }, choiceAnswer("a"))).toMatchObject({ correct: true, predicted: "a", tie: false });
    expect(gradeDecision({ type: "choice", choice: "b" }, choiceAnswer("a"))).toMatchObject({ correct: false, predicted: "a" });
    expect(gradeDecision({ type: "choice", choice: "a" }, choiceAnswer("a", { a: 0.5, b: 0.5, c: 0 }))).toMatchObject({ correct: true, tie: true });
  });

  test("noul uses a strict threshold and cannot turn an undecided tie into a false success", () => {
    for (const expected of [true, false]) expect(gradeDecision({ type: "noul", noul: expected }, { type: "noul", noul: 0.5 })).toMatchObject({ correct: false, predicted: null, confidence: 0.5, tie: true });
    expect(gradeDecision({ type: "noul", noul: true }, { type: "noul", noul: 0.50001 })).toMatchObject({ correct: true, predicted: true, tie: false });
    expect(gradeDecision({ type: "noul", noul: false }, { type: "noul", noul: 0.49999 })).toMatchObject({ correct: true, predicted: false, tie: false });
    expect(gradeDecision({ type: "noul", noul: true }, { type: "noul", noul: 0 })).toMatchObject({ correct: false, confidence: 1 });
  });

  test("score correctness uses unique probability argmax, with continuous score error reported separately", () => {
    expect(gradeDecision({ type: "score", level: 0 }, scoreAnswer([0.7, 0.2, 0.1, 0]))).toMatchObject({ correct: true, predicted: 0, score_absolute_error: 0.4, tie: false });
    expect(gradeDecision({ type: "score", level: 2 }, scoreAnswer([0, 0.5, 0.5, 0]))).toMatchObject({ correct: false, predicted: null, score_absolute_error: 0.5, tie: true });
    const mismatch = gradeDecision({ type: "score", level: 2 }, scoreAnswer([0, 0.7, 0.3, 0]));
    expect(mismatch).toMatchObject({ correct: false, predicted: 1, tie: false });
    expect(mismatch.score_absolute_error).toBeCloseTo(0.7);
    expect(gradeDecision({ type: "score", level: 0 }, undefined)).toEqual({ correct: false, predicted: null, score_absolute_error: null, confidence: null, tie: false });
    expect(gradeDecision({ type: "score", level: 0 }, { type: "noul", noul: 0 })).toMatchObject({ correct: false, score_absolute_error: null });
  });

  test("enumerates all six distinct orders without changing labels or source order", () => {
    const keys = ["a", "b", "c"];
    const orders = permutations(keys);
    expect(orders).toHaveLength(6);
    expect(new Set(orders.map(order => order.join(","))).size).toBe(6);
    expect(keys).toEqual(["a", "b", "c"]);
    for (const key of keys) for (let position = 0; position < 3; position++) expect(orders.filter(order => order[position] === key)).toHaveLength(2);
    expect(() => permutations(["a", "a", "b"])).toThrow();
    expect(() => permutations(["a", "b"])).toThrow();
  });

  test("keeps unique quality, all-attempt latency, repeated usage and whole-experiment cost separate", () => {
    const expected: Expected = { type: "choice", choice: "a" };
    const permutationsPhase = permutations(["a", "b", "c"]).map((order, repetition) => sample(expected, choiceAnswer("a"), { phase: "permutation", repetition, order }, 5));
    const samples = [
      sample(expected, choiceAnswer("a"), { phase: "initial" }, 11, 1),
      sample(expected, choiceAnswer("a"), { phase: "warmup" }, 13, 2),
      sample(expected, choiceAnswer("a"), { elapsed_ms: 10 }),
      sample({ type: "noul", noul: false }, { type: "noul", noul: 0.8 }, { elapsed_ms: 20 }, 200, 5),
      sample({ type: "score", level: 2 }, scoreAnswer([0, 0.7, 0.3, 0]), { elapsed_ms: 30 }, 300),
      sample({ type: "score", level: 0 }, undefined, { case_id: "failed-score", elapsed_ms: 100 }),
      sample(expected, choiceAnswer("a"), { repetition: 1, elapsed_ms: 2 }, 400),
      ...permutationsPhase,
    ];
    const summary = summarizeDecisions(samples, 200, true);
    expect(summary).toMatchObject({ attempted_calls: 13, skipped_calls: 349, first_pass_planned: 72, first_pass_observed: 4, first_pass_skipped: 68, first_pass_correct: 1, measured_attempts: 5, measured_valid: 4, measured_failures: 1, measured_correct: 2, p50_ms: 20, p95_ms: 100, p50_valid_ms: 10, p95_valid_ms: 30, valid_decisions_per_second: 20, score_mae_observed: 1 });
    expect(summary.by_type).toEqual({ choice: { planned: 24, observed: 1, skipped: 23, correct: 1, valid: 1, ties: 0 }, noul: { planned: 24, observed: 1, skipped: 23, correct: 0, valid: 1, ties: 0 }, score: { planned: 24, observed: 2, skipped: 22, correct: 0, valid: 1, ties: 0 } });
    expect(summary.first_score_mae).toBeCloseTo(0.7);
    expect(summary.measured_usage).toEqual({ known_calls: 4, unknown_calls: 1, input_tokens: 1000, output_tokens: 5 });
    expect(summary.all_usage).toEqual({ known_calls: 12, unknown_calls: 1, input_tokens: 1054, output_tokens: 8 });
    expect(summary.estimated_measured_input_cost_usd).toBeCloseTo(1000 * 0.042 / 1e6, 12);
    expect(summary.estimated_all_input_cost_usd).toBeCloseTo(1054 * 0.042 / 1e6, 12);
    expect(summary.permutations).toMatchObject({ attempts: 6, valid: 6, correct: 6, complete_case_groups: 1, invariant_case_groups: 1, by_correct_option_position: [{ position: 0, observed: 2, valid: 2, correct: 2 }, { position: 1, observed: 2, valid: 2, correct: 2 }, { position: 2, observed: 2, valid: 2, correct: 2 }] });
    expect(summarizeDecisions(samples, 200, false).estimated_all_input_cost_usd).toBeNull();
  });

  test("incomplete, repeated-order or invalid permutation groups do not establish invariance", () => {
    const expected: Expected = { type: "choice", choice: "a" };
    const orders = permutations(["a", "b", "c"]);
    const samples = orders.map((order, repetition) => sample(expected, choiceAnswer("b", { a: 0, b: 1, c: 0 }), { phase: "permutation", repetition, order }));
    expect(summarizeDecisions(samples, 0, false).permutations).toMatchObject({ complete_case_groups: 1, invariant_case_groups: 1, correct: 0 });
    expect(summarizeDecisions(samples.slice(0, 5), 0, false).permutations).toMatchObject({ complete_case_groups: 0, invariant_case_groups: 0 });
    expect(summarizeDecisions([...samples.slice(0, 5), samples[0]!], 0, false).permutations).toMatchObject({ complete_case_groups: 0, invariant_case_groups: 0 });
    const invalid = sample(expected, undefined, { phase: "permutation", repetition: 5, order: orders[5]! });
    expect(summarizeDecisions([...samples.slice(0, 5), invalid], 0, false).permutations).toMatchObject({ complete_case_groups: 1, invariant_case_groups: 0 });
  });

  test("missing usage and score errors remain unknown rather than measured zero", () => {
    const failure = sample({ type: "score", level: 0 }, undefined);
    const result = summarizeDecisions([failure], 30, true);
    expect(result).toMatchObject({ first_pass_observed: 1, first_pass_correct: 0, measured_failures: 1, first_score_mae: null, score_mae_observed: 0, measured_usage: { known_calls: 0, unknown_calls: 1, input_tokens: null, output_tokens: null }, estimated_all_input_cost_usd: null });
    const empty = summarizeDecisions([], 0, true);
    expect(empty).toMatchObject({ first_pass_observed: 0, first_pass_skipped: 72, p50_ms: null, p95_ms: null, valid_decisions_per_second: null, estimated_all_input_cost_usd: null });
    const tie = sample({ type: "noul", noul: false }, { type: "noul", noul: 0.5 });
    expect(summarizeDecisions([tie], 10, false).by_type["noul"]).toMatchObject({ observed: 1, correct: 0, valid: 1, ties: 1 });
  });
});
