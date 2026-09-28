import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EVALUATION_LIMITS, PROFILE_EVALUATION_HELP, gradeAnswer, parseEvaluationOptions, prepareEvaluation, readEvaluationJson, runEvaluation,
} from "../scripts/evaluate-profile.ts";
import type { Question, SystemOneResponse } from "../src/protocol.ts";

const profile = {
  version: 1, id: "test-profile", revision: "v1", model: "http/test-model",
  questions: {
    category: { type: "choice", instructions: "PRIVATE_QUESTION", criteria: { a: "PRIVATE_CRITERION", b: "Other" } },
    passed: { type: "noul" },
    relevance: { type: "score", criteria: ["PRIVATE_LOW", "PRIVATE_HIGH"] },
  },
};
const fixture = (id = "case-1") => ({
  id, state: "PRIVATE_STATE", expected: { category: "a", passed: true, relevance: 1 }, split: "dev", family: "example",
});
const response = (): SystemOneResponse => ({
  model: "test-model",
  answers: {
    category: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.01 },
    passed: { type: "noul", noul: 0.8 },
    relevance: { type: "score", score: 0.8, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "PRIVATE_LOW", "1": "PRIVATE_HIGH" }, confidence: 0.2 },
  },
  usage: { input_tokens: 20, output_tokens: 0 },
});
const fetcher = (handler: (init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((_url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(init!))) as typeof fetch;

describe("experimental profile evaluator", () => {
  test("CLI help exits successfully without requiring input files", () => {
    const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../scripts/evaluate-profile.ts"), "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(PROFILE_EVALUATION_HELP);
    expect(result.stderr.toString()).toBe("");
  });

  test("validates every fixture and produces stable content hashes without inference by default", async () => {
    const prepared = prepareEvaluation(profile, [fixture()]);
    expect(prepared).toEqual(prepareEvaluation(structuredClone(profile), [fixture()]));
    expect(prepared.profile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.fixtures_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.cases[0]!.request_sha256).toMatch(/^[a-f0-9]{64}$/);
    const report = await runEvaluation(profile, [fixture()], {}, fetcher(() => { throw new Error("must not run"); }));
    expect(report).toMatchObject({ schema_version: 1, mode: "validate_only", summary: { planned: 1, attempted: 0, completed: 0, errors: 0, skipped: 1 } });
    expect(report.cases[0]).toMatchObject({ status: "skipped", skip_reason: "validate_only", questions: null });
    expect(prepareEvaluation(profile, [{ ...fixture(), state: "changed" }]).cases[0]!.request_sha256).not.toBe(prepared.cases[0]!.request_sha256);
    const relabeled = prepareEvaluation(profile, [{ ...fixture(), expected: { category: "b", passed: true, relevance: 1 } }]);
    expect(relabeled.fixtures_sha256).not.toBe(prepared.fixtures_sha256);
    expect(relabeled.cases[0]!.request_sha256).toBe(prepared.cases[0]!.request_sha256);
    expect(prepared.cases[0]!.request).not.toHaveProperty("expected");
  });

  test("rejects invalid or duplicate labels anywhere in the dataset before a call", async () => {
    let calls = 0;
    const transport = fetcher(() => { calls++; return Response.json(response()); });
    const invalidCases: unknown[] = [
      [], [fixture(), fixture()], [{ ...fixture(), id: "bad id" }],
      [{ ...fixture(), expected: { category: "unknown", passed: true, relevance: 1 } }],
      [{ ...fixture(), expected: { category: "a", passed: 1, relevance: 1 } }],
      [{ ...fixture(), expected: { category: "a", passed: true, relevance: 1.5 } }],
      [{ ...fixture(), expected: { category: "a", passed: true, relevance: 2 } }],
      [{ ...fixture(), expected: { category: "a", passed: true, relevance: -1 } }],
      [{ ...fixture(), expected: { category: "a", passed: true } }],
      [{ ...fixture(), expected: { category: "a", passed: true, relevance: 1, extra: true } }],
      [{ ...fixture(), state: "x".repeat(262_145) }],
      [{ ...fixture(), extra: "unexpected" }],
      [fixture(), { ...fixture("last"), expected: {} }],
    ];
    for (const cases of invalidCases) await expect(runEvaluation(profile, cases, { run: true, maxRequests: 1 }, transport)).rejects.toThrow("invalid_input");
    expect(calls).toBe(0);
  });

  test("choice grading requires a unique argmax and keeps confidence separate", () => {
    const question: Question = { type: "choice", criteria: { a: "A", b: "B" } };
    expect(gradeAnswer(question, "a", { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.01 })).toEqual({ outcome: "correct", probabilities: [0.7, 0.3], confidence: 0.01, score_absolute_error: null });
    expect(gradeAnswer(question, "b", { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 1 }).outcome).toBe("incorrect");
    for (const expected of ["a", "b"]) expect(gradeAnswer(question, expected, { type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.5 }, confidence: 1 }).outcome).toBe("unresolved");
  });

  test("Noul midpoint remains unresolved for both labels", () => {
    for (const expected of [false, true]) expect(gradeAnswer({ type: "noul" }, expected, { type: "noul", noul: 0.5 })).toMatchObject({ outcome: "unresolved", probabilities: [0.5, 0.5], confidence: null });
    expect(gradeAnswer({ type: "noul" }, false, { type: "noul", noul: 0.499 }).outcome).toBe("correct");
    expect(gradeAnswer({ type: "noul" }, false, { type: "noul", noul: 0.501 }).outcome).toBe("incorrect");
  });

  test("Score uses unique argmax with continuous score error measured separately", () => {
    const question: Question = { type: "score", criteria: ["Low", "High"] };
    expect(gradeAnswer(question, 1, { type: "score", score: 0.8, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "Low", "1": "High" }, confidence: 0.1 })).toMatchObject({ outcome: "correct", probabilities: [0.2, 0.8], confidence: 0.1 });
    const tie = gradeAnswer(question, 1, { type: "score", score: 0.5, probabilities: { "0": 0.5, "1": 0.5 }, legend: { "0": "Low", "1": "High" }, confidence: 1 });
    expect(tie).toMatchObject({ outcome: "unresolved", score_absolute_error: 0.5 });
  });

  test("makes serial requests, sends only profile requests, and records metadata without prose or answer bodies", async () => {
    let active = 0;
    let maximumActive = 0;
    const report = await runEvaluation(profile, [fixture("one"), fixture("two")], { run: true }, fetcher(async init => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      expect(JSON.parse(String(init.body))).toEqual(prepareEvaluation(profile, [fixture()]).cases[0]!.request);
      await Promise.resolve();
      active--;
      return Response.json(response(), { headers: { "x-sys1-backend": "http", "x-sys1-attempts": "1", "x-sys1-local-adapter": "first-token-v1", "x-sys1-local-min-coverage": "0.5" } });
    }));
    expect(maximumActive).toBe(1);
    expect(report.summary).toMatchObject({ planned: 2, attempted: 2, completed: 2, errors: 0, skipped: 0, questions: { correct: 6, incorrect: 0, unresolved: 0 }, usage: { known_calls: 2, unknown_calls: 0, input_tokens: 40, output_tokens: 0 } });
    expect(report.cases[0]).toMatchObject({ id: "one", split: "dev", family: "example", route: { backend: "http", attempts: 1, model: "test-model", local: { adapter: "first-token-v1", minCoverage: 0.5 } } });
    expect(report.cases[0]!.questions!.relevance!.score_absolute_error).toBeCloseTo(0.2);
    expect(report.cases[0]!.elapsed_ms).toBeGreaterThanOrEqual(0);
    const text = JSON.stringify(report);
    for (const secret of ["PRIVATE_STATE", "PRIVATE_QUESTION", "PRIVATE_CRITERION", "PRIVATE_LOW", "PRIVATE_HIGH", '"answers":', '"legend":', '"expected":']) expect(text).not.toContain(secret);
  });

  test("caps requests and records every unattempted case", async () => {
    let calls = 0;
    const report = await runEvaluation(profile, [fixture("one"), fixture("two"), fixture("three")], { run: true, maxRequests: 1 }, fetcher(() => { calls++; return Response.json(response()); }));
    expect(calls).toBe(1);
    expect(report.summary).toMatchObject({ attempted: 1, completed: 1, errors: 0, skipped: 2 });
    expect(report.cases.map(item => item.skip_reason)).toEqual([null, "max_requests", "max_requests"]);
  });

  test("keeps transport errors sanitized, counts unknown usage, and never retries", async () => {
    let calls = 0;
    const report = await runEvaluation(profile, [fixture("one"), fixture("two")], { run: true }, fetcher(() => {
      calls++;
      if (calls === 1) throw new Error("PRIVATE_TRANSPORT_BODY");
      return new Response("PRIVATE_SERVER_BODY", { status: 503 });
    }));
    expect(calls).toBe(2);
    expect(report.summary).toMatchObject({ attempted: 2, errors: 2, completed: 0, usage: { known_calls: 0, unknown_calls: 2, input_tokens: 0, output_tokens: 0 } });
    expect(report.cases.map(item => item.error)).toEqual(["transport_error", "http_error"]);
    expect(report.cases[1]!.http_status).toBe(503);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
  });

  test("retains client response validation instead of grading malformed responses", async () => {
    const invalid = response();
    invalid.answers.category = { type: "choice", choice: "a", probabilities: { a: 0.1, b: 0.1 }, confidence: 1 };
    const report = await runEvaluation(profile, [fixture()], { run: true }, fetcher(() => Response.json(invalid)));
    expect(report.cases[0]).toMatchObject({ status: "error", error: "invalid_response", questions: null, route: null });
    expect(report.summary.questions).toEqual({ correct: 0, incorrect: 0, unresolved: 0 });
  });

  test("observes caller abort before any call and during an in-flight request", async () => {
    const pre = new AbortController();
    pre.abort();
    const before = await runEvaluation(profile, [fixture()], { run: true, signal: pre.signal }, fetcher(() => { throw new Error("must not run"); }));
    expect(before.cases[0]!.skip_reason).toBe("aborted");
    const controller = new AbortController();
    const during = await runEvaluation(profile, [fixture("one"), fixture("two")], { run: true, signal: controller.signal }, fetcher(() => {
      controller.abort();
      return new Promise<Response>(() => {});
    }));
    expect(during.cases[0]).toMatchObject({ status: "error", error: "aborted" });
    expect(during.cases[1]).toMatchObject({ status: "skipped", skip_reason: "aborted" });
  });

  test("per-request timeout and whole-run deadline terminate even an uncooperative fake transport", async () => {
    const hanging = fetcher(() => new Promise<Response>(() => {}));
    const timeout = await runEvaluation(profile, [fixture()], { run: true, timeoutMs: 5, deadlineMs: 1_000 }, hanging);
    expect(timeout.cases[0]).toMatchObject({ status: "error", error: "timeout" });
    const deadline = await runEvaluation(profile, [fixture("one"), fixture("two")], { run: true, timeoutMs: 1_000, deadlineMs: 5 }, hanging);
    expect(deadline.cases[0]).toMatchObject({ status: "error", error: "deadline" });
    expect(deadline.cases[1]).toMatchObject({ status: "skipped", skip_reason: "deadline" });
    expect(deadline.summary).toMatchObject({ attempted: 1, errors: 1, skipped: 1 });
  });

  test("parses explicit run and bounded controls and rejects unsupported or repeated flags", () => {
    expect(parseEvaluationOptions(["--profile", "profile.json", "--fixtures", "fixtures.json"])).toEqual({ profile: "profile.json", fixtures: "fixtures.json", run: false, url: "http://127.0.0.1:13900", maxRequests: 100, timeoutMs: 30_000, deadlineMs: 300_000 });
    expect(parseEvaluationOptions(["--profile", "p", "--fixtures", "f", "--run", "--max-requests", "16", "--timeout-ms", "1000", "--deadline-ms", "2000"])).toMatchObject({ run: true, maxRequests: 16, timeoutMs: 1000, deadlineMs: 2000 });
    const base = ["--profile", "p", "--fixtures", "f"];
    for (const args of [[], ["--profile"], [...base, "--run", "--run"], [...base, "--output", "x"], [...base, "--max-requests", "0"], [...base, "--max-requests", "1001"], [...base, "--timeout-ms", "300001"], [...base, "--deadline-ms", "3600001"], [...base, "--max-requests", "1.5"], [...base, "--timeout-ms", "Infinity"], [...base, "--profile", "x"]]) expect(() => parseEvaluationOptions(args)).toThrow("invalid_options");
  });

  test("rejects credential-bearing URL options without making a request", async () => {
    let calls = 0;
    await expect(runEvaluation(profile, [fixture()], { run: true, url: "https://user:PRIVATE_KEY@example.test" }, fetcher(() => { calls++; return Response.json(response()); }))).rejects.toThrow("Invalid Sys1 client options");
    expect(calls).toBe(0);
  });

  test("reads only bounded regular JSON files without leaking file paths or content", () => {
    const directory = mkdtempSync(join(tmpdir(), "sys1-profile-evaluation-"));
    try {
      const path = join(directory, "private-input.json");
      writeFileSync(path, '{"valid":true}');
      expect(readEvaluationJson(path, 100)).toEqual({ valid: true });
      expect(() => readEvaluationJson(path, 1)).toThrow("input_file_error");
      expect(() => readEvaluationJson(directory, 100)).toThrow("input_file_error");
      expect(() => readEvaluationJson(path, EVALUATION_LIMITS.fixtureBytes + 1)).toThrow("input_file_error");
      // File symlink creation requires an optional Windows privilege.
      if (process.platform !== "win32") {
        const link = join(directory, "link.json");
        symlinkSync(path, link);
        expect(() => readEvaluationJson(link, 100)).toThrow("input_file_error");
      }
      writeFileSync(path, "PRIVATE_INVALID_JSON");
      expect(() => readEvaluationJson(path, 100)).toThrow("Profile evaluation input_file_error");
      writeFileSync(path, Buffer.from([0xff]));
      expect(() => readEvaluationJson(path, 100)).toThrow("input_file_error");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
