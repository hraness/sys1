import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EngineUnavailableError, LlamaEngine } from "../src/local/engine.ts";
import { NativeLlamaEngine, runNativeProbe, type NativeGpuType } from "../src/local/engine-core.ts";
import { LocalInputError } from "../src/local/input.ts";

const engines: LlamaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

function harness(timeout = 3_000) {
  const children: ChildProcess[] = [];
  const collected = new Set<number>();
  let stderr = "";
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const engine = new LlamaEngine({ modelPath: "/unused.gguf", modelId: "test", contextSize: 512, evalTimeoutMs: timeout }, () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/engine-worker.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const pid = child.pid!;
    child.once("close", () => collected.add(pid));
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); readyResolve(); });
    return child;
  });
  engines.push(engine);
  return { engine, children, collected, ready, stderr: () => stderr };
}

describe("owned native-engine process", () => {
  test("lazy, warm reuse with serialized evaluations and collection on dispose", async () => {
    const { engine, children, collected } = harness();
    expect(children).toHaveLength(0);
    const [first, second] = await Promise.all([
      engine.firstTokenDistribution("slow"), engine.firstTokenDistribution("second"),
    ]);
    expect(first.inputTokens).toBe(1);
    expect(second.inputTokens).toBe(2);
    expect(children).toHaveLength(1);
    await engine.dispose();
    expect(collected.has(children[0]!.pid!)).toBe(true);
    await expect(engine.firstTokenDistribution("later")).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  test("abort kills a non-cooperative worker, collects it, and recovers the queue", async () => {
    const { engine, children, collected, ready } = harness();
    const controller = new AbortController();
    const pending = engine.firstTokenDistribution("hang", controller.signal);
    const rejected = pending.catch((error: unknown) => error);
    await ready;
    controller.abort();
    expect(await rejected).toBeInstanceOf(EngineUnavailableError);
    expect(collected.has(children[0]!.pid!)).toBe(true);
    expect(children[0]!.signalCode).toBe("SIGKILL");
    expect((await engine.firstTokenDistribution("again")).inputTokens).toBe(1);
    expect(children).toHaveLength(2);
  });

  test("deadline bounds startup and hung evaluation; a later call starts clean", async () => {
    const { engine, children, collected } = harness(250);
    await expect(engine.firstTokenDistribution("hang")).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(collected.has(children[0]!.pid!)).toBe(true);
    expect((await engine.firstTokenDistribution("again")).inputTokens).toBe(1);
    expect(children).toHaveLength(2);
  });

  test("queued abort does not kill another call's warm worker", async () => {
    const { engine, children } = harness();
    const first = engine.firstTokenDistribution("slow");
    const controller = new AbortController();
    const queued = engine.firstTokenDistribution("never", controller.signal);
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(EngineUnavailableError);
    expect((await first).inputTokens).toBe(1);
    expect((await engine.firstTokenDistribution("again")).inputTokens).toBe(2);
    expect(children).toHaveLength(1);
  });

  test("dispose cancels active and queued work and collects native ownership", async () => {
    const { engine, children, collected, ready } = harness();
    const active = engine.firstTokenDistribution("hang");
    const rejectedActive = active.catch((error: unknown) => error);
    const queued = engine.firstTokenDistribution("never");
    const rejectedQueued = queued.catch((error: unknown) => error);
    await ready;
    await engine.dispose();
    expect(await rejectedActive).toBeInstanceOf(EngineUnavailableError);
    expect(await rejectedQueued).toBeInstanceOf(EngineUnavailableError);
    expect(children).toHaveLength(1);
    expect(collected.has(children[0]!.pid!)).toBe(true);
  });

  test.each(["invalid", "oversize", "exit"])("%s responses fail closed and release the worker", async (prompt) => {
    const { engine, children, collected } = harness();
    await expect(engine.firstTokenDistribution(prompt)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(collected.has(children[0]!.pid!)).toBe(true);
    expect((await engine.firstTokenDistribution("again")).inputTokens).toBe(1);
  });

  test("pre-aborted and oversized inputs spawn nothing", async () => {
    const { engine, children } = harness();
    await expect(engine.firstTokenDistribution("unused", AbortSignal.abort())).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(engine.firstTokenDistribution("x".repeat(65_537))).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(children).toHaveLength(0);
  });

  test("bounded IPC carries a large vocabulary across multiple pipe chunks", async () => {
    const { engine, stderr } = harness();
    const result = await engine.firstTokenDistribution("vocabulary").catch((error) => { throw new Error(`${error}: ${stderr()}`); });
    expect(result.entries).toHaveLength(150_000);
    expect(result.entries[149_999]?.[0]).toBe("token-149999");
    expect((await engine.firstTokenDistribution("again").catch((error) => { throw new Error(`${error}: ${stderr()}`); })).inputTokens).toBe(2);
  });

  test("context-capacity failure retains its unsupported-input classification across IPC", async () => {
    const { engine } = harness();
    await expect(engine.firstTokenDistribution("context_limit")).rejects.toBeInstanceOf(LocalInputError);
  });

  test("the actual source worker rejects invalid initialization without loading a model", async () => {
    const engine = new LlamaEngine({ modelPath: "/unused.gguf", modelId: "test", contextSize: 1, evalTimeoutMs: 3_000 });
    engines.push(engine);
    await expect(engine.firstTokenDistribution("unused")).rejects.toBeInstanceOf(EngineUnavailableError);
    await engine.dispose();
  });
});

function nativeHarness(tokenCount: number) {
  let evaluated = false;
  let nativeOptions: unknown;
  let evaluationOptions: { temperature?: number; yieldEogToken?: boolean } | undefined;
  const engine = new NativeLlamaEngine({ modelPath: "/unused", modelId: "mock", contextSize: 512, evalTimeoutMs: 1_000 }, async () => ({
    async getLlamaGpuTypes() { return [false]; },
    async getLlama(options) {
      nativeOptions = options;
      return {
        async dispose() {},
        async loadModel() {
          return {
            tokenizer: {},
            detokenize() { return "yes"; },
            async dispose() {},
            async createContext() {
              return {
                contextSize: 4,
                async dispose() {},
                getSequence() {
                  return {
                    async dispose() {},
                    async *evaluateWithMetadata(_tokens, _metadata, options) {
                      evaluated = true;
                      evaluationOptions = options;
                      yield { token: 1, probabilities: new Map([[1, 1]]) };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    resolveChatWrapper() {
      return { generateContextState() { return { contextText: { tokenize() { return Array.from({ length: tokenCount }, () => 1); } } }; } };
    },
  }));
  return { engine, evaluated: () => evaluated, options: () => evaluationOptions, nativeOptions: () => nativeOptions };
}

describe("native worker context admission", () => {
  test("rejects the actual context boundary before native context shifting can erase evidence", async () => {
    const { engine, evaluated } = nativeHarness(4);
    await expect(engine.firstTokenDistribution("bounded input")).rejects.toBeInstanceOf(LocalInputError);
    expect(evaluated()).toBe(false);
    await engine.dispose();
  });

  test("preserves the distribution when an end-of-generation token wins", async () => {
    const { engine, options, nativeOptions } = nativeHarness(3);
    expect((await engine.firstTokenDistribution("bounded input")).entries).toEqual([["yes", 1]]);
    expect(options()).toEqual({ temperature: 0, yieldEogToken: true });
    expect(nativeOptions()).toEqual({ gpu: "auto", logLevel: "fatal", build: "never", skipDownload: true });
    await engine.dispose();
  });
});

describe("native runtime readiness", () => {
  test.each([
    { gpu: false as const, supported: [false] satisfies NativeGpuType[], expected: "cpu", names: ["cpu"] },
    { gpu: "metal" as const, supported: ["metal", false] satisfies NativeGpuType[], expected: "metal", names: ["metal", "cpu"] },
  ])("normalizes native backend $expected to the public string contract", async ({ gpu, supported, expected, names }) => {
    let disposed = false;
    const report = await runNativeProbe(async () => ({
      async getLlamaGpuTypes() { return supported; },
      async getLlama(options) {
        expect(options).toEqual({ gpu: "auto", logLevel: "fatal", build: "never", skipDownload: true });
        return {
          gpu,
          supportsGpuOffloading: gpu !== false,
          async loadModel() { throw new Error("readiness must not load a model"); },
          async dispose() { disposed = true; },
        };
      },
      resolveChatWrapper() { throw new Error("readiness must not render model input"); },
    }));
    expect(report).toEqual({ ok: true, backend: expected, gpu_offloading: gpu !== false, supported_backends: [...names] });
    expect(disposed).toBe(true);
  });
});
