import { describe, expect, test } from "bun:test";
import { systemOneRequestSchema, systemOneResponseSchema } from "../src/protocol.ts";

const base = {
  state: { ticket: "payouts failing for 3 days" },
  questions: {
    urgent: { type: "noul", instructions: "Does this convey urgency?" },
  },
};

describe("systemOneRequestSchema", () => {
  test("accepts a minimal noul request", () => {
    const parsed = systemOneRequestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  test("accepts choice and score questions with optional model", () => {
    const parsed = systemOneRequestSchema.safeParse({
      model: "jev-latest",
      state: "hello",
      questions: {
        dept: {
          type: "choice",
          criteria: { billing: "invoices", technical: "bugs", other: null },
        },
        anger: { type: "score", criteria: ["calm", "mad", "furious"] },
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts structured instructions and criteria entries", () => {
    const parsed = systemOneRequestSchema.safeParse({
      state: ["ticket", { severity: 3 }],
      questions: {
        urgent: {
          type: "noul",
          instructions: { task: "judge urgency", ignore: ["signature"] },
          criteria: { true: ["blocking", { timeframe: "now" }], false: null },
        },
        route: {
          type: "choice",
          criteria: { billing: { includes: ["invoice", "refund"] }, other: null },
        },
        severity: {
          type: "score",
          criteria: [null, { level: "moderate" }, ["critical", "blocking"]],
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects scalar numbers as state or instructions", () => {
    expect(systemOneRequestSchema.safeParse({ ...base, state: 42 }).success).toBe(false);
    expect(
      systemOneRequestSchema.safeParse({
        state: "x",
        questions: { q: { type: "noul", instructions: 42 } },
      }).success,
    ).toBe(false);
  });

  test("rejects missing state", () => {
    const parsed = systemOneRequestSchema.safeParse({ questions: base.questions });
    expect(parsed.success).toBe(false);
  });

  test("rejects unknown question type", () => {
    const parsed = systemOneRequestSchema.safeParse({
      state: "x",
      questions: { q: { type: "essay" } },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects empty questions map", () => {
    const parsed = systemOneRequestSchema.safeParse({ state: "x", questions: {} });
    expect(parsed.success).toBe(false);
  });

  test("rejects choice with zero options", () => {
    const parsed = systemOneRequestSchema.safeParse({
      state: "x",
      questions: { q: { type: "choice", criteria: {} } },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects choice with more than 255 options", () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [`opt${i}`, "d"]),
    );
    const parsed = systemOneRequestSchema.safeParse({
      state: "x",
      questions: { q: { type: "choice", criteria } },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects score with one level", () => {
    const parsed = systemOneRequestSchema.safeParse({
      state: "x",
      questions: { q: { type: "score", criteria: ["only"] } },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects more than 64 questions", () => {
    const questions = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: "noul" }]),
    );
    const parsed = systemOneRequestSchema.safeParse({ state: "x", questions });
    expect(parsed.success).toBe(false);
  });
});

describe("systemOneResponseSchema", () => {
  const response = {
    model: "jev-1.13.0",
    answers: {
      urgent: { type: "noul", noul: 0.97 },
      route: {
        type: "choice",
        choice: "billing",
        confidence: 0.98,
        probabilities: { billing: 0.98, technical: 0.02 },
      },
      severity: {
        type: "score",
        score: 1.6,
        confidence: 0.62,
        legend: { "0": "low", "1": { label: "medium" }, "2": ["high"] },
        probabilities: { "0": 0.02, "1": 0.36, "2": 0.62 },
      },
    },
    usage: { input_tokens: 190, output_tokens: 0 },
  };

  test("accepts the canonical Jev answer shapes", () => {
    expect(systemOneResponseSchema.safeParse(response).success).toBe(true);
  });

  test("rejects the former one-based array score shape", () => {
    const invalid = structuredClone(response);
    invalid.answers.severity = {
      type: "score",
      score: 3,
      confidence: 0.8,
      legend: { "0": "low", "1": "medium", "2": "high" },
      probabilities: [0.1, 0.2, 0.7],
    } as never;
    expect(systemOneResponseSchema.safeParse(invalid).success).toBe(false);
  });

  test("rejects inconsistent answer distributions", () => {
    const missingChoice = structuredClone(response);
    missingChoice.answers.route.choice = "other";
    expect(systemOneResponseSchema.safeParse(missingChoice).success).toBe(false);

    const mismatchedScore = structuredClone(response);
    delete (mismatchedScore.answers.severity.probabilities as Record<string, number>)["2"];
    expect(systemOneResponseSchema.safeParse(mismatchedScore).success).toBe(false);
  });
});
