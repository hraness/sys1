import { describe, expect, test } from "bun:test";
import { configSchema, localBackendSchema } from "../src/config.ts";
import { probeBackend, runtimeBackends } from "../src/backends.ts";
import {
  NIMBLE_LOCAL_PROFILE,
  qualifyBackend,
  resolveBackendProfile,
} from "../src/providers.ts";

const VALID_RESPONSE = {
  model: "bespokelabs/Bespoke-Nimble-9B",
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
      return Response.json(
        options.models ?? {
          data: [
            { id: "nimble-latest" },
            { id: "bespokelabs/Bespoke-Nimble-9B" },
          ],
        },
      );
    }
    if (url.endsWith("/v1/limits")) {
      const status = options.limitsStatus ?? 200;
      return Response.json(
        options.limits ?? { max_answers_per_question: 26, max_questions: 64 },
        { status },
      );
    }
    if (url.endsWith("/v1/systemone")) {
      return Response.json(options.response ?? VALID_RESPONSE);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe("nimble-local backend profile", () => {
  test("resolves pinned local defaults", () => {
    const resolved = resolveBackendProfile("nimble-local");
    expect(resolved).toEqual({ ok: true, backend: NIMBLE_LOCAL_PROFILE.backend });
  });

  test("allows loopback name and URL overrides", () => {
    const resolved = resolveBackendProfile("nimble-local", {
      name: "nimble-gpu",
      base_url: "http://127.0.0.2:18000",
    });
    expect(resolved).toMatchObject({
      ok: true,
      backend: {
        name: "nimble-gpu",
        base_url: "http://127.0.0.2:18000",
        model: "nimble-latest",
        capabilities: { max_options: 26, max_questions: 64 },
      },
    });
    expect(
      resolveBackendProfile("nimble-local", { base_url: "http://[::1]:8000" }),
    ).toMatchObject({ ok: true });
  });

  test("rejects remote, credential-bearing, and unknown profiles", () => {
    expect(
      resolveBackendProfile("nimble-local", { base_url: "https://example.com" }),
    ).toMatchObject({ ok: false });
    expect(
      resolveBackendProfile("nimble-local", { base_url: "http://user:pass@127.0.0.1:8000" }),
    ).toMatchObject({ ok: false });
    expect(resolveBackendProfile("unknown")).toMatchObject({ ok: false });
  });

  test("configured caps become router capabilities before a live probe", () => {
    const config = configSchema.parse({
      version: 1,
      hosted: { enabled: false },
      backends: [NIMBLE_LOCAL_PROFILE.backend],
    });
    expect(runtimeBackends(config, {} as NodeJS.ProcessEnv)[0]?.capabilities).toEqual({
      maxOptions: 26,
      maxQuestions: 64,
    });
  });

  test("published limits may narrow but never widen profile caps", async () => {
    const config = configSchema.parse({
      version: 1,
      hosted: { enabled: false },
      backends: [NIMBLE_LOCAL_PROFILE.backend],
    });
    const wide = runtimeBackends(config, {} as NodeJS.ProcessEnv)[0];
    if (wide === undefined) throw new Error("missing runtime backend");
    await probeBackend(
      wide,
      1_000,
      stubFetch({ limits: { max_answers_per_question: 100, max_questions: 64 } }).fetchFn,
    );
    expect(wide.capabilities).toEqual({ maxOptions: 26, maxQuestions: 64 });

    const narrow = runtimeBackends(config, {} as NodeJS.ProcessEnv)[0];
    if (narrow === undefined) throw new Error("missing runtime backend");
    await probeBackend(
      narrow,
      1_000,
      stubFetch({ limits: { max_answers_per_question: 8, max_questions: 32 } }).fetchFn,
    );
    expect(narrow.capabilities).toEqual({ maxOptions: 8, maxQuestions: 32 });
  });
});

describe("backend qualification", () => {
  const backend = localBackendSchema.parse(NIMBLE_LOCAL_PROFILE.backend);

  test("checks model identity, limits, and all answer types", async () => {
    const stub = stubFetch();
    const report = await qualifyBackend(backend, {
      probeTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      fetchFn: stub.fetchFn,
    });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      { id: "models", status: "pass", summary: "backend serves nimble-latest" },
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
    expect(sent.model).toBe("nimble-latest");
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

  test("fails when published limits are below the profile caps", async () => {
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
      fetchFn: stubFetch({ response: { model: "nimble-latest", answers: {} } }).fetchFn,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[2]).toMatchObject({ id: "systemone", status: "fail" });
  });

  test("missing limits only warns for an unbounded generic backend", async () => {
    const generic = localBackendSchema.parse({
      name: "generic",
      base_url: "http://127.0.0.1:9000",
      model: "nimble-latest",
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
