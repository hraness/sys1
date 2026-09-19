import { describe, expect, test } from "bun:test";
import { localBackendSchema } from "../src/config.ts";
import { qualifyBackend } from "../src/qualification.ts";

const VALID_RESPONSE = {
  model: "systemone-local",
  answers: {
    refund: { type: "noul", noul: 0.9 },
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.8, technical: 0.2 },
      confidence: 0.6,
    },
    urgency: {
      type: "score",
      score: 0.5,
      legend: {
        "0": "no active impact",
        "1": "limited impact",
        "2": "critical outage",
      },
      probabilities: { "0": 0.6, "1": 0.3, "2": 0.1 },
      confidence: 0.4,
    },
  },
  usage: { input_tokens: 300, output_tokens: 4 },
};

interface StubOptions {
  models?: unknown;
  limits?: unknown;
  response?: unknown;
  limitsStatus?: number;
}

function stubFetch(options: StubOptions = {}): {
  fetchFn: typeof fetch;
  requests: { url: string; init: RequestInit | undefined }[];
} {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    if (url.endsWith("/v1/models")) {
      return Response.json(options.models ?? { data: [{ id: "systemone-local" }] });
    }
    if (url.endsWith("/v1/limits")) {
      return Response.json(
        options.limits ?? { max_answers_per_question: 26, max_questions: 64 },
        { status: options.limitsStatus ?? 200 },
      );
    }
    if (url.endsWith("/v1/systemone")) {
      return Response.json(options.response ?? VALID_RESPONSE);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fetchFn, requests };
}

const backend = localBackendSchema.parse({
  name: "local-service",
  base_url: "http://127.0.0.1:18080",
  model: "systemone-local",
  capabilities: { max_options: 26, max_questions: 64 },
});

describe("backend qualification", () => {
  test("checks model identity, limits, and all answer types", async () => {
    const stub = stubFetch();
    const report = await qualifyBackend(backend, {
      probeTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      fetchFn: stub.fetchFn,
    });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      { id: "models", status: "pass", summary: "backend serves systemone-local" },
      { id: "limits", status: "pass", summary: "limits published · 26 options · 64 questions" },
      { id: "systemone", status: "pass", summary: "noul, choice, and score response is conformant" },
    ]);
    expect(stub.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/models",
      "/v1/limits",
      "/v1/systemone",
    ]);
    const raw = stub.requests[2]?.init?.body;
    expect(typeof raw).toBe("string");
    const sent = JSON.parse(raw as string) as { model: string; questions: Record<string, unknown> };
    expect(sent.model).toBe("systemone-local");
    expect(Object.keys(sent.questions)).toEqual(["refund", "department", "urgency"]);
    expect(JSON.stringify(report)).not.toContain("charged twice");
    expect(JSON.stringify(report)).not.toContain("billing\":0.8");
  });

  test("fails when the configured model is not advertised", async () => {
    const report = await qualifyBackend(backend, {
      probeTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      fetchFn: stubFetch({ models: { data: [{ id: "other" }] } }).fetchFn,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "models", status: "fail" });
  });

  test("fails when published limits are below configured caps", async () => {
    const report = await qualifyBackend(backend, {
      probeTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      fetchFn: stubFetch({ limits: { max_answers_per_question: 8, max_questions: 64 } }).fetchFn,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[1]).toMatchObject({ id: "limits", status: "fail" });
  });

  test("fails closed on a malformed System One response", async () => {
    const report = await qualifyBackend(backend, {
      probeTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      fetchFn: stubFetch({ response: { model: "systemone-local", answers: {} } }).fetchFn,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[2]).toMatchObject({ id: "systemone", status: "fail" });
  });

  test("missing limits only warns for an unbounded backend", async () => {
    const generic = localBackendSchema.parse({
      name: "generic",
      base_url: "http://127.0.0.1:9000",
      model: "systemone-local",
    });
    const report = await qualifyBackend(generic, {
      probeTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      fetchFn: stubFetch({ limitsStatus: 404 }).fetchFn,
    });
    expect(report.ok).toBe(true);
    expect(report.checks[1]).toMatchObject({ id: "limits", status: "warn" });
  });
});
