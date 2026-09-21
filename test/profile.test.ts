import { describe, expect, test } from "bun:test";
import { createProfile, Sys1ProfileError, type ProfileDefinition } from "../src/profile.ts";
import { PROTOCOL_LIMITS } from "../src/protocol.ts";

function definition(): ProfileDefinition {
  return {
    version: 1,
    id: "support-triage",
    revision: "v1",
    model: "kev-support/kev-latest",
    questions: {
      urgent: { type: "noul", instructions: "Does this require immediate attention?", criteria: { true: "Immediate", false: "Routine" } },
      queue: { type: "choice", instructions: "Choose the responsible team.", criteria: { product: "Product defect", billing: "Payment issue" } },
      severity: { type: "score", instructions: "Rate impact.", criteria: ["low", { impact: "high" }] },
    },
  };
}

describe("decision profiles", () => {
  test("compiles the complete reusable recipe to an ordinary wire request", () => {
    const source = definition();
    const profile = createProfile(source);
    const state = { ticket: "A customer cannot pay.", model: "untrusted/model", questions: { override: true } };
    const request = profile.request(state);
    expect(request).toEqual({ model: source.model, state, questions: source.questions });
    expect(Object.keys(request).sort()).toEqual(["model", "questions", "state"]);
    expect(Object.keys(request.questions)).toEqual(["urgent", "queue", "severity"]);
    expect(profile.definition.id).toBe("support-triage");
    expect(profile.definition.revision).toBe("v1");
  });

  test("freezes its entire definition without freezing caller data", () => {
    const source = definition();
    const profile = createProfile(source);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.definition)).toBe(true);
    expect(Object.isFrozen(profile.definition.questions)).toBe(true);
    expect(Object.isFrozen(profile.definition.questions.severity)).toBe(true);
    const severity = profile.definition.questions["severity"];
    if (severity?.type !== "score") throw new Error("missing score question");
    const criteria = severity.criteria;
    const criterion = criteria[0];
    expect(criterion).toBe("low");
    expect(Object.isFrozen(criteria)).toBe(true);
    expect(Object.isFrozen(criteria[1])).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    source.model = "different/model";
    source.questions.urgent = { type: "noul", instructions: "Mutated" };
    expect(profile.request(null).model).toBe("kev-support/kev-latest");
    expect(profile.request(null).questions.urgent?.instructions).toBe("Does this require immediate attention?");
  });

  test("returned requests and input state do not alias the definition or later requests", () => {
    const profile = createProfile(definition());
    const state = { facts: ["original"] };
    const first = profile.request(state);
    first.model = "different/model";
    first.questions.queue = { type: "noul" };
    const firstState = first.state as typeof state;
    firstState.facts.push("changed request");
    state.facts.push("changed caller");
    expect(firstState.facts).toEqual(["original", "changed request"]);
    const second = profile.request({ facts: ["fresh"] });
    expect(second.model).toBe("kev-support/kev-latest");
    expect(second.questions.queue?.type).toBe("choice");
    expect(second.state).toEqual({ facts: ["fresh"] });
  });

  test("treats template-like strings as literal data", () => {
    const source = definition();
    source.questions.urgent = { type: "noul", instructions: "Inspect {{state}} and ${privateKey} literally." };
    const request = createProfile(source).request("${model} {{instructions}}");
    expect(request.state).toBe("${model} {{instructions}}");
    expect(request.questions.urgent?.instructions).toBe("Inspect {{state}} and ${privateKey} literally.");
  });

  test("requires explicit schema identity and an exact backend/model pin", () => {
    for (const changes of [
      { version: 2 }, { version: undefined }, { id: "" }, { id: "x".repeat(65) },
      { id: "unsafe/name" }, { id: "name\n" }, { revision: "" }, { revision: "x".repeat(65) },
      { revision: " name" }, { model: "auto" }, { model: "jev-1.13.0" }, { model: "/model" },
      { model: "kev/" }, { model: "Bad/model" }, { model: "kev/model name" },
      { model: "kev/model\n" }, { model: `kev/${"m".repeat(125)}` },
    ]) {
      expect(() => createProfile({ ...definition(), ...changes })).toThrow("Invalid Sys1 profile");
    }
    for (const model of ["typesafe/jev-1.13.0", "local-qwen3-1.7b/qwen3-1.7b", "kev/team/checkpoint"]) {
      expect(createProfile({ ...definition(), model }).request(null).model).toBe(model);
    }
  });

  test("rejects ignored overrides and nested question typos", () => {
    for (const input of [
      { ...definition(), state: "stored evidence" },
      { ...definition(), instructions: "ignored global prompt" },
      { ...definition(), fallback: "typesafe/jev-1.13.0" },
      { ...definition(), questions: { q: { type: "noul", instruction: "typo" } } },
      { ...definition(), questions: { q: { type: "noul", criteria: { true: "yes", maybe: "typo" } } } },
      { ...definition(), questions: { q: { type: "choice", criteria: { yes: "yes" }, temperature: 0.1 } } },
      { ...definition(), questions: { q: { type: "score", criteria: ["low", "high"], prompt: "typo" } } },
    ]) expect(() => createProfile(input)).toThrow("Invalid Sys1 profile");
  });

  test("preserves ordinary protocol question, option, and instruction byte bounds", () => {
    const questions = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`q${i}`, { type: "noul" as const }]));
    expect(Object.keys(createProfile({ ...definition(), questions }).request(null).questions)).toHaveLength(64);
    for (const invalid of [
      {}, { ...questions, excess: { type: "noul" } },
      { ["q".repeat(129)]: { type: "noul" } },
      { q: { type: "choice", criteria: {} } },
      { q: { type: "choice", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } },
      { q: { type: "score", criteria: ["one"] } },
      { q: { type: "noul", instructions: "é".repeat(2_049) } },
      { q: { type: "noul", criteria: { true: "é".repeat(513) } } },
    ]) expect(() => createProfile({ ...definition(), questions: invalid })).toThrow("Invalid Sys1 profile");
    const bounded = createProfile({ ...definition(), questions: { q: { type: "noul", instructions: "é".repeat(2_048) } } });
    expect(bounded.request(null).questions.q?.instructions).toBe("é".repeat(2_048));
  });

  test("matches the gateway state byte bound including JSON escaping", () => {
    const profile = createProfile(definition());
    expect(profile.request("x".repeat(PROTOCOL_LIMITS.maxStateBytes - 2)).state).toHaveLength(PROTOCOL_LIMITS.maxStateBytes - 2);
    for (const state of [
      "x".repeat(PROTOCOL_LIMITS.maxStateBytes - 1),
      "é".repeat(PROTOCOL_LIMITS.maxStateBytes / 2),
      "\n".repeat(PROTOCOL_LIMITS.maxStateBytes / 2),
      { evidence: "x".repeat(PROTOCOL_LIMITS.maxStateBytes) },
    ]) expect(() => profile.request(state)).toThrow("Invalid Sys1 profile request");
  });

  test("bounds the full profile and combined request independently", () => {
    const question = { type: "choice" as const, instructions: "i".repeat(4_096), criteria: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o${i}`, "c".repeat(1_024)])) };
    const questions = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`q${i}`, question]));
    const profile = createProfile({ ...definition(), questions });
    expect(Object.keys(profile.request(null).questions)).toHaveLength(60);
    expect(() => profile.request("s".repeat(100_000))).toThrow("Invalid Sys1 profile request");
    const oversized = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`q${i}`, question]));
    expect(() => createProfile({ ...definition(), questions: oversized })).toThrow("Invalid Sys1 profile");
  });

  test("rejects non-JSON and cyclic inputs without executing serialization hooks", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    let hooks = 0;
    const getter = { get secret() { hooks++; return "private"; } };
    const serializer = { toJSON() { hooks++; return "private"; } };
    const invalid = [undefined, NaN, Infinity, BigInt(1), Symbol("private"), () => "private", new Date(), new Map(), cycle, getter, serializer, [undefined], Array(1)];
    const profile = createProfile(definition());
    for (const state of invalid) {
      expect(() => profile.request(state)).toThrow("Invalid Sys1 profile request");
      expect(() => createProfile({ ...definition(), questions: { q: { type: "noul", instructions: state } } })).toThrow("Invalid Sys1 profile");
    }
    expect(hooks).toBe(0);
    // Reused JSON objects are legal; only ancestry cycles are forbidden.
    const shared = { label: "valid" };
    expect(profile.request([shared, shared]).state).toEqual([shared, shared]);
  });

  test("reports stable errors without including sensitive inputs or causes", () => {
    for (const operation of [
      () => createProfile({ ...definition(), private: "private-secret" }),
      () => createProfile(definition()).request({ secret: "private-secret", nested: undefined }),
    ]) {
      try {
        operation();
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(Sys1ProfileError);
        expect(JSON.stringify(error)).not.toContain("private-secret");
        expect(String(error)).not.toContain("private-secret");
        expect(error).not.toHaveProperty("cause");
      }
    }
  });
});
