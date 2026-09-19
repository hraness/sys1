import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config.ts";
import { createFetchHandler } from "../src/gateway.ts";
import type { DecisionEngine, FirstTokenDistribution } from "../src/local/engine.ts";
import { LocalRunner, type EngineFactory } from "../src/local/runner.ts";
import { modelsDir, saveManifest, type InstalledModel } from "../src/local/store.ts";
import { systemOneResponseSchema, type SystemOneRequest } from "../src/protocol.ts";

const homes: string[] = [];

function homeWithModels(ids: string[] = ["tiny"]): string {
  const home = mkdtempSync(join(tmpdir(), "sysone-runner-test-"));
  homes.push(home);
  const models: InstalledModel[] = ids.map((id) => ({
    id,
    file: `${id}.gguf`,
    size_b: 0.6,
    source: `test:${id}`,
    sha256: "0".repeat(64),
    bytes: 1,
    context: 2048,
    installed_at: "2026-01-01T00:00:00.000Z",
  }));
  saveManifest(home, { version: 1, models });
  for (const model of models) writeFileSync(join(modelsDir(home), model.file), "x");
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    const path = homes.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

class FakeEngine implements DecisionEngine {
  disposed = false;
  readonly modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async firstTokenDistribution(prompt: string): Promise<FirstTokenDistribution> {
    if (prompt.includes("option label")) {
      return { entries: [[" 2", 0.8], [" 1", 0.15], [" other", 0.05]], inputTokens: 30 };
    }
    if (prompt.includes("level label")) {
      return { entries: [[" 3", 0.6], [" 2", 0.3], [" 1", 0.1]], inputTokens: 20 };
    }
    return { entries: [[" YES", 0.7], [" NO", 0.2], [" maybe", 0.1]], inputTokens: 10 };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

interface EngineStats {
  active: number;
  maxActive: number;
}

class SlowEngine implements DecisionEngine {
  readonly modelId: string;
  private readonly stats: EngineStats;
  private readonly delayMs: number;

  constructor(modelId: string, stats: EngineStats, delayMs: number) {
    this.modelId = modelId;
    this.stats = stats;
    this.delayMs = delayMs;
  }

  async firstTokenDistribution(
    _prompt: string,
    signal?: AbortSignal,
  ): Promise<FirstTokenDistribution> {
    this.stats.active += 1;
    this.stats.maxActive = Math.max(this.stats.maxActive, this.stats.active);
    try {
      await Bun.sleep(this.delayMs);
      signal?.throwIfAborted();
      return { entries: [[" YES", 0.9], [" NO", 0.1]], inputTokens: 10 };
    } finally {
      this.stats.active -= 1;
    }
  }

  async dispose(): Promise<void> {}
}

function request(model?: string): SystemOneRequest {
  return {
    ...(model === undefined ? {} : { model }),
    state: { incident: "payments failing" },
    questions: {
      urgent: { type: "noul", instructions: "Is this urgent?" },
      route: { type: "choice", criteria: { backlog: null, page: "page on-call" } },
      severity: { type: "score", criteria: ["low", "medium", "high"] },
    },
  };
}

describe("LocalRunner", () => {
  test("returns Jev-style answers from fake vocabulary distributions", async () => {
    const home = homeWithModels();
    const factory: EngineFactory = (model) => new FakeEngine(model.id);
    const runner = new LocalRunner({ home, maxLoadedModels: 1, engineFactory: factory });
    const result = await runner.decide(request(), "tiny");
    expect(result.ok).toBe(true);
    expect(result.response?.model).toBe("tiny");
    const urgent = result.response?.answers.urgent;
    const route = result.response?.answers.route;
    const severity = result.response?.answers.severity;
    if (urgent?.type !== "noul" || route?.type !== "choice" || severity?.type !== "score") {
      throw new Error("unexpected answer types");
    }
    expect(urgent).toEqual({ type: "noul", noul: 0.778 });
    expect(route.choice).toBe("page");
    expect(severity.score).toBe(1.5);
    expect(severity.legend).toEqual({ "0": "low", "1": "medium", "2": "high" });
    expect(severity.probabilities).toEqual({ "0": 0.1, "1": 0.3, "2": 0.6 });
    expect(result.response?.usage).toEqual({ input_tokens: 60, output_tokens: 0 });
    expect(result.diagnostics?.urgent).toEqual({ coverage: 0.9, concentration: 0.556 });
    await runner.dispose();
  });

  test("evicts the least recently loaded engine at its residency cap", async () => {
    const home = homeWithModels(["one", "two"]);
    const engines: FakeEngine[] = [];
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => {
        const engine = new FakeEngine(model.id);
        engines.push(engine);
        return engine;
      },
    });
    await runner.decide(request(), "one");
    await runner.decide(request(), "two");
    expect(engines[0]?.disposed).toBe(true);
    expect(runner.loadedModels()).toEqual(["two"]);
    await runner.dispose();
    expect(engines[1]?.disposed).toBe(true);
  });

  test("serializes complete requests across different models", async () => {
    const home = homeWithModels(["one", "two"]);
    const stats: EngineStats = { active: 0, maxActive: 0 };
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 2,
      engineFactory: (model) => new SlowEngine(model.id, stats, 2),
    });
    await Promise.all([
      runner.decide(request(), "one"),
      runner.decide(request(), "two"),
    ]);
    expect(stats.maxActive).toBe(1);
    await runner.dispose();
  });

  test("rejects choice sets that exceed the one-token label space", async () => {
    const home = homeWithModels();
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => new FakeEngine(model.id),
    });
    const large: SystemOneRequest = {
      state: "x",
      questions: {
        pick: {
          type: "choice",
          criteria: Object.fromEntries(
            Array.from({ length: 36 }, (_, i) => [`option-${i}`, null]),
          ),
        },
      },
    };
    const result = await runner.decide(large, "tiny");
    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe("local_question_unsupported");
    expect(runner.loadedModels()).toEqual([]);
    await runner.dispose();
  });
});

describe("builtin gateway backend", () => {
  test("routes an installed GGUF through the injected local runner", async () => {
    const home = homeWithModels();
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => new FakeEngine(model.id),
    });
    const config = configSchema.parse({
      version: 1,
      hosted: { enabled: false },
      routing: { policy: "local-only" },
    });
    const handle = createFetchHandler({ config, env: {}, home, localRunner: runner });
    const response = await handle(
      new Request("http://127.0.0.1:13900/v1/systemone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request("tiny")),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sysone-backend")).toBe("local-tiny");
    expect(response.headers.get("x-sysone-local-adapter")).toBe("generic-gguf");
    expect(response.headers.get("x-sysone-local-min-coverage")).toBe("0.900");
    expect(response.headers.get("x-sysone-local-min-concentration")).toBe("0.400");
    const body: unknown = await response.json();
    const parsed = systemOneResponseSchema.parse(body);
    expect(parsed.answers.route).toMatchObject({ type: "choice", choice: "page" });
    expect(JSON.stringify(body)).not.toContain("coverage");
    await runner.dispose();
  });

  test("bounds the complete local request timeout", async () => {
    const home = homeWithModels();
    const stats: EngineStats = { active: 0, maxActive: 0 };
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => new SlowEngine(model.id, stats, 50),
    });
    const config = configSchema.parse({
      version: 1,
      hosted: { enabled: false },
      routing: { policy: "local-only" },
    });
    config.gateway.request_timeout_ms = 5;
    const handle = createFetchHandler({ config, env: {}, home, localRunner: runner });
    const response = await handle(
      new Request("http://127.0.0.1:13900/v1/systemone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request("tiny")),
      }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("inference_timeout");
    await runner.dispose();
  });
});
