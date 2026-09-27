import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvaluationResult, Sys1Client } from "../src/client.ts";
import type { SystemOneRequest } from "../src/protocol.ts";
import { loadPack } from "../src/audit/pack.ts";
import { canonicalJson } from "../src/audit/schema.ts";
import {
  BENCHMARK_LIMITS, benchmarkPack, binomialMetric, loadBenchmarkFixtures, summarizeThreshold,
  type BenchmarkFixture, type BenchmarkFixtures, type BenchmarkSplit,
} from "../src/audit/benchmark.ts";
import { parseAuditBenchmarkOptions } from "../scripts/audit-benchmark.ts";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const route = "typesafe/test-model";
const sourceMarker = "PRIVATE_SOURCE_SENTINEL";
const questionMarker = "PRIVATE_QUESTION_SENTINEL";
function fixture(id: string, label: BenchmarkFixture["label"]): BenchmarkFixture {
  return { id, rule: "weakened-test", label, path: "test/example.test.ts", language: "typescript", state: `${sourceMarker} ${id}` };
}
function fixtureSet(cases: BenchmarkFixture[], split: BenchmarkSplit = "heldout"): BenchmarkFixtures {
  return { split, fixtures: cases, file_sha256: { calibration: sha("calibration"), heldout: sha("heldout") }, content_sha256: sha(canonicalJson(cases)) };
}
async function packDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sys1-audit-benchmark-"));
  temporary.push(root);
  const directory = join(root, "test-pack");
  await mkdir(join(directory, "fixtures"), { recursive: true });
  await writeFile(join(directory, "pack.yaml"), JSON.stringify({
    version: 1, pack: "test-pack", revision: "1", description: "Synthetic benchmark test pack", rules: [{
      id: "weakened-test", type: "noul", applies: { paths: ["**/*.ts"] },
      ensure: `${questionMarker} Tests retain meaningful assertions.`, breaks: "An assertion is removed without replacement.",
      tiers: { high: 0.85, medium: 0.6 },
    }],
  }));
  return directory;
}
async function benchmarkOptions(cases: BenchmarkFixture[], split: BenchmarkSplit = "heldout") {
  return { pack: await loadPack(await packDirectory(), "repo"), fixtures: fixtureSet(cases, split), route, maxRequests: 20, timeoutMs: 1_000 };
}
function fakeClient(scores: readonly number[]) {
  const calls: SystemOneRequest[] = [];
  const client: Sys1Client = { async evaluate(request) {
    calls.push(request);
    const score = scores[calls.length - 1] ?? 0;
    return {
      response: { model: "test-model", answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 1 - score }])),
        usage: { input_tokens: 100, output_tokens: 2 } }, metadata: { backend: "typesafe", attempts: 1 },
    };
  } };
  return { client, calls };
}

describe("audit benchmark statistics", () => {
  test("counts misses and false positives at frozen thresholds", () => {
    const summary = summarizeThreshold([
      { label: "violation", score: 0.95 }, { label: "violation", score: 0.2 },
      { label: "clean", score: 0.9 }, { label: "clean", score: 0.1 },
    ], 0.85);
    expect(summary).toMatchObject({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(summary.precision.value).toBe(0.5);
    expect(summary.recall.value).toBe(0.5);
    expect(summary.false_positive_rate.value).toBe(0.5);
  });

  test("zero predictions cannot claim perfect precision and all-clean cannot claim recall", () => {
    const missed = summarizeThreshold([{ label: "violation", score: 0 }, { label: "clean", score: 0 }], 0.85);
    expect(missed.precision).toEqual({ numerator: 0, denominator: 0, value: null, wilson95: null });
    expect(missed.recall).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    const clean = summarizeThreshold(Array.from({ length: 12 }, () => ({ label: "clean" as const, score: 0 })), 0.85);
    expect(clean.recall.value).toBeNull();
    expect(clean.false_positive_rate.wilson95![1]).toBeGreaterThan(0.24);
    expect(clean.false_positive_rate.wilson95![1]).toBeLessThan(0.25);
  });

  test("Wilson intervals include finite-sample uncertainty and reject invalid inputs", () => {
    expect(binomialMetric(5, 10).wilson95![0]).toBeCloseTo(0.236593, 5);
    expect(binomialMetric(5, 10).wilson95![1]).toBeCloseTo(0.763407, 5);
    expect(binomialMetric(10, 10).wilson95![0]).toBeLessThan(0.73);
    for (const pair of [[-1, 0], [1, 0], [0.5, 1], [0, NaN]]) expect(() => binomialMetric(pair[0]!, pair[1]!)).toThrow();
    expect(() => summarizeThreshold([{ label: "clean", score: NaN }], 0.5)).toThrow();
    expect(() => summarizeThreshold([], Infinity)).toThrow();
  });
});

describe("opt-in audit benchmark", () => {
  test("records complete heldout counts, identity, cost, and classification without leaking content or numeric answers", async () => {
    const options = await benchmarkOptions([fixture("true-positive", "violation"), fixture("false-positive", "clean"), fixture("missed", "violation")]);
    const fake = fakeClient([0.9, 0.7, 0.1]);
    const report = await benchmarkPack({ ...options, decider: fake.client });
    expect(report).toMatchObject({ status: "complete", complete: true, requests: 3, evaluated_fixtures: 3, qualification: "unqualified" });
    expect(report.usage).toEqual({ input_tokens: 300, output_tokens: 6, known_requests: 3, unknown_requests: 0 });
    expect(report.rules[0]!.high).toMatchObject({ tp: 1, fp: 0, tn: 1, fn: 1 });
    expect(report.rules[0]!.at_least_medium).toMatchObject({ tp: 1, fp: 1, tn: 0, fn: 1 });
    expect(report.rules[0]!.support).toMatchObject({ planned: 3, evaluated: 3, clean: 1, violations: 2, below_minimum: true });
    expect(report.rules[0]).not.toHaveProperty("calibration_thresholds");
    expect(report.latency_ms.attempts).toBe(3);
    expect(report.latency_ms.p95).toBeGreaterThanOrEqual(report.latency_ms.p50!);
    expect(report.cases.map(item => item.tier)).toEqual(["high", "medium", "low"]);
    expect(report.cases.every(item => item.request_sha256.every(hash => /^[a-f0-9]{64}$/.test(hash)))).toBe(true);
    expect(report.fixture_sha256).toEqual(options.fixtures.file_sha256);
    expect(fake.calls.every(call => call.model === route)).toBe(true);
    const output = JSON.stringify(report);
    for (const marker of [sourceMarker, questionMarker, '"answers"', '"state"', '"score":']) expect(output).not.toContain(marker);
  });

  test("calibration exposes aggregate threshold sweeps without selecting thresholds", async () => {
    const options = await benchmarkOptions([fixture("one", "violation"), fixture("two", "clean")], "calibration");
    const report = await benchmarkPack({ ...options, decider: fakeClient([0.8, 0.7]).client });
    expect(report.rules[0]!.calibration_thresholds).toHaveLength(8);
    expect(report.rules[0]!.high.threshold).toBe(0.85);
    expect(report.rules[0]!.at_least_medium.threshold).toBe(0.6);
    expect(JSON.stringify(report)).not.toContain('"selected_threshold"');
  });

  test("batches all applicable pack questions while grading only the labeled rule", async () => {
    const options = await benchmarkOptions([fixture("one", "violation")]);
    const target = options.pack.rules[0]!;
    const extra = { ...target, id: "second-rule" };
    const fake = fakeClient([0.9]);
    const report = await benchmarkPack({ ...options, pack: { ...options.pack, rules: [target, extra] }, decider: fake.client });
    expect(fake.calls).toHaveLength(1);
    expect(Object.keys(fake.calls[0]!.questions)).toEqual(["weakened-test", "second-rule"]);
    expect(report.questions).toBe(2);
    expect(report.rules[0]!.support.evaluated).toBe(1);
    expect(report.rules[1]!.support.evaluated).toBe(0);
    expect(report.rules[1]!.high.precision.value).toBeNull();
  });

  test("stops before the hard request cap and never counts skipped fixtures as clean", async () => {
    const options = await benchmarkOptions([fixture("one", "violation"), fixture("two", "clean"), fixture("three", "violation")]);
    const fake = fakeClient([0.9, 0.1, 0.9]);
    const report = await benchmarkPack({ ...options, decider: fake.client, maxRequests: 1 });
    expect(fake.calls).toHaveLength(1);
    expect(report).toMatchObject({ status: "incomplete", requests: 1, planned_requests: 3, evaluated_fixtures: 1 });
    expect(report.cases.map(item => item.status)).toEqual(["evaluated", "request_limit", "request_limit"]);
    expect(report.rules[0]!.high).toMatchObject({ tp: 1, fp: 0, tn: 0, fn: 0 });
  });

  test("provider failure is incomplete, sanitized, and never retried", async () => {
    const options = await benchmarkOptions([fixture("one", "violation"), fixture("two", "clean")]);
    let calls = 0;
    const report = await benchmarkPack({ ...options, decider: { async evaluate() { calls++; throw new Error(`${sourceMarker} TYPESAFE_API_KEY=sentinel`); } } });
    expect(calls).toBe(1);
    expect(report).toMatchObject({ complete: false, requests: 1, evaluated_fixtures: 0 });
    expect(report.usage).toMatchObject({ known_requests: 0, unknown_requests: 1 });
    expect(report.cases.every(item => item.status === "backend_error")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(sourceMarker);
    expect(JSON.stringify(report)).not.toContain("TYPESAFE_API_KEY");
  });

  test("rejects mismatched model, backend, retries, and answer shape", async () => {
    const options = await benchmarkOptions([fixture("one", "violation")]);
    const mutations: ((result: EvaluationResult) => void)[] = [
      result => { result.response.model = "different-model"; },
      result => { result.metadata.backend = "other"; },
      result => { result.metadata.attempts = 2; },
      result => { result.response.answers = {}; },
      result => { result.response.answers["weakened-test"] = { type: "noul", noul: 2 }; },
    ];
    for (const mutate of mutations) {
      const fake = fakeClient([0.9]);
      const report = await benchmarkPack({ ...options, decider: { async evaluate(request) { const result = await fake.client.evaluate(request); mutate(result); return result; } } });
      expect(report).toMatchObject({ complete: false, requests: 1, evaluated_fixtures: 0 });
      expect(report.cases[0]!.status).toBe("backend_error");
    }
  });

  test("deadline bounds even a hung injected decider; cancellation makes zero requests", async () => {
    const options = await benchmarkOptions([fixture("one", "violation"), fixture("two", "clean")]);
    let receivedSignal: AbortSignal | undefined;
    const report = await benchmarkPack({ ...options, timeoutMs: 15, decider: { evaluate(_request, evaluation) { receivedSignal = evaluation?.signal; return new Promise(() => {}); } } });
    expect(report).toMatchObject({ status: "incomplete", requests: 1, evaluated_fixtures: 0 });
    expect(report.cases.every(item => item.status === "deadline")).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    const controller = new AbortController(); controller.abort();
    const fake = fakeClient([0.9]);
    const cancelled = await benchmarkPack({ ...options, signal: controller.signal, decider: fake.client });
    expect(fake.calls).toHaveLength(0);
    expect(cancelled.cases.every(item => item.status === "cancelled")).toBe(true);
  });

  test("validate-only performs no requests and rejects changed or inapplicable fixture evidence", async () => {
    const options = await benchmarkOptions([fixture("one", "violation")]);
    const fake = fakeClient([0.9]);
    expect(await benchmarkPack({ ...options, decider: fake.client, validateOnly: true })).toMatchObject({ status: "planned", requests: 0, planned_requests: 1 });
    expect(fake.calls).toHaveLength(0);
    options.fixtures.fixtures[0]!.state = "mutated";
    await expect(benchmarkPack({ ...options, decider: fake.client })).rejects.toThrow("changed benchmark fixture set");
    const unmatched = { ...fixture("unmatched", "clean"), path: "readme.md" };
    await expect(benchmarkPack({ ...options, fixtures: fixtureSet([unmatched]), decider: fake.client })).rejects.toThrow("does not apply");
  });
});

describe("benchmark fixture boundary and CLI", () => {
  test("loads bounded JSONL with hashes and rejects cross-split duplicates", async () => {
    const dir = await packDirectory();
    const calibration = fixture("calibration-one", "clean"), heldout = fixture("heldout-one", "violation");
    await writeFile(join(dir, "fixtures", "calibration.jsonl"), JSON.stringify(calibration) + "\n");
    await writeFile(join(dir, "fixtures", "heldout.jsonl"), JSON.stringify(heldout) + "\n");
    const loaded = await loadBenchmarkFixtures(dir, "heldout");
    expect(loaded.fixtures).toEqual([heldout]);
    expect(loaded.file_sha256.heldout).toBe(sha(JSON.stringify(heldout) + "\n"));
    await writeFile(join(dir, "fixtures", "heldout.jsonl"), JSON.stringify({ ...heldout, state: calibration.state }));
    await expect(loadBenchmarkFixtures(dir, "heldout")).rejects.toThrow("no cross-split state overlap");
  });

  test("rejects unknown fixture fields, excessive bytes, symlinks, and duplicate IDs", async () => {
    const dir = await packDirectory();
    const calibration = fixture("calibration-one", "clean"), heldout = fixture("heldout-one", "violation");
    const heldoutFile = join(dir, "fixtures", "heldout.jsonl");
    await writeFile(join(dir, "fixtures", "calibration.jsonl"), JSON.stringify(calibration));
    for (const value of [JSON.stringify({ ...heldout, extra: true }), " ".repeat(BENCHMARK_LIMITS.maxFileBytes + 1),
      JSON.stringify({ ...heldout, id: calibration.id }), JSON.stringify(heldout) + "\n" + JSON.stringify(heldout)]) {
      await writeFile(heldoutFile, value);
      await expect(loadBenchmarkFixtures(dir, "heldout")).rejects.toThrow();
    }
    await rm(heldoutFile);
    await symlink(join(dir, "fixtures", "calibration.jsonl"), heldoutFile);
    await expect(loadBenchmarkFixtures(dir, "heldout")).rejects.toThrow();
  });

  test("requires explicit route, split, request cap and deadline, with no threshold override", () => {
    const required = ["--pack", "test", "--route", route, "--split", "heldout", "--max-requests", "20", "--timeout-ms", "1000"];
    expect(parseAuditBenchmarkOptions(required)).toMatchObject({ route, split: "heldout", maxRequests: 20, timeoutMs: 1000, validateOnly: false });
    expect(parseAuditBenchmarkOptions([...required, "--validate-only"])).toHaveProperty("validateOnly", true);
    for (const args of [[], required.slice(0, -2), [...required, "--threshold", "0.1"], [...required, "--split", "calibration"],
      required.map(value => value === route ? "unpinned" : value), required.map(value => value === "20" ? "0" : value),
      required.map(value => value === "1000" ? "1e3" : value)]) expect(() => parseAuditBenchmarkOptions(args)).toThrow();
  });
});
