/**
 * Lazy, warm, per-model native worker. node-llama-cpp evaluation does not
 * support AbortSignal; cancellation kills and collects its owned process.
 * The next call starts a fresh worker while successful calls reuse residency.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { LocalInputError } from "./input.ts";
import {
  ENGINE_IPC_LIMITS,
  EngineUnavailableError,
  type DecisionEngine,
  type FirstTokenDistribution,
  type LlamaEngineOptions,
  type NativeRuntimeProbe,
} from "./engine-types.ts";

export { EngineUnavailableError } from "./engine-types.ts";
export type { DecisionEngine, FirstTokenDistribution, LlamaEngineOptions, NativeRuntimeProbe } from "./engine-types.ts";

const distributionSchema = z.object({
  entries: z.array(z.tuple([
    z.string().refine((text) => Buffer.byteLength(text) <= ENGINE_IPC_LIMITS.maxTokenBytes),
    z.number().finite().positive().max(1),
  ])).max(ENGINE_IPC_LIMITS.maxEntries),
  inputTokens: z.number().int().nonnegative().max(1_000_000),
}).strict();

const probeSchema = z.object({
  ok: z.boolean(),
  backend: z.string().max(128).optional(),
  gpu_offloading: z.boolean().optional(),
  supported_backends: z.array(z.string().max(128)).max(32).optional(),
  message: z.string().max(512).optional(),
}).strict();

const responseSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.number().int(), kind: z.literal("distribution"), value: distributionSchema }).strict(),
  z.object({ id: z.number().int(), kind: z.literal("probe"), value: probeSchema }).strict(),
  z.object({ id: z.number().int(), kind: z.literal("error"), detail: z.string().max(128) }).strict(),
  z.object({ id: z.number().int(), kind: z.literal("unsupported"), detail: z.literal("context_limit") }).strict(),
]);

type WorkerResponse = z.infer<typeof responseSchema>;
type WorkerFactory = () => ChildProcess;
interface Pending {
  id: number;
  resolve: (value: WorkerResponse) => void;
  reject: (error: unknown) => void;
}

function defaultWorker(): ChildProcess {
  const entry = new URL(import.meta.url.endsWith(".ts") ? "./engine-worker.ts" : "./engine-worker.js", import.meta.url);
  return spawn(process.execPath, [fileURLToPath(entry)], {
    // Standard pipes work across Bun/Node and Windows; unexpected output fails closed.
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

function unavailable(detail: string): EngineUnavailableError {
  return new EngineUnavailableError("local engine unavailable", detail);
}

class EngineWorker {
  phase: "created" | "request_sent" | "response_started" | "response_received" = "created";
  private readonly child: ChildProcess;
  private readonly collected: Promise<void>;
  private readonly pipes: Array<Readable | Writable>;
  private pending: Pending | null = null;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private nextId = 0;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(factory: WorkerFactory) {
    this.child = factory();
    this.pipes = this.child.stdio.filter((pipe): pipe is Readable | Writable => pipe !== null && pipe !== undefined);
    const pipesClosed = this.pipes.map((pipe) => new Promise<void>((resolve) => {
      if (pipe.closed) resolve();
      else pipe.once("close", () => resolve());
    }));
    const processClosed = new Promise<void>((resolve) => this.child.once("close", () => {
      this.stopped = true;
      const pending = this.pending;
      this.pending = null;
      pending?.reject(unavailable("worker_exited"));
      resolve();
    }));
    this.collected = Promise.all([processClosed, ...pipesClosed]).then(() => {});
    this.child.on("error", () => { void this.fail("worker_failed"); });
    this.child.stdin?.on("error", () => { void this.fail("worker_input_failed"); });
    const output = this.child.stdout;
    if (this.child.stdin === null || output == null) {
      void this.fail("worker_pipes_unavailable");
      return;
    }
    output.on("error", () => { void this.fail("worker_output_failed"); });
    output.on("data", (chunk: Buffer) => this.accept(chunk));
  }

  private accept(chunk: Buffer): void {
    if (this.stopped) return;
    this.phase = "response_started";
    this.bytes += chunk.byteLength;
    if (this.bytes > ENGINE_IPC_LIMITS.responseBytes) {
      void this.fail("worker_response_limit");
      return;
    }
    this.chunks.push(chunk);
    const newline = chunk.indexOf(10);
    if (newline < 0) return;
    if (newline !== chunk.length - 1) {
      void this.fail("worker_response_invalid");
      return;
    }
    let response: WorkerResponse;
    try {
      response = responseSchema.parse(JSON.parse(Buffer.concat(this.chunks, this.bytes).toString("utf8")));
    } catch {
      void this.fail("worker_response_invalid");
      return;
    }
    this.chunks = [];
    this.bytes = 0;
    const pending = this.pending;
    if (pending === null || pending.id !== response.id) {
      void this.fail("worker_response_mismatch");
      return;
    }
    this.pending = null;
    this.phase = "response_received";
    pending.resolve(response);
  }

  private async fail(detail: string): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    await this.stop();
    pending?.reject(unavailable(detail));
  }

  async request(payload: Record<string, unknown>, signal: AbortSignal): Promise<WorkerResponse> {
    if (this.stopped) throw unavailable("worker_stopped");
    if (signal.aborted) throw unavailable("inference_aborted");
    if (this.pending !== null) throw unavailable("worker_busy");
    const id = ++this.nextId;
    const wire = `${JSON.stringify({ ...payload, id })}\n`;
    if (Buffer.byteLength(wire) > ENGINE_IPC_LIMITS.requestBytes) throw unavailable("worker_request_limit");
    const abort = (): void => { void this.fail("inference_aborted"); };
    try {
      return await new Promise<WorkerResponse>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else {
          this.phase = "request_sent";
          this.child.stdin!.write(wire);
        }
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = (async () => {
      // No detached process: this exact child owns the native context. Await
      // close, including its pipes, before releasing the residency slot.
      this.child.kill("SIGKILL");
      for (const pipe of this.pipes) pipe.destroy();
      await this.collected;
      this.chunks = [];
      this.bytes = 0;
    })();
    return this.stopPromise;
  }

  exitStatus(): string {
    const signal = this.child.signalCode;
    if (signal !== null && /^SIG[A-Z0-9]{1,16}$/.test(signal)) return signal;
    const code = this.child.exitCode;
    return code !== null && Number.isSafeInteger(code) ? String(code) : "unknown";
  }
}

export class LlamaEngine implements DecisionEngine {
  readonly modelId: string;
  private worker: EngineWorker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly shutdown = new AbortController();
  private disposePromise: Promise<void> | undefined;

  /** The optional process factory is an injection seam for owned-process tests. */
  constructor(private readonly options: LlamaEngineOptions, private readonly factory: WorkerFactory = defaultWorker) {
    this.modelId = options.modelId;
    if (!Number.isInteger(options.evalTimeoutMs) || options.evalTimeoutMs < 1 || options.evalTimeoutMs > 300_000) {
      throw unavailable("invalid_timeout");
    }
  }

  firstTokenDistribution(prompt: string, signal?: AbortSignal): Promise<FirstTokenDistribution> {
    if (this.disposed) return Promise.reject(unavailable("engine_disposed"));
    if (Buffer.byteLength(prompt) > ENGINE_IPC_LIMITS.maxPromptBytes) return Promise.reject(unavailable("prompt_limit"));
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.evalTimeoutMs);
    const combined = AbortSignal.any([this.shutdown.signal, timeout.signal, ...(signal === undefined ? [] : [signal])]);
    let active = false;
    const run = this.queue.then(async () => {
      if (combined.aborted) throw unavailable("inference_aborted");
      active = true;
      this.worker ??= new EngineWorker(this.factory);
      const worker = this.worker;
      try {
        const response = await worker.request({ op: "evaluate", options: this.options, prompt }, combined);
        if (response.kind === "unsupported") throw new LocalInputError("prompt tokens exceed the model context capacity");
        if (response.kind !== "distribution") {
          throw unavailable(response.kind === "error" ? response.detail : "worker_response_mismatch");
        }
        return response.value;
      } catch (error) {
        await worker.stop();
        if (this.worker === worker) this.worker = null;
        throw error;
      }
    });
    this.queue = run.catch(() => {});
    // Queued cancellation is immediate and never kills another call's worker.
    return new Promise((resolve, reject) => {
      const abortQueued = (): void => { if (!active) reject(unavailable("inference_aborted")); };
      combined.addEventListener("abort", abortQueued, { once: true });
      if (combined.aborted) abortQueued();
      void run.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        combined.removeEventListener("abort", abortQueued);
      });
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    this.shutdown.abort();
    this.disposePromise = (async () => {
      await this.worker?.stop();
      await this.queue;
      this.worker = null;
    })();
    return this.disposePromise;
  }
}

/** Native capability discovery is also isolated and bounded; it loads no model. */
export async function probeNativeRuntime(options: { workerFactory?: WorkerFactory; timeoutMs?: number } = {}): Promise<NativeRuntimeProbe> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return { ok: false, failure_code: "invalid_timeout", elapsed_ms: 0, message: "native runtime probe failed: invalid_timeout" };
  }
  let worker: EngineWorker | undefined;
  const controller = new AbortController();
  let deadlineReached = false;
  const timer = setTimeout(() => { deadlineReached = true; controller.abort(); }, timeoutMs);
  const failure = (code: string): NativeRuntimeProbe => {
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    const phase = worker?.phase ?? "created";
    const exit = code === "worker_exited" ? `; exit=${worker?.exitStatus() ?? "unknown"}` : "";
    return {
      ok: false,
      failure_code: code,
      elapsed_ms: elapsed,
      message: `native runtime probe failed: ${code}; elapsed_ms=${elapsed}; phase=${phase}${exit}`,
    };
  };
  try {
    worker = new EngineWorker(options.workerFactory ?? defaultWorker);
    const response = await worker.request({ op: "probe" }, controller.signal);
    if (response.kind !== "probe") return failure("worker_response_mismatch");
    const value = response.value;
    if (!value.ok) return failure("native_unavailable");
    return {
      ok: value.ok,
      elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
      ...(value.backend === undefined ? {} : { backend: value.backend }),
      ...(value.gpu_offloading === undefined ? {} : { gpu_offloading: value.gpu_offloading }),
      ...(value.supported_backends === undefined ? {} : { supported_backends: value.supported_backends }),
    };
  } catch (error) {
    const allowed = new Set([
      "worker_exited", "worker_failed", "worker_input_failed", "worker_output_failed",
      "worker_pipes_unavailable", "worker_response_limit", "worker_response_invalid",
      "worker_response_mismatch", "worker_request_limit", "worker_stopped", "worker_busy",
    ]);
    return failure(deadlineReached ? "probe_timeout" : error instanceof EngineUnavailableError && allowed.has(error.detail) ? error.detail : "worker_failed");
  } finally {
    clearTimeout(timer);
    await worker?.stop();
  }
}
