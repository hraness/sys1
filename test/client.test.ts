import { describe, expect, test } from "bun:test";
import { createClient, Sys1ClientError, type SystemOneRequest } from "../src/client.ts";

const request: SystemOneRequest = { state: "private state", questions: { urgent: { type: "noul" } } };
const answer = { model: "test-model", answers: { urgent: { type: "noul" as const, noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 0 } };

function stub(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return fn as typeof fetch;
}

describe("Sys1 client", () => {
  test("uses only the default loopback and preserves adapter metadata", async () => {
    let calls = 0;
    const client = createClient({ fetch: stub((url, init) => {
      calls++;
      expect(url).toBe("http://127.0.0.1:13900/v1/systemone");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return Response.json(answer, { headers: {
        "x-sys1-backend": "local-small",
        "x-sys1-attempts": "1",
        "x-sys1-local-adapter": "generic-gguf",
        "x-sys1-local-min-coverage": "0.250",
        "x-sys1-local-min-concentration": "0.500",
      } });
    }) });
    expect(await client.evaluate(request)).toEqual({ response: answer, metadata: {
      backend: "local-small", attempts: 1,
      local: { adapter: "generic-gguf", minCoverage: 0.25, minConcentration: 0.5 },
    } });
    expect(calls).toBe(1);
  });

  test("supports an explicit direct endpoint and copied auth headers", async () => {
    const headers = new Headers({ Authorization: "Bearer explicit-key" });
    const client = createClient({ baseUrl: "https://example.invalid/prefix/", headers, fetch: stub((url, init) => {
      expect(url).toBe("https://example.invalid/prefix/v1/systemone");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit-key");
      return Response.json(answer);
    }) });
    headers.set("authorization", "mutated");
    expect((await client.evaluate(request)).metadata).toEqual({});
  });

  test("rejects invalid options without exposing credentials", () => {
    for (const options of [
      { baseUrl: "file:///private" }, { baseUrl: "https://secret:password@example.invalid" },
      { baseUrl: "https://example.invalid/?key=secret" }, { timeoutMs: 0 }, { timeoutMs: 300_001 },
      { headers: { authorization: "secret".repeat(4_000) } },
    ]) {
      expect(() => createClient(options)).toThrow("Invalid Sys1 client options");
    }
  });

  test("bounds and validates requests before network access", async () => {
    let calls = 0;
    const client = createClient({ fetch: stub(() => { calls++; return Response.json(answer); }) });
    const invalid = [
      { ...request, questions: {} },
      { ...request, state: "x".repeat(262_145) },
      { ...request, state: "x".repeat(1_048_577) },
      { ...request, questions: { urgent: { type: "other" } } },
    ];
    for (const input of invalid) {
      await expect(client.evaluate(input as SystemOneRequest)).rejects.toMatchObject({ code: "invalid_request" });
    }
    const cyclic = { ...request };
    cyclic.state = cyclic as unknown as SystemOneRequest["state"];
    await expect(client.evaluate(cyclic)).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toBe(0);
  });

  test("rejects malformed, missing, extra, and wrong-type answers", async () => {
    const invalid = [
      "not JSON private data",
      JSON.stringify({ ...answer, usage: undefined }),
      JSON.stringify({ ...answer, answers: {} }),
      JSON.stringify({ ...answer, answers: { another: answer.answers.urgent } }),
      JSON.stringify({ ...answer, answers: { ...answer.answers, another: answer.answers.urgent } }),
      JSON.stringify({ ...answer, answers: { urgent: { type: "noul", noul: 2 } } }),
      JSON.stringify({ ...answer, answers: { urgent: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 } } }),
    ];
    for (const body of invalid) {
      await expect(createClient({ fetch: stub(() => new Response(body)) }).evaluate(request))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  test("correlates choice options with the request", async () => {
    const input: SystemOneRequest = { state: null, questions: { q: { type: "choice", criteria: { a: "first", b: "second" } } } };
    for (const probabilities of [{ a: 1 }, { a: 0.5, c: 0.5 }]) {
      const response = { ...answer, answers: { q: { type: "choice", choice: "a", probabilities, confidence: 0.8 } } };
      await expect(createClient({ fetch: stub(() => Response.json(response)) }).evaluate(input))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
    const response = { ...answer, answers: { q: { type: "choice" as const, choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.8 } } };
    expect((await createClient({ fetch: stub(() => Response.json(response)) }).evaluate(input)).response).toEqual(response);
  });

  test("correlates score levels and legends while accepting object key reordering", async () => {
    const input: SystemOneRequest = { state: null, questions: { q: { type: "score", criteria: [{ first: 1, second: 2 }, "high"] } } };
    const valid = { ...answer, answers: { q: { type: "score" as const, score: 0.8, legend: { "0": { second: 2, first: 1 }, "1": "high" }, probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.8 } } };
    expect((await createClient({ fetch: stub(() => Response.json(valid)) }).evaluate(input)).response).toEqual(valid);
    const invalid = { ...valid, answers: { q: { ...valid.answers.q, legend: { "0": "different", "1": "high" } } } };
    await expect(createClient({ fetch: stub(() => Response.json(invalid)) }).evaluate(input))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  test("rejects inconsistent distributions, choice selections, and score expectations", async () => {
    const choice: SystemOneRequest = { state: null, questions: { q: { type: "choice", criteria: { a: "first", b: "second" } } } };
    for (const probabilities of [{ a: 0.8, b: 0.8 }, { a: 0.2, b: 0.8 }]) {
      const response = { ...answer, answers: { q: { type: "choice", choice: "a", probabilities, confidence: 0.8 } } };
      await expect(createClient({ fetch: stub(() => Response.json(response)) }).evaluate(choice))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
    const score: SystemOneRequest = { state: null, questions: { q: { type: "score", criteria: ["low", "high"] } } };
    const response = { ...answer, answers: { q: { type: "score", score: 0.2, legend: { "0": "low", "1": "high" }, probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.8 } } };
    await expect(createClient({ fetch: stub(() => Response.json(response)) }).evaluate(score))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  test("accepts three-decimal rounding in normalized probabilities and scores", async () => {
    const input: SystemOneRequest = { state: null, questions: { q: { type: "score", criteria: ["low", "medium", "high"] } } };
    const response = { ...answer, answers: { q: { type: "score" as const, score: 1, legend: { "0": "low", "1": "medium", "2": "high" }, probabilities: { "0": 0.333, "1": 0.333, "2": 0.333 }, confidence: 0 } } };
    expect((await createClient({ fetch: stub(() => Response.json(response)) }).evaluate(input)).response).toEqual(response);
  });

  test("does not retry transport failures or expose raw errors", async () => {
    let calls = 0;
    try {
      await createClient({ fetch: stub(() => { calls++; throw new Error("Bearer private-key private state"); }) }).evaluate(request);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Sys1ClientError);
      expect(error).toMatchObject({ code: "transport_error", message: "Sys1 transport failed" });
      expect(JSON.stringify(error)).not.toContain("private");
      expect(error).not.toHaveProperty("cause");
    }
    expect(calls).toBe(1);
  });

  test("does not read or retry an HTTP error body", async () => {
    let cancelled = false;
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(createClient({ fetch: stub(() => {
      calls++;
      return new Response(body, { status: 429 });
    }) }).evaluate(request)).rejects.toMatchObject({ code: "http_error", status: 429 });
    expect(cancelled).toBe(true);
    expect(calls).toBe(1);
  });

  test("cancels responses that exceed the actual byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4_194_305)); },
      cancel() { cancelled = true; },
    });
    await expect(createClient({ fetch: stub(() => new Response(body)) }).evaluate(request))
      .rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  test("rejects pre-aborted calls without a network attempt", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error("private reason"));
    await expect(createClient({ fetch: stub(() => { calls++; return Response.json(answer); }) })
      .evaluate(request, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toBe(0);
  });

  test("bounds a transport that ignores cancellation", async () => {
    let calls = 0;
    const client = createClient({ timeoutMs: 10, fetch: stub(() => { calls++; return new Promise(() => undefined); }) });
    await expect(client.evaluate(request)).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toBe(1);
  });

  test("propagates caller cancellation and cancels the body", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const pending = createClient({ fetch: stub(() => new Response(body)) }).evaluate(request, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort("private abort reason"), 10);
    try {
      await expect(pending).rejects.toMatchObject({ code: "aborted", message: "Sys1 request aborted" });
      expect(cancelled).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  test("applies the timeout to the response body too", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(createClient({ timeoutMs: 10, fetch: stub(() => new Response(body)) }).evaluate(request))
      .rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(true);
  });

  test("rejects malformed routing metadata", async () => {
    await expect(createClient({ fetch: stub(() => Response.json(answer, { headers: { "x-sys1-attempts": "NaN" } })) })
      .evaluate(request)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
