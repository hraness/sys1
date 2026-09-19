import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { configSchema } from "../src/config.ts";
import { createFetchHandler } from "../src/gateway.ts";
import type { DecisionEngine, FirstTokenDistribution } from "../src/local/engine.ts";
import { LocalRunner, type EngineFactory } from "../src/local/runner.ts";
import { modelsDir, saveManifest, installedModels, type InstalledModel } from "../src/local/store.ts";
import { systemOneResponseSchema, type SystemOneRequest } from "../src/protocol.ts";
import { buildCactBlob } from "./fixtures/cact.ts";
import { buildScorerCheckpoint } from "./fixtures/torchckpt.ts";

const homes: string[] = [];

function homeWithModels(ids: string[] = ["tiny"]): string {
  const home = mkdtempSync(join(tmpdir(), "sys1-runner-test-"));
  homes.push(home);
  const models: InstalledModel[] = ids.map((id) => ({
    id,
    kind: "gguf",
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

  test("a scorer evicts a resident GGUF at the shared residency cap", async () => {
    const home = homeWithModels(["one"]);
    const checkpoint = buildScorerCheckpoint({ encoder: "tinyx", width: 8, rank: 8, layers: 1, heads: 2, context_tokens: 256, option_tokens: 96 });
    writeFileSync(join(modelsDir(home), "scorer.pt"), checkpoint);
    saveManifest(home, { version: 1, models: [...installedModels(home), {
      id: "scorer", kind: "scorer", file: "scorer.pt", source: "test",
      sha256: createHash("sha256").update(checkpoint).digest("hex"), bytes: checkpoint.byteLength,
      context: 256, installed_at: "2026-01-01T00:00:00.000Z",
    }] });
    const engine = new FakeEngine("one");
    const runner = new LocalRunner({ home, maxLoadedModels: 1, engineFactory: () => engine });
    try {
      expect((await runner.decide(request(), "one")).ok).toBe(true);
      expect((await runner.decide(request(), "scorer")).ok).toBe(true);
      expect(engine.disposed).toBe(true);
      expect(runner.loadedModels()).toEqual(["scorer"]);
    } finally { await runner.dispose(); }
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

  test("answers a request through a synthetic scorer checkpoint", async () => {
    const home = mkdtempSync(join(tmpdir(), "sys1-runner-test-"));
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
          sha256: createHash("sha256").update(ckpt).digest("hex"),
          bytes: ckpt.byteLength,
          context: 2048,
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => new FakeEngine(model.id),
    });
    const result = await runner.decide(request(), "ckpt");
    expect(result.ok).toBe(true);
    expect(result.adapter).toBe("option-scorer");
    const route = result.response?.answers.route;
    expect(route?.type).toBe("choice");
    if (route?.type === "choice") {
      expect(Object.keys(route.probabilities)).toEqual(["backlog", "page"]);
      const total = Object.values(route.probabilities).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 2);
    }
    const urgent = result.response?.answers.urgent;
    expect(urgent?.type).toBe("noul");
    const severity = result.response?.answers.severity;
    expect(severity?.type).toBe("score");
    if (severity?.type === "score") {
      expect(severity.legend).toEqual({ "0": "low", "1": "medium", "2": "high" });
    }
    expect(runner.loadedModels()).toEqual(["ckpt"]);
    await runner.dispose();
  });

  test("answers a request through an injected needle turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "sys1-runner-test-"));
    homes.push(home);
    const cact = buildCactBlob();
    const engine = Buffer.alloc(1_024, 9);
    mkdirSync(modelsDir(home), { recursive: true });
    writeFileSync(join(modelsDir(home), "n3.cact"), cact);
    writeFileSync(join(modelsDir(home), "n3.engine"), engine);
    saveManifest(home, {
      version: 1,
      models: [
        {
          id: "n3",
          kind: "needle",
          file: "n3.cact",
          source: "test",
          sha256: createHash("sha256").update(cact).digest("hex"),
          bytes: cact.byteLength,
          context: 2048,
          engine_file: "n3.engine",
          engine_sha256: createHash("sha256").update(engine).digest("hex"),
          engine_bytes: engine.byteLength,
          engine_platform: "darwin-arm64",
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const spawnFn = ((_argv: string[]) => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                function_calls: [
                  { name: "evaluate", arguments: { urgent: true, route: "page", severity: "2" } },
                ],
                confidence: 0.9,
              }),
            ),
          );
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    })) as unknown as typeof Bun.spawn;
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => new FakeEngine(model.id),
      needleSpawnFn: spawnFn,
    });
    const result = await runner.decide(request(), "n3");
    expect(result.ok).toBe(true);
    expect(result.adapter).toBe("needle-extract");
    expect(result.response?.answers.urgent).toEqual({ type: "noul", noul: 0.9 });
    const route = result.response?.answers.route;
    if (route?.type === "choice") expect(route.choice).toBe("page");
    const severity = result.response?.answers.severity;
    if (severity?.type === "score") {
      expect(severity.score).toBeCloseTo(1.85, 5);
      expect(severity.legend).toEqual({ "0": "low", "1": "medium", "2": "high" });
    }
    await runner.dispose();
  });

  test("a needle turn without the evaluate call fails closed", async () => {
    const home = mkdtempSync(join(tmpdir(), "sys1-runner-test-"));
    homes.push(home);
    const cact = buildCactBlob();
    const engine = Buffer.alloc(1_024, 9);
    mkdirSync(modelsDir(home), { recursive: true });
    writeFileSync(join(modelsDir(home), "n3.cact"), cact);
    writeFileSync(join(modelsDir(home), "n3.engine"), engine);
    saveManifest(home, {
      version: 1,
      models: [
        {
          id: "n3",
          kind: "needle",
          file: "n3.cact",
          source: "test",
          sha256: createHash("sha256").update(cact).digest("hex"),
          bytes: cact.byteLength,
          context: 2048,
          engine_file: "n3.engine",
          engine_sha256: createHash("sha256").update(engine).digest("hex"),
          engine_bytes: engine.byteLength,
          engine_platform: "darwin-arm64",
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const spawnFn = ((_argv: string[]) => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                function_calls: [],
                suppressed_calls: [{ name: "evaluate", arguments: {} }],
                confidence: 0.2,
              }),
            ),
          );
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    })) as unknown as typeof Bun.spawn;
    const runner = new LocalRunner({
      home,
      maxLoadedModels: 1,
      engineFactory: (model) => new FakeEngine(model.id),
      needleSpawnFn: spawnFn,
    });
    const result = await runner.decide(request(), "n3");
    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe("inference_unreadable");
    expect(result.error?.message).toContain("grounding");
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
    expect(response.headers.get("x-sys1-backend")).toBe("local-tiny");
    expect(response.headers.get("x-sys1-local-adapter")).toBe("generic-gguf");
    expect(response.headers.get("x-sys1-local-min-coverage")).toBe("0.900");
    expect(response.headers.get("x-sys1-local-min-concentration")).toBe("0.400");
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
    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("request deadline exceeded");
    await runner.dispose();
  });
});
