import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type SysoneConfig } from "../src/config.ts";
import { createFetchHandler } from "../src/gateway.ts";
import type { DecisionEngine, FirstTokenDistribution } from "../src/local/engine.ts";
import { LocalRunner } from "../src/local/runner.ts";
import { modelsDir, saveManifest } from "../src/local/store.ts";
import { buildScorerCheckpoint } from "./fixtures/torchckpt.ts";

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
});

interface StubOptions {
  hostedUp?: boolean;
  localUp?: boolean;
  localModels?: string[];
  limits?: { max_answers_per_question?: number; max_questions?: number };
}

function stubFetch(options: StubOptions): typeof fetch {
  const hostedUp = options.hostedUp ?? true;
  const localUp = options.localUp ?? true;
  const localModels = options.localModels ?? ["openjev-4b"];
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.typesafe.ai")) {
      if (!hostedUp) throw new Error("connect refused");
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: "jev-latest" }, { id: "jev-1.13.0" }] });
      }
      if (url.endsWith("/v1/systemone")) {
        return new Response(JEV_ANSWER, { headers: { "content-type": "application/json" } });
      }
    }
    if (url.startsWith("http://127.0.0.1:18080")) {
      if (!localUp) throw new Error("connect refused");
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: localModels.map((id) => ({ id })) });
      }
      if (url.endsWith("/v1/limits")) {
        if (options.limits === undefined) return new Response("not found", { status: 404 });
        return Response.json(options.limits);
      }
      if (url.endsWith("/v1/systemone")) {
        return new Response(LOCAL_ANSWER, { headers: { "content-type": "application/json" } });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return fn as typeof fetch;
}

function testConfig(overrides: Record<string, unknown> = {}): SysoneConfig {
  return configSchema.parse({
    version: 1,
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

function handler(config: SysoneConfig, stub: StubOptions) {
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
    expect(response.headers.get("x-sysone-backend")).toBe("typesafe");
    const body = (await response.json()) as { answers: { urgent: { noul: number } } };
    expect(body.answers.urgent.noul).toBe(0.91);
  });

  test("falls back to the local backend when hosted is down", async () => {
    const handle = handler(testConfig(), { hostedUp: false });
    const response = await handle(post(VALID_BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sysone-backend")).toBe("openjev");
  });

  test("prefer-local routes to the local backend first", async () => {
    const config = testConfig({ routing: { policy: "prefer-local" } });
    const handle = handler(config, {});
    const response = await handle(post(VALID_BODY));
    expect(response.headers.get("x-sysone-backend")).toBe("openjev");
  });

  test("bare model routes to its backend", async () => {
    const handle = handler(testConfig(), {});
    const body = JSON.parse(VALID_BODY) as Record<string, unknown>;
    body["model"] = "openjev-4b";
    const response = await handle(post(JSON.stringify(body)));
    expect(response.headers.get("x-sysone-backend")).toBe("openjev");
  });

  test("backend/model pins the backend", async () => {
    const handle = handler(testConfig(), {});
    const body = JSON.parse(VALID_BODY) as Record<string, unknown>;
    body["model"] = "openjev/openjev-4b";
    const response = await handle(post(JSON.stringify(body)));
    expect(response.headers.get("x-sysone-backend")).toBe("openjev");
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
    const home = mkdtempSync(join(tmpdir(), "sysone-gw-test-"));
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

  function homeWithScorer(): string {
    const home = mkdtempSync(join(tmpdir(), "sysone-gw-test-"));
    homes.push(home);
    const ckpt = buildScorerCheckpoint({
      encoder: "tinyx",
      width: 8,
      rank: 8,
      layers: 1,
      heads: 2,
      context_tokens: 64,
      option_tokens: 32,
    });
    mkdirSync(modelsDir(home), { recursive: true });
    writeFileSync(join(modelsDir(home), "ckpt.pt"), ckpt);
    saveManifest(home, {
      version: 1,
      models: [
        {
          id: "ckpt",
          kind: "scorer",
          file: "ckpt.pt",
          source: "test",
          sha256: "0".repeat(64),
          bytes: ckpt.byteLength,
          context: 64,
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    return home;
  }

  function localOnlyConfig(): SysoneConfig {
    return configSchema.parse({ version: 1, backends: [], hosted: { enabled: false } });
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
    expect(response.headers.get("x-sysone-backend")).toBe("local-tiny");
    expect(response.headers.get("x-sysone-local-adapter")).toBe("generic-gguf");
    expect(response.headers.get("x-sysone-local-min-coverage")).not.toBeNull();
    await runner.dispose();
  });

  test("a pinned specialist scorer answers with the option-scorer adapter", async () => {
    const home = homeWithScorer();
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
    const body = JSON.parse(VALID_BODY) as Record<string, unknown>;
    body["model"] = "local-ckpt/ckpt";
    const response = await handle(post(JSON.stringify(body)));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sysone-backend")).toBe("local-ckpt");
    expect(response.headers.get("x-sysone-local-adapter")).toBe("option-scorer");
    const parsed = (await response.json()) as {
      answers: { urgent: { type: string; noul: number } };
    };
    expect(parsed.answers.urgent.type).toBe("noul");
    await runner.dispose();
  });

  test("specialists never absorb unpinned fallback traffic", async () => {
    const home = homeWithScorer();
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
    expect(response.status).toBe(503);
    const parsed = (await response.json()) as { error: { type: string } };
    expect(parsed.error.type).toBe("no_backend_available");
    await runner.dispose();
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
          state: "x",
          questions: { pick: { type: "choice", criteria } },
        }),
      ),
    );
    expect(response.status).toBe(422);
    const parsed = (await response.json()) as { error: { type: string } };
    expect(parsed.error.type).toBe("request_unsupported");
  });
});
