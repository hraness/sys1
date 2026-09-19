import { describe, expect, test } from "bun:test";
import { systemOneRequestSchema } from "../src/protocol.ts";

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
