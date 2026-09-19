import { describe, expect, test } from "bun:test";
import { configSchema, type SysoneConfig } from "../src/config.ts";
import { createFetchHandler } from "../src/gateway.ts";

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
