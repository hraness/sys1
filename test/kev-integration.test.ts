import { describe, expect, test } from "bun:test";
import { createClient } from "../src/client.ts";
import { configSchema } from "../src/config.ts";
import { createRouter } from "../src/runtime.ts";
import { qualifyBackend } from "../src/qualification.ts";
import type { SystemOneRequest } from "../src/protocol.ts";

// Source-derived wire fixture: Kev e943f21 rounds each probability to two decimals.
const input: SystemOneRequest = {
  model: "kev-latest", state: "A synthetic support ticket",
  questions: {
    refund: { type: "noul" },
    department: { type: "choice", criteria: { billing: null, technical: null, sales: null } },
    urgency: { type: "score", criteria: ["low", "medium", "high"] },
  },
};
const output = {
  model: "kev-latest",
  answers: {
    refund: { type: "noul" as const, noul: 0.51 },
    department: { type: "choice" as const, choice: "billing", confidence: 0, probabilities: { billing: 0.33, technical: 0.33, sales: 0.33 } },
    urgency: { type: "score" as const, score: 1, confidence: 0.5, legend: { "0": "low", "1": "medium", "2": "high" }, probabilities: { "0": 0.33, "1": 0.33, "2": 0.33 } },
  },
  usage: { input_tokens: 30, output_tokens: 100 }, latency_ms: 12,
};

function nativeFixture(calls: SystemOneRequest[], status = 200): typeof fetch {
  return (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = String(target);
    if (url.endsWith("/v1/models")) return Response.json({ models: [{ id: "kev-latest", run: "/owned/checkpoint", base: "Qwen/base" }] });
    if (url.endsWith("/v1/limits")) return new Response(null, { status: 404 });
    const request = JSON.parse(String(init?.body)) as SystemOneRequest;
    calls.push(request);
    expect(request.model).toBe("kev-latest");
    for (const q of Object.values(request.questions)) expect(q.instructions).toBe(null);
    expect(init?.redirect).toMatch(/error|manual/);
    return Response.json(output, { status });
  }) as typeof fetch;
}

describe("explicit Kev integration", () => {
  test("the portable client adapts a direct Kev endpoint without changing its probabilities", async () => {
    const calls: SystemOneRequest[] = [];
    const client = createClient({ adapter: "kev", baseUrl: "http://127.0.0.1:8009", fetch: nativeFixture(calls) });
    const result = await client.evaluate(input);
    expect(calls).toHaveLength(1);
    expect(result.metadata).toEqual({ adapter: "kev", probabilityDecimals: 2 });
    expect(result.response.answers).toEqual(output.answers);
    expect(input.questions.refund?.instructions).toBeUndefined();
    expect(result.response).not.toHaveProperty("latency_ms");
  });

  test("embedded routing carries the explicit precision through its client and keeps the route pinned", async () => {
    const calls: SystemOneRequest[] = [];
    const router = createRouter({
      config: configSchema.parse({ version: 1, backends: [{ name: "kev", base_url: "http://127.0.0.1:8009", model: "kev-latest", adapter: "kev" }] }),
      env: {}, fetchFn: nativeFixture(calls),
    });
    try {
      const result = await router.evaluate({ ...input, model: "kev/kev-latest" });
      expect(result.response.answers).toEqual(output.answers);
      expect(result.metadata).toEqual({ backend: "kev", attempts: 1, adapter: "kev", probabilityDecimals: 2 });
      const models = await (await router.fetch(new Request("http://embedded/v1/models"))).json();
      expect(models.data[0]).toMatchObject({ adapter: "kev", explicit_only: true });
      const { model: _model, ...unpinned } = input;
      await expect(router.evaluate(unpinned)).rejects.toMatchObject({ code: "http_error", status: 503 });
      expect(calls).toHaveLength(1);
    } finally { await router.dispose(); }
  });

  test("ordinary clients retain strict rounding checks and reject partial precision metadata", async () => {
    for (const headers of [{}, { "x-sys1-adapter": "kev" }, { "x-sys1-probability-decimals": "2" }, { "x-sys1-adapter": "kev", "x-sys1-probability-decimals": "1" }]) {
      const client = createClient({ fetch: (async () => Response.json(output, { headers })) as unknown as typeof fetch });
      await expect(client.evaluate(input)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  test("adding required Kev instructions cannot exceed the outgoing body limit", async () => {
    const calls: SystemOneRequest[] = [];
    const router = createRouter({
      config: configSchema.parse({ version: 1, backends: [{ name: "kev", base_url: "http://127.0.0.1:8009", model: "kev-latest", adapter: "kev" }] }),
      env: {}, fetchFn: nativeFixture(calls),
    });
    const criteria = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o${i}`, "x".repeat(1024)]));
    const questions = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`q${i}`, { type: "choice", criteria }]));
    const request = { model: "kev/kev-latest", state: "", questions };
    request.state = "x".repeat(1_048_576 - JSON.stringify(request).length);
    expect(JSON.stringify(request).length).toBe(1_048_576);
    expect(JSON.stringify(request.state).length).toBeLessThan(262_144);
    try {
      const response = await router.fetch(new Request("http://embedded/v1/systemone", { method: "POST", body: JSON.stringify(request) }));
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { type: "request_too_large" } });
      expect(calls).toHaveLength(0);
    } finally { await router.dispose(); }
  });

  test("an HTTP error from Kev is definitive", async () => {
    const calls: SystemOneRequest[] = [];
    const router = createRouter({
      config: configSchema.parse({ version: 1, backends: [{ name: "kev", base_url: "http://127.0.0.1:8009", model: "kev-latest", adapter: "kev" }] }),
      env: {}, fetchFn: nativeFixture(calls, 422),
    });
    try {
      await expect(router.evaluate({ ...input, model: "kev/kev-latest" })).rejects.toMatchObject({ code: "http_error", status: 422 });
      expect(calls).toHaveLength(1);
    } finally { await router.dispose(); }
  });

  test("qualification accepts Kev rounding while reporting its missing limits", async () => {
    const fetchFn = (async (target: RequestInfo | URL, init?: RequestInit) => {
      if (String(target).endsWith("/v1/models")) return Response.json({ models: [{ id: "kev-latest" }] });
      if (String(target).endsWith("/v1/limits")) return new Response(null, { status: 404 });
      const request = JSON.parse(String(init?.body)) as SystemOneRequest;
      const response = structuredClone(output);
      response.answers.department = { type: "choice", choice: "billing", confidence: 0.2, probabilities: { billing: 0.6, technical: 0.4 } } as typeof response.answers.department;
      const question = request.questions.urgency!;
      if (question.type !== "score") throw new Error("expected score");
      response.answers.urgency.legend = Object.fromEntries(question.criteria.map((value, i) => [String(i), value])) as typeof response.answers.urgency.legend;
      return Response.json(response);
    }) as typeof fetch;
    const backend = configSchema.parse({ version: 1, backends: [{ name: "kev", base_url: "http://127.0.0.1:8009", model: "kev-latest", adapter: "kev" }] }).backends[0]!;
    const report = await qualifyBackend(backend, { probeTimeoutMs: 1000, requestTimeoutMs: 1000, fetchFn });
    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "limits", status: "warn" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "systemone", status: "pass" }));
  });
});
