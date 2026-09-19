import { describe, expect, test } from "bun:test";
import {
  needleAnswers,
  needlePrompt,
  needleTools,
  scorerAnswer,
  scorerInput,
} from "../src/local/adapt.ts";
import type { SystemOneRequest } from "../src/protocol.ts";

const choiceQ = {
  type: "choice" as const,
  instructions: "pick one",
  criteria: { alpha: "first", beta: null, gamma: ["third"] },
};

const scoreQ = {
  type: "score" as const,
  criteria: ["low", "high"],
};

const noulQ = {
  type: "noul" as const,
  criteria: { true: "it is urgent", false: "it is routine" },
};

describe("scorer adapter", () => {
  test("maps choice criteria to context+options preserving keys", () => {
    const input = scorerInput("some state", choiceQ, 224, 96);
    expect(input.keys).toEqual(["alpha", "beta", "gamma"]);
    expect(input.options[0]).toContain("alpha");
    expect(input.options[0]).toContain("first");
    expect(input.options[1]).toBe("beta");
    expect(input.context).toContain("some state");
    expect(input.context).toContain("pick one");
  });

  test("maps noul to a two-option true/false pair", () => {
    const input = scorerInput("state", noulQ, 224, 96);
    expect(input.keys).toEqual(["true", "false"]);
    expect(input.options[0]).toBe("it is urgent");
    expect(input.options[1]).toBe("it is routine");
  });

  test("maps score levels to indexed options", () => {
    const input = scorerInput("state", scoreQ, 224, 96);
    expect(input.keys).toEqual(["0", "1"]);
    expect(input.options[1]).toContain("high");
  });

  test("rejects options and context that would discard evidence", () => {
    const long = "x".repeat(500);
    expect(() => scorerInput("s", { ...choiceQ, criteria: { [long]: null } }, 224, 96)).toThrow();
    expect(() => scorerInput("x".repeat(224), choiceQ, 224, 96)).toThrow();
    expect(() => scorerInput("é".repeat(113), noulQ, 224, 96)).toThrow();
  });

  test("scorerAnswer builds official answer shapes", () => {
    const answer = scorerAnswer(choiceQ, ["alpha", "beta", "gamma"], [0.1, 0.7, 0.2]);
    expect(answer).toEqual({
      type: "choice",
      choice: "beta",
      probabilities: { alpha: 0.1, beta: 0.7, gamma: 0.2 },
      confidence: 0.55,
    });

    const noul = scorerAnswer(noulQ, ["true", "false"], [0.8, 0.2]);
    expect(noul).toEqual({ type: "noul", noul: 0.8 });

    const score = scorerAnswer(scoreQ, ["0", "1"], [0.25, 0.75]);
    expect(score).toEqual({
      type: "score",
      score: 0.75,
      legend: { "0": "low", "1": "high" },
      probabilities: { "0": 0.25, "1": 0.75 },
      confidence: 0.5,
    });
  });
});

describe("needle adapter", () => {
  const request: SystemOneRequest = {
    state: "customer wants a refund",
    questions: { refund: noulQ, department: choiceQ, severity: scoreQ },
  };

  test("renders one evaluate tool with all questions as arguments", () => {
    const { toolsJson } = needleTools(request);
    const tools = JSON.parse(toolsJson) as {
      name: string;
      parameters: { properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
    }[];
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool?.name).toBe("evaluate");
    expect(tool?.parameters.required).toEqual(["refund", "department", "severity"]);
    expect(tool?.parameters.properties["refund"]?.type).toBe("boolean");
    expect(tool?.parameters.properties["department"]?.enum).toEqual(["alpha", "beta", "gamma"]);
    expect(tool?.parameters.properties["severity"]?.enum).toEqual(["0", "1"]);
  });

  test("renders a directive prompt from the state", () => {
    expect(needlePrompt("charged twice")).toBe("Evaluate this input: charged twice");
    expect(needlePrompt({ nested: { a: 1 } })).toContain('"a":1');
  });

  test("maps extracted arguments to answers with disclosed probabilities", () => {
    const { answers, missing } = needleAnswers(
      request,
      { refund: true, department: "beta", severity: "1" },
      0.9,
    );
    expect(missing).toEqual([]);
    expect(answers["refund"]).toEqual({ type: "noul", noul: 0.9 });
    const dept = answers["department"];
    expect(dept?.type).toBe("choice");
    if (dept?.type === "choice") {
      expect(dept.choice).toBe("beta");
      expect(dept.probabilities["beta"]).toBe(0.9);
      expect(dept.confidence).toBe(0.9);
    }
    const sev = answers["severity"];
    expect(sev?.type).toBe("score");
    if (sev?.type === "score") {
      expect(sev.score).toBe(0.9);
      expect(sev.legend).toEqual({ "0": "low", "1": "high" });
    }
  });

  test("reports unusable values as missing", () => {
    const { answers, missing } = needleAnswers(
      request,
      { refund: "maybe", department: "nonexistent", severity: "1" },
      0.5,
    );
    expect(missing).toEqual(["refund", "department"]);
    expect(answers["severity"]?.type).toBe("score");
  });

  test("missing confidence and fractional score levels fail closed", () => {
    expect(needleAnswers(request, { refund: true }, null).answers).toEqual({});
    const result = needleAnswers(request, { refund: true, department: "alpha", severity: 0.5 }, 0.9);
    expect(result.missing).toEqual(["severity"]);
  });

  test("a singleton choice retains unit probability mass", () => {
    const result = needleAnswers({ state: "s", questions: { pick: { type: "choice", criteria: { only: null } } } }, { pick: "only" }, 0.4);
    expect(result.answers["pick"]).toMatchObject({ probabilities: { only: 1 } });
  });
});
