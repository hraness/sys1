import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type Sys1Config } from "../src/config.ts";
import { createFetchHandler, startGateway } from "../src/gateway.ts";
import type { DecisionEngine, FirstTokenDistribution } from "../src/local/engine.ts";
import { LocalRunner } from "../src/local/runner.ts";
import { loadManifest, manifestPath, modelsDir, saveManifest } from "../src/local/store.ts";

const VALID_BODY = JSON.stringify({
  state: "Help! My payouts have been failing for 3 days.",
  questions: {
    urgent: { type: "noul", instructions: "Does this convey urgency?" },
  },
});

const JEV_ANSWER = JSON.stringify({
  model: "jev-1.13.0",
  answers: { urgent: { type: "noul", noul: 0.91 } },
  usage: { input_tokens: 40, output_tokens: 8 },
});

const LOCAL_ANSWER = JSON.stringify({
  model: "openjev-4b",
  answers: { urgent: { type: "noul", noul: 0.88 } },
  usage: { input_tokens: 40, output_tokens: 8 },
});

interface StubOptions {
  hostedUp?: boolean;
  localUp?: boolean;
  localModels?: string[];
  limits?: { max_answers_per_question?: number; max_questions?: number };
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function stubFetch(options: StubOptions): typeof fetch {
  const hostedUp = options.hostedUp ?? true;
  const localUp = options.localUp ?? true;
  const localModels = options.localModels ?? ["openjev-4b"];
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    if (url.origin === "https://api.typesafe.ai") {
      if (!hostedUp) throw new Error("connect refused");
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "jev-latest" }, { id: "jev-1.13.0" }] });
      }
      if (url.pathname === "/v1/systemone") {
        return new Response(JEV_ANSWER, { headers: { "content-type": "application/json" } });
      }
    }
    if (url.origin === "http://127.0.0.1:18080") {
      if (!localUp) throw new Error("connect refused");
      if (url.pathname === "/v1/models") {
        return Response.json({ data: localModels.map((id) => ({ id })) });
      }
      if (url.pathname === "/v1/limits") {
        if (options.limits === undefined) return new Response("not found", { status: 404 });
        return Response.json(options.limits);
      }
      if (url.pathname === "/v1/systemone") {
        return new Response(LOCAL_ANSWER, { headers: { "content-type": "application/json" } });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return fn as typeof fetch;
}

function testConfig(overrides: Record<string, unknown> = {}): Sys1Config {
  return configSchema.parse({
    version: 1,
    hosted: { enabled: true },
    backends: [
      {
        name: "openjev",
        base_url: "http://127.0.0.1:18080",
        model: "openjev-4b",
        size_b: 4,
      },
    ],
    ...overrides,
  });
}

const ENV = { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv;

function handler(config: Sys1Config, stub: StubOptions) {
  return createFetchHandler({ config, env: ENV, fetchFn: stubFetch(stub) });
}

function post(body: string): Request {
  return new Request("http://127.0.0.1:13900/v1/systemone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("gateway /v1/systemone", () => {
  test("routes to hosted Jev under auto", async () => {
    const handle = handler(testConfig(), {});
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sys1-backend")).toBe("typesafe");
    const body = (await response.json()) as { answers: { urgent: { noul: number } } };
    expect(body.answers.urgent.noul).toBe(0.91);
  });

  test("does not use an unselected HTTP backend when hosted is down", async () => {
    const handle = handler(testConfig(), { hostedUp: false });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(503);
  });

  test("prefer-local does not implicitly opt into a registered HTTP backend", async () => {
    const config = testConfig({ local: { model: "tiny" }, routing: { policy: "prefer-local" } });
    const handle = handler(config, {});
    const response = await handle(post(VALID_BODY));
    expect(response.headers.get("x-sys1-backend")).toBe("typesafe");
  });

  test("bare model routes to its backend", async () => {
    const handle = handler(testConfig(), {});
    const body = JSON.parse(VALID_BODY) as Record<string, unknown>;
    body["model"] = "openjev-4b";
    const response = await handle(post(JSON.stringify(body)));
    expect(response.headers.get("x-sys1-backend")).toBe("openjev");
  });

  test("backend/model pins the backend", async () => {
    const handle = handler(testConfig(), {});
    const body = JSON.parse(VALID_BODY) as Record<string, unknown>;
    body["model"] = "openjev/openjev-4b";
    const response = await handle(post(JSON.stringify(body)));
    expect(response.headers.get("x-sys1-backend")).toBe("openjev");
  });

  test("unknown model returns 404", async () => {
    const handle = handler(testConfig(), {});
    const body = JSON.parse(VALID_BODY) as Record<string, unknown>;
    body["model"] = "does-not-exist";
    const response = await handle(post(JSON.stringify(body)));
    expect(response.status).toBe(404);
    const parsed = (await response.json()) as { error: { type: string } };
    expect(parsed.error.type).toBe("unknown_model");
  });

  test("all backends down returns 503", async () => {
    const handle = handler(testConfig(), { hostedUp: false, localUp: false });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(503);
  });

  test("no backends configured returns 503 with guidance", async () => {
    const config = testConfig({ backends: [] });
    const handle = createFetchHandler({
      config,
      env: {} as NodeJS.ProcessEnv,
      fetchFn: stubFetch({}),
    });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(503);
    const parsed = (await response.json()) as { error: { type: string; message: string } };
    expect(parsed.error.type).toBe("no_backend_configured");
    expect(parsed.error.message).toContain("sys1 setup");
    expect(parsed.error.message).toContain("sys1 jev enable");
  });

  test("a Jev credential alone does not activate hosted routing", async () => {
    const config = configSchema.parse({ version: 1, backends: [] });
    const handle = createFetchHandler({
      config,
      env: ENV,
      fetchFn: stubFetch({}),
    });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(503);
    const parsed = (await response.json()) as { error: { type: string } };
    expect(parsed.error.type).toBe("no_backend_configured");
  });

  test("invalid JSON returns 400", async () => {
    const handle = handler(testConfig(), {});
    const response = await handle(post("{not json"));
    expect(response.status).toBe(400);
  });

  test("schema violation returns 422", async () => {
    const handle = handler(testConfig(), {});
    const response = await handle(post(JSON.stringify({ state: "x", questions: {} })));
    expect(response.status).toBe(422);
  });

  test("oversized body returns 413", async () => {
    const handle = handler(testConfig(), {});
    const big = JSON.stringify({
      state: "x".repeat(300_000),
      questions: { q: { type: "noul" } },
    });
    const response = await handle(post(big));
    expect(response.status).toBe(413);
  });
});

describe("gateway /v1/models and /healthz", () => {
  test("models aggregates reachable backends", async () => {
    const handle = handler(testConfig(), {});
    const response = await handle(new Request("http://x/v1/models"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; backend: string }[] };
    const ids = body.data.map((entry) => `${entry.backend}/${entry.id}`);
    expect(ids).toContain("typesafe/jev-latest");
    expect(ids).toContain("openjev/openjev-4b");
  });

  test("healthz reports ok", async () => {
    const handle = handler(testConfig(), {});
    const response = await handle(new Request("http://x/healthz"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("unknown route returns 404", async () => {
    const handle = handler(testConfig(), {});
    const response = await handle(new Request("http://x/nope"));
    expect(response.status).toBe(404);
  });
});

describe("gateway cancellation and redispatch boundaries", () => {
  function recordingFetch(postFn: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
    const discovery = stubFetch({});
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return postFn(requestUrl(input).href, init);
      return discovery(input, init);
    }) as unknown as typeof fetch;
  }

  test("does not redispatch after an HTTP response whose body fails", async () => {
    let posts = 0;
    const fetchFn = recordingFetch(async () => {
      posts += 1;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("private backend output")); },
      }));
    });
    const handle = createFetchHandler({ config: testConfig(), env: ENV, fetchFn });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(502);
    expect(response.headers.get("x-sys1-attempts")).toBe("1");
    expect(posts).toBe(1);
    expect(await response.text()).not.toContain("private backend output");
  });

  test("a transport failure cannot activate an unselected HTTP backend", async () => {
    let posts = 0;
    const fetchFn = recordingFetch(async () => {
      posts += 1;
      if (posts === 1) throw new TypeError("connection failed");
      return new Response(LOCAL_ANSWER);
    });
    const handle = createFetchHandler({ config: testConfig(), env: ENV, fetchFn });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(503);

    expect(posts).toBe(1);
  });

  test("a successful HTTP response with the wrong answer keys is a definitive 502", async () => {
    let posts = 0;
    const fetchFn = recordingFetch(async () => {
      posts += 1;
      return Response.json({
        model: "test", answers: { different: { type: "noul", noul: 0.7 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const handle = createFetchHandler({ config: testConfig(), env: ENV, fetchFn });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe("backend_response_invalid");
    expect(posts).toBe(1);
  });

  test("a pinned backend never redispatches after transport failure", async () => {
    let posts = 0;
    const fetchFn = recordingFetch(async () => { posts += 1; throw new TypeError("connection failed"); });
    const handle = createFetchHandler({ config: testConfig(), env: ENV, fetchFn });
    const response = await handle(post(JSON.stringify({ ...JSON.parse(VALID_BODY), model: "typesafe/jev-latest" })));
    expect(response.status).toBe(503);
    expect(posts).toBe(1);
  });

  test("a hosted model pin cannot override local-only routing", async () => {
    let posts = 0;
    let hostedCalls = 0;
    const forward = recordingFetch(async () => { posts += 1; return new Response(JEV_ANSWER); });
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).origin === "https://api.typesafe.ai") hostedCalls += 1;
      return forward(input, init);
    }) as typeof fetch;
    const handle = createFetchHandler({
      config: testConfig({ routing: { policy: "local-only" } }), env: ENV, fetchFn,
    });
    const response = await handle(post(JSON.stringify({ ...JSON.parse(VALID_BODY), model: "typesafe/jev-latest" })));
    expect(response.status).toBe(422);
    expect((await response.json()).error.type).toBe("policy_restricted");
    expect(posts).toBe(0);
    expect(hostedCalls).toBe(0);
  });

  test("bounds chunked incoming bodies before any backend probe", async () => {
    let cancelled = false;
    let probes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
      cancel() { cancelled = true; },
    });
    const fetchFn = (async () => { probes += 1; throw new Error("unexpected probe"); }) as unknown as typeof fetch;
    const handle = createFetchHandler({ config: testConfig(), env: ENV, fetchFn });
    const response = await handle(new Request("http://127.0.0.1/v1/systemone", { method: "POST", body }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(probes).toBe(0);
  });

  test("caller cancellation aborts active forwarding and cannot trigger fallback", async () => {
    const controller = new AbortController();
    let posts = 0;
    let receivedAbort = false;
    const fetchFn = recordingFetch(async (_url, init) => {
      posts += 1;
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          receivedAbort = true;
          reject(init.signal?.reason);
        }, { once: true });
        queueMicrotask(() => controller.abort());
      });
    });
    const handle = createFetchHandler({ config: testConfig(), env: ENV, fetchFn });
    const response = await handle(new Request("http://127.0.0.1/v1/systemone", {
      method: "POST", body: VALID_BODY, signal: controller.signal,
    }));
    expect(response.status).toBe(499);
    expect(receivedAbort).toBe(true);
    expect(posts).toBe(1);
  });

  test("the request deadline also bounds incoming body reads", async () => {
    const config = testConfig();
    config.gateway.request_timeout_ms = 5;
    const handle = createFetchHandler({ config, env: ENV, fetchFn: stubFetch({}) });
    const response = await handle(new Request("http://127.0.0.1/v1/systemone", {
      method: "POST", body: new ReadableStream<Uint8Array>(),
    }));
    expect(response.status).toBe(504);
  });

  test("incoming body deadline cancels a stalled source without awaiting its cleanup", async () => {
    const config = testConfig();
    config.gateway.request_timeout_ms = 5;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const handle = createFetchHandler({ config, env: ENV, fetchFn: stubFetch({}) });
    const response = await handle(new Request("http://127.0.0.1/v1/systemone", { method: "POST", body }));
    expect(response.status).toBe(504);
    expect((await response.json()).error.type).toBe("inference_timeout");
    expect(cancelled).toBe(true);
  });
});

describe("daemon ownership endpoints", () => {
  test("embedded gateway binding rejects non-loopback runtime configuration", () => {
    const config = testConfig();
    config.gateway.host = "0.0.0.0";
    expect(() => startGateway({ config, env: {} })).toThrow("loopback");
  });

  test("only the owner can read instance identity or request shutdown", async () => {
    let shutdowns = 0;
    const handle = createFetchHandler({
      config: testConfig(), env: ENV,
      daemon: { instance: "private-instance", onShutdown: () => { shutdowns += 1; } },
    });
    const publicHealth = await handle(new Request("http://127.0.0.1/healthz"));
    expect(await publicHealth.json()).not.toHaveProperty("instance");
    const ownedHealth = await handle(new Request("http://127.0.0.1/healthz", {
      headers: { authorization: "Bearer private-instance" },
    }));
    expect(await ownedHealth.json()).toMatchObject({ instance: "private-instance", pid: process.pid });
    const denied = await handle(new Request("http://127.0.0.1/_sys1/shutdown", { method: "POST" }));
    expect(denied.status).toBe(401);
    expect(shutdowns).toBe(0);
    const accepted = await handle(new Request("http://127.0.0.1/_sys1/shutdown", {
      method: "POST", headers: { authorization: "Bearer private-instance" },
    }));
    expect(accepted.status).toBe(202);
    await Bun.sleep(1);
    expect(shutdowns).toBe(1);
  });
});

describe("gateway builtin local backends", () => {
  const homes: string[] = [];

  afterEach(() => {
    while (homes.length > 0) {
      const path = homes.pop();
      if (path !== undefined) rmSync(path, { recursive: true, force: true });
    }
  });

  class FakeEngine implements DecisionEngine {
    readonly modelId: string;
    constructor(modelId: string) {
      this.modelId = modelId;
    }
    async firstTokenDistribution(): Promise<FirstTokenDistribution> {
      return { entries: [[" YES", 0.9], [" NO", 0.1]], inputTokens: 8 };
    }
    async dispose(): Promise<void> {}
  }

  function homeWithGguf(): string {
    const home = mkdtempSync(join(tmpdir(), "sys1-gw-test-"));
    homes.push(home);
    saveManifest(home, {
      version: 1,
      models: [
        {
          id: "tiny",
          kind: "gguf",
          file: "tiny.gguf",
          size_b: 0.6,
          source: "test",
          sha256: "0".repeat(64),
          bytes: 1,
          context: 2048,
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    writeFileSync(join(modelsDir(home), "tiny.gguf"), "x");
    return home;
  }

  function localOnlyConfig(): Sys1Config {
    return configSchema.parse({ version: 1, local: { model: "tiny" }, backends: [], hosted: { enabled: false } });
  }

  test("a builtin gguf answer carries generic-gguf adapter headers", async () => {
    const home = homeWithGguf();
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => new FakeEngine(model.id),
    });
    const handle = createFetchHandler({
      config: localOnlyConfig(),
      env: {} as NodeJS.ProcessEnv,
      fetchFn: stubFetch({}),
      home,
      localRunner: runner,
    });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sys1-backend")).toBe("local-tiny");
    expect(response.headers.get("x-sys1-local-adapter")).toBe("generic-gguf");
    expect(response.headers.get("x-sys1-local-min-coverage")).not.toBeNull();
    await runner.dispose();
  });

  test("an unsupported local request is definitive and never falls through to hosted", async () => {
    const home = homeWithGguf();
    const runner = new LocalRunner({
      home, maxLoadedModels: 1, engineFactory: (model) => new FakeEngine(model.id),
    });
    runner.decide = async () => ({
      ok: false, error: { type: "local_question_unsupported", message: "private request fragment" },
    });
    let posts = 0;
    const discovery = stubFetch({});
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") posts += 1;
      return discovery(input, init);
    }) as unknown as typeof fetch;
    const handle = createFetchHandler({
      config: testConfig({ local: { model: "tiny" }, routing: { policy: "prefer-local" } }),
      env: ENV, home, localRunner: runner, fetchFn,
    });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(422);
    expect(response.headers.get("x-sys1-attempts")).toBe("1");
    expect(posts).toBe(0);
    expect(await response.text()).not.toContain("private request fragment");
    await runner.dispose();
  });





  test("installed smaller models cannot override the selected local model", async () => {
    const home = homeWithGguf();
    const manifest = loadManifest(home);
    const base = manifest.models[0]!;
    manifest.models = [
      { ...base, id: "qwen3-0.6b", file: "qwen3-0.6b.gguf", size_b: 0.6 },
      { ...base, id: "qwen3-1.7b", file: "qwen3-1.7b.gguf", size_b: 1.7 },
    ];
    saveManifest(home, manifest);
    for (const model of manifest.models) writeFileSync(join(modelsDir(home), model.file), "x");
    const runner = new LocalRunner({ home, maxLoadedModels: 1, engineFactory: (model) => new FakeEngine(model.id) });
    const config = configSchema.parse({ version: 1, routing: { policy: "local-only" } });
    const handle = createFetchHandler({ config, env: {}, home, localRunner: runner });
    try {
      const automatic = await handle(post(VALID_BODY));
      expect(automatic.status).toBe(200);
      expect(automatic.headers.get("x-sys1-backend")).toBe("local-qwen3-1.7b");
      const explicit = await handle(post(JSON.stringify({ ...JSON.parse(VALID_BODY), model: "qwen3-0.6b" })));
      expect(explicit.status).toBe(200);
      expect(explicit.headers.get("x-sys1-backend")).toBe("local-qwen3-0.6b");
      config.local.model = "qwen3-0.6b";
      expect((await handle(post(VALID_BODY))).headers.get("x-sys1-backend")).toBe("local-qwen3-0.6b");
      config.local.model = "missing";
      expect((await handle(post(VALID_BODY))).status).toBe(503);
    } finally { await runner.dispose(); }
  });

  test("a hosted transport failure can fall back only to the selected local model", async () => {
    const home = homeWithGguf();
    const runner = new LocalRunner({ home, maxLoadedModels: 1, engineFactory: (model) => new FakeEngine(model.id) });
    const discovery = stubFetch({});
    let posts = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { posts++; throw new TypeError("connection failed"); }
      return discovery(input, init);
    }) as typeof fetch;
    const handle = createFetchHandler({ config: testConfig({ local: { model: "tiny" } }), env: ENV, home, localRunner: runner, fetchFn });
    try {
      const response = await handle(post(VALID_BODY));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-sys1-backend")).toBe("local-tiny");
      expect(response.headers.get("x-sys1-attempts")).toBe("2");
      expect(posts).toBe(1);
    } finally { await runner.dispose(); }
  });

  test("legacy inventory produces actionable errors without reading or sending weights", async () => {
    const home = homeWithGguf();
    writeFileSync(manifestPath(home), JSON.stringify({ version: 1, models: [{ id: "old", kind: "needle", file: "old.cact" }] }));
    let calls = 0;
    const handle = createFetchHandler({ config: localOnlyConfig(), env: {}, home,
      fetchFn: (async () => { calls++; throw new Error("unexpected network"); }) as unknown as typeof fetch });
    for (const request of [post(VALID_BODY), new Request("http://localhost/v1/models")]) {
      const response = await handle(request);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { type: "model_store_invalid", message: expect.stringContaining("new SYS1_HOME") } });
    }
    expect(calls).toBe(0);
  });

  test("hosted-only serves Jev without inspecting a legacy local inventory", async () => {
    const home = homeWithGguf();
    writeFileSync(manifestPath(home), JSON.stringify({ version: 1, models: [{ id: "old", kind: "needle", file: "old.cact" }] }));
    const handle = createFetchHandler({ config: testConfig({ routing: { policy: "hosted-only" } }), env: ENV, home, fetchFn: stubFetch({}) });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sys1-backend")).toBe("typesafe");
    const listed = await handle(new Request("http://localhost/v1/models"));
    expect(listed.status).toBe(200);
  });

  test("a request over every published cap answers 422 request_unsupported", async () => {
    const handle = createFetchHandler({
      config: testConfig(),
      env: {} as NodeJS.ProcessEnv,
      fetchFn: stubFetch({ limits: { max_answers_per_question: 26 } }),
    });
    const criteria: Record<string, null> = {};
    for (let i = 0; i < 30; i += 1) criteria[`opt${i}`] = null;
    const response = await handle(
      post(
        JSON.stringify({
          model: "openjev/openjev-4b",
          state: "x",
          questions: { pick: { type: "choice", criteria } },
        }),
      ),
    );
    expect(response.status).toBe(422);
    const parsed = (await response.json()) as { error: { type: string } };
    expect(parsed.error.type).toBe("request_unsupported");
  });

  test("configured caps remain active when limits probing is unavailable", async () => {
    const config = testConfig({
      backends: [
        {
          name: "openjev",
          base_url: "http://127.0.0.1:18080",
          model: "openjev-4b",
          size_b: 4,
          capabilities: { max_options: 26, max_questions: 64 },
        },
      ],
    });
    const handle = createFetchHandler({
      config,
      env: {} as NodeJS.ProcessEnv,
      fetchFn: stubFetch({}),
    });
    const criteria: Record<string, null> = {};
    for (let i = 0; i < 30; i += 1) criteria[`opt${i}`] = null;
    const response = await handle(
      post(JSON.stringify({ model: "openjev/openjev-4b", state: "x", questions: { pick: { type: "choice", criteria } } })),
    );
    expect(response.status).toBe(422);
    const parsed = (await response.json()) as { error: { type: string } };
    expect(parsed.error.type).toBe("request_unsupported");
  });
});
