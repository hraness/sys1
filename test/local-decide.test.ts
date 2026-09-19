import { describe, expect, test } from "bun:test";
import {
  DECIDE_LIMITS,
  aggregateMass,
  answerLabels,
  confidenceOf,
  decisionPrompt,
  outcomeFromMass,
  toLocalAnswer,
} from "../src/local/decide.ts";
import type { Question } from "../src/protocol.ts";

describe("local decision prompts", () => {
  test("noul prompt ends at a constrained answer position", () => {
    const question: Question = {
      type: "noul",
      instructions: "Does this need immediate attention?",
      criteria: { true: "urgent", false: "not urgent" },
    };
    const prompt = decisionPrompt("production is down", question);
    expect(prompt).toContain("YES or NO");
    expect(prompt).toContain("YES means: urgent");
    expect(prompt.endsWith("Answer:")).toBe(true);
    expect(answerLabels(question)).toEqual(["yes", "no"]);
  });

  test("choice prompt uses single-character labels for arbitrary option names", () => {
    const question: Question = {
      type: "choice",
      instructions: "Pick a route",
      criteria: { "repair-now": "fast", backlog: null, escalate: "human review" },
    };
    const prompt = decisionPrompt({ severity: 9 }, question);
    expect(prompt).toContain("1: repair-now — fast");
    expect(prompt).toContain("2: backlog");
    expect(answerLabels(question)).toEqual(["1", "2", "3"]);
    const ten: Question = {
      type: "choice",
      criteria: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`option-${i}`, null])),
    };
    expect(answerLabels(ten)[9]).toBe("A");
  });

  test("maximum local choice prompt preserves every label and answer position", () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 35 }, (_, i) => [
        `option-${i}-${"k".repeat(240)}`,
        "description".repeat(100),
      ]),
    );
    const question: Question = {
      type: "choice",
      instructions: "instruction".repeat(500),
      criteria,
    };
    const prompt = decisionPrompt("state".repeat(4_000), question);
    expect(prompt.length).toBeLessThanOrEqual(DECIDE_LIMITS.maxPromptChars);
    expect(prompt).toContain("Z: option-34");
    expect(prompt.endsWith("Answer:")).toBe(true);
  });

  test("score prompt labels levels from one", () => {
    const question: Question = {
      type: "score",
      criteria: ["low", "medium", "high"],
    };
    expect(answerLabels(question)).toEqual(["1", "2", "3"]);
    expect(decisionPrompt("x", question)).toContain("3: high");
  });
});

describe("vocabulary mass aggregation", () => {
  test("combines token spellings and reports uncovered mass", () => {
    const mass = aggregateMass(
      [
        [" YES", 0.4],
        ["Yes", 0.1],
        [" no", 0.2],
        [" other", 0.3],
      ],
      ["yes", "no"],
    );
    expect(mass.masses[0]).toBeCloseTo(0.5);
    expect(mass.masses[1]).toBeCloseTo(0.2);
    expect(mass.top).toBe(0);
    expect(mass.coverage).toBeCloseTo(0.7);
  });

  test("does not confuse numeric prefix labels", () => {
    const mass = aggregateMass(
      [
        [" 10", 0.7],
        [" 1", 0.2],
        ["x", 0.1],
      ],
      ["1", "10"],
    );
    expect(mass.masses).toEqual([0.2, 0.7]);
    expect(mass.top).toBe(1);
  });

  test("renormalizes only over allowed labels", () => {
    const outcome = outcomeFromMass(
      aggregateMass(
        [
          [" yes", 0.3],
          [" no", 0.1],
          [" maybe", 0.6],
        ],
        ["yes", "no"],
      ),
      ["yes", "no"],
    );
    expect(outcome?.label).toBe("yes");
    expect(outcome?.distribution[0]).toBeCloseTo(0.75);
    expect(outcome?.coverage).toBeCloseTo(0.4);
    expect(confidenceOf(outcome?.distribution ?? [])).toBeCloseTo(0.5);
  });

  test("maps a numeric choice back to its option key", () => {
    const question: Question = {
      type: "choice",
      criteria: { first: null, second: null, third: null },
    };
    const answer = toLocalAnswer(question, {
      label: "2",
      distribution: [0.1, 0.8, 0.1],
      coverage: 0.9,
    });
    if (answer.type !== "choice") throw new Error("expected choice answer");
    expect(answer.choice).toBe("second");
    expect(answer.probabilities).toEqual({ first: 0.1, second: 0.8, third: 0.1 });
    expect(answer.confidence).toBe(0.7);
  });

  test("maps score probability to the fractional zero-based Jev shape", () => {
    const question: Question = {
      type: "score",
      criteria: ["low", { label: "medium" }, ["high"]],
    };
    const answer = toLocalAnswer(question, {
      label: "3",
      distribution: [0.02, 0.36, 0.62],
      coverage: 0.99,
    });
    if (answer.type !== "score") throw new Error("expected score answer");
    expect(answer.score).toBe(1.6);
    expect(answer.legend).toEqual({ "0": "low", "1": { label: "medium" }, "2": ["high"] });
    expect(answer.probabilities).toEqual({ "0": 0.02, "1": 0.36, "2": 0.62 });
  });
});
