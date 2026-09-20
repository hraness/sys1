import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_MODEL, JEV_ORIGIN, parseBenchmarkOptions, runJevBenchmark } from "../scripts/benchmark-jev.ts";
import { loadFixture, requestFor } from "../scripts/benchmark-local.ts";
import type { SystemOneRequest } from "../src/protocol.ts";

const fakeKey = "offline-test-key-must-not-persist";
const env = { TYPESAFE_API_KEY: fakeKey };
const fixture = loadFixture();
function validBody(request: SystemOneRequest, model = JEV_MODEL) {
  const item = fixture.cases.find((entry) => entry.state === request.state)!;
  return {
    model,
    answers: { action: {
      type: "choice", choice: item.expected, confidence: 1,
      probabilities: Object.fromEntries(item.option_order.map((option) => [option, option === item.expected ? 1 : 0])),
    } },
    usage: { input_tokens: 100, output_tokens: 0 },
  };
}

async function inOutput<T>(run: (output: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "sys1-jev-benchmark-test-"));
  try { return await run(join(directory, "report.json")); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("opt-in hosted Jev synthetic benchmark", () => {
  test("requires explicit public run metadata and rejects endpoint/model overrides", () => {
    expect(parseBenchmarkOptions(["--validate-only"])).toBeNull();
    expect(() => parseBenchmarkOptions([])).toThrow("explicit");
    expect(() => parseBenchmarkOptions(["--output", "/tmp/result.json"])).toThrow("explicit");
    expect(() => parseBenchmarkOptions(["--output", "/tmp/result.json", "--region", "US east", "--endpoint", "https://other.example"])).toThrow("usage");
    expect(() => parseBenchmarkOptions(["--output", "/tmp/result.json", "--region", "US east", "--model", "jev-latest"])).toThrow("usage");
    expect(() => parseBenchmarkOptions(["--output", "/tmp/result.json", "--region", "private\nmetadata"])).toThrow("explicit");
  });

  test("sends precisely the fixed fixture and model only to the pinned origin, counting warmups separately", () => inOutput(async (output) => {
    const requests: SystemOneRequest[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${JEV_ORIGIN}/v1/systemone`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fakeKey}`);
      const request = JSON.parse(String(init?.body)) as SystemOneRequest;
      requests.push(request);
      return Response.json({ ...validBody(request), ignored_provider_metadata: fakeKey });
    }) as typeof fetch;
    const report = await runJevBenchmark({ output, region: "offline test" }, { fetchFn, env });
    expect(report.status).toBe("complete");
    expect(requests).toHaveLength(105);
    expect(requests.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => requestFor(fixture, fixture.cases[0]!, JEV_MODEL)));
    expect(requests.slice(3, 5)).toEqual(fixture.cases.slice(0, 2).map((item) => requestFor(fixture, item, JEV_MODEL)));
    for (let repetition = 0; repetition < 5; repetition += 1) {
      expect(requests.slice(5 + repetition * 20, 25 + repetition * 20)).toEqual(fixture.cases.map((item) => requestFor(fixture, item, JEV_MODEL)));
    }
    expect(report.summary).toMatchObject({
      attempted_calls: 105, skipped_calls: 0, repeated_attempts: 100, repeated_valid: 100,
      unique_first_pass_cases: 20, unique_first_pass_correct: 20,
      repeated_reported_input_tokens: 10_000, repeated_reported_output_tokens: 0,
      all_calls_usage: { calls_with_validated_usage: 105, reported_input_tokens: 10_500, reported_output_tokens: 0 },
      unknown_billing_calls: 0,
    });
    expect(report.summary!.estimated_known_input_cost_usd).toBeCloseTo(10_500 * 0.042 / 1_000_000, 10);
    expect(report.source.fixture_sha256).toMatch(/^[a-f0-9]{64}$/);
    const saved = readFileSync(output, "utf8");
    expect(JSON.parse(saved)).toEqual(report);
    expect(saved).not.toContain(fakeKey);
    expect(saved).not.toContain("ignored_provider_metadata");
  }));

  test("missing/invalid usage and a different returned model are invalid, never zero-token successes", () => inOutput(async (output) => {
    let calls = 0;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body: Record<string, unknown> = validBody(JSON.parse(String(init?.body)) as SystemOneRequest);
      if (calls === 1) delete body["usage"];
      else if (calls === 2) body["usage"] = { input_tokens: -1, output_tokens: 0 };
      else body["model"] = "jev-latest";
      return Response.json(body);
    }) as typeof fetch;
    const report = await runJevBenchmark({ output, region: "offline test" }, { fetchFn, env });
    expect(calls).toBe(3);
    expect(report.status).toBe("stopped_after_errors");
    expect(report.samples.map((sample) => sample.error)).toEqual(["invalid_response", "invalid_response", "invalid_response"]);
    expect(report.samples.every((sample) => sample.response === null && !sample.schema_valid)).toBe(true);
    expect(report.samples[2]!.returned_model).toBe("jev-latest");
    expect(report.summary).toMatchObject({
      skipped_calls: 102, repeated_reported_input_tokens: null, repeated_reported_output_tokens: null,
      all_calls_usage: { calls_with_validated_usage: 0, calls_without_validated_usage: 3, reported_input_tokens: null, reported_output_tokens: null },
      estimated_known_input_cost_usd: null, unknown_billing_calls: 3,
    });
  }));

  test("never follows redirects or retries failed attempts, and excludes error bodies/headers", () => inOutput(async (output) => {
    let calls = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      expect(String(input)).toBe(`${JEV_ORIGIN}/v1/systemone`);
      expect(init?.redirect).toBe("manual");
      if (calls === 1) return new Response(fakeKey, { status: 307, headers: { location: "https://other.example/", "x-secret": fakeKey } });
      if (calls === 2) throw new Error(fakeKey);
      return new Response(fakeKey, { status: 429, headers: { "retry-after": "0", "x-secret": fakeKey } });
    }) as typeof fetch;
    const report = await runJevBenchmark({ output, region: "offline test" }, { fetchFn, env });
    expect(calls).toBe(3);
    expect(report.status).toBe("stopped_after_errors");
    expect(report.samples.map((sample) => sample.http_status)).toEqual([307, null, 429]);
    expect(report.samples.map((sample) => sample.error)).toEqual(["http_error", "transport_error", "http_error"]);
    expect(readFileSync(output, "utf8")).not.toContain(fakeKey);
    expect(readFileSync(output, "utf8")).not.toContain("other.example");
  }));

  test("rejected model identities cannot copy arbitrary provider text into the report", () => inOutput(async (output) => {
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(validBody(JSON.parse(String(init?.body)) as SystemOneRequest, fakeKey))) as typeof fetch;
    const report = await runJevBenchmark({ output, region: "offline test" }, { fetchFn, env });
    expect(report.status).toBe("stopped_after_errors");
    expect(report.samples.every((sample) => sample.returned_model === null && sample.error === "invalid_response")).toBe(true);
    expect(readFileSync(output, "utf8")).not.toContain(fakeKey);
  }));

  test("valid but incorrect responses reset the consecutive-error stop rule", () => inOutput(async (output) => {
    let calls = 0;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if ([1, 2, 4, 5].includes(calls)) return new Response("unavailable", { status: 503 });
      const request = JSON.parse(String(init?.body)) as SystemOneRequest;
      const body = validBody(request);
      const wrong = Object.keys(body.answers.action.probabilities).find((option) => option !== body.answers.action.choice)!;
      body.answers.action.choice = wrong as typeof body.answers.action.choice;
      body.answers.action.probabilities = Object.fromEntries(Object.keys(body.answers.action.probabilities).map((option) => [option, option === wrong ? 1 : 0]));
      return Response.json(body);
    }) as typeof fetch;
    const report = await runJevBenchmark({ output, region: "offline test" }, { fetchFn, env });
    expect(calls).toBe(105);
    expect(report.status).toBe("complete");
    expect(report.samples[2]).toMatchObject({ schema_valid: true, correct: false });
    expect(report.summary).toMatchObject({ unique_first_pass_cases: 20, unique_first_pass_correct: 0, unknown_billing_calls: 4 });
  }));

  test("cancellation during the complete-body read persists the attempt and starts no next request", () => inOutput(async (output) => {
    const cancellation = new AbortController();
    let calls = 0;
    let released = false;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":'));
          cancellation.abort();
        },
        cancel() { released = true; },
      }, { highWaterMark: 0 }));
    }) as unknown as typeof fetch;
    const report = await runJevBenchmark({ output, region: "offline test" }, { fetchFn, env, signal: cancellation.signal });
    expect(calls).toBe(1);
    expect(released).toBe(true);
    expect(report.status).toBe("interrupted");
    expect(report.samples[0]).toMatchObject({ schema_valid: false, response: null, error: "cancelled" });
    expect(report.summary).toMatchObject({ attempted_calls: 1, skipped_calls: 104, unknown_billing_calls: 1 });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
  }));

  test("rejects missing environment credential and never overwrites earlier results", () => inOutput(async (output) => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; throw new Error("must not call"); }) as unknown as typeof fetch;
    await expect(runJevBenchmark({ output, region: "offline test" }, { fetchFn, env: {} })).rejects.toThrow("TYPESAFE_API_KEY");
    writeFileSync(output, "earlier result\n");
    await expect(runJevBenchmark({ output, region: "offline test" }, { fetchFn, env })).rejects.toThrow();
    expect(readFileSync(output, "utf8")).toBe("earlier result\n");
    expect(calls).toBe(0);
  }));
});
