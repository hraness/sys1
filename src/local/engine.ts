/**
 * Local inference engine boundary. `DecisionEngine` is the minimal surface
 * the decision layer needs: one prompt in, the full vocabulary distribution
 * at the answer position out. The llama.cpp implementation loads lazily and
 * serializes evaluations — one context, one sequence at a time.
 */

export interface FirstTokenDistribution {
  /** Detokenized (token text, probability) pairs covering the vocabulary. */
  entries: [string, number][];
  /** Tokens consumed rendering the prompt. */
  inputTokens: number;
}

export interface DecisionEngine {
  readonly modelId: string;
  firstTokenDistribution(prompt: string, signal?: AbortSignal): Promise<FirstTokenDistribution>;
  dispose(): Promise<void>;
}

export class EngineUnavailableError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "EngineUnavailableError";
    this.detail = detail;
  }
}

interface LlamaLike {
  readonly gpu?: string;
  readonly supportsGpuOffloading?: boolean;
  loadModel(options: { modelPath: string }): Promise<LlamaModelLike>;
  dispose(): Promise<void>;
}

interface LlamaTextLike {
  tokenize(tokenizer: unknown): unknown[];
}

interface ChatWrapperLike {
  generateContextState(options: {
    chatHistory: Array<
      | { type: "system"; text: string }
      | { type: "user"; text: string }
      | { type: "model"; response: string[] }
    >;
  }): { contextText: LlamaTextLike };
}

interface LlamaModelLike {
  readonly tokenizer: unknown;
  detokenize(tokens: unknown[]): string;
  createContext(options: { contextSize: number }): Promise<LlamaContextLike>;
  dispose(): Promise<void>;
}

interface LlamaContextLike {
  getSequence(): LlamaSequenceLike;
  dispose(): Promise<void>;
}

interface LlamaSequenceLike {
  evaluateWithMetadata(
    tokens: unknown,
    metadata: { probabilities: true },
    options?: { temperature?: number; signal?: AbortSignal },
  ): AsyncGenerator<{ token: unknown; probabilities?: Map<unknown, number> }, unknown, unknown>;
  dispose(): Promise<void>;
}

interface NodeLlamaCppModule {
  getLlama(options?: { gpu?: string; logLevel?: "fatal" }): Promise<LlamaLike>;
  getLlamaGpuTypes(include: "supported"): Promise<string[]>;
  resolveChatWrapper(
    model: LlamaModelLike,
    options?: { customWrapperSettings?: { qwen?: { thoughts?: "discourage" } } },
  ): ChatWrapperLike;
  NoBinaryFoundError?: new (...args: never[]) => Error;
}

async function loadNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  const specifier: string = "node-llama-cpp";
  return (await import(specifier)) as unknown as NodeLlamaCppModule;
}

export interface NativeRuntimeProbe {
  ok: boolean;
  backend?: string;
  gpu_offloading?: boolean;
  supported_backends?: string[];
  message?: string;
}

export async function probeNativeRuntime(): Promise<NativeRuntimeProbe> {
  let llama: LlamaLike | null = null;
  try {
    const mod = await loadNodeLlamaCpp();
    const supported = await mod.getLlamaGpuTypes("supported");
    llama = await mod.getLlama({ gpu: "auto", logLevel: "fatal" });
    return {
      ok: true,
      backend: llama.gpu ?? "cpu",
      gpu_offloading: llama.supportsGpuOffloading ?? false,
      supported_backends: supported,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "native runtime unavailable",
    };
  } finally {
    if (llama !== null) await llama.dispose().catch(() => {});
  }
}

export interface LlamaEngineOptions {
  modelPath: string;
  modelId: string;
  contextSize: number;
  evalTimeoutMs: number;
}

/**
 * A node-llama-cpp-backed engine. The module is imported lazily so the
 * package stays optional at load time: importing `engine.ts` never requires
 * the native binaries, only constructing a `LlamaEngine` does.
 */
export class LlamaEngine implements DecisionEngine {
  readonly modelId: string;
  private readonly options: LlamaEngineOptions;
  private llama: LlamaLike | null = null;
  private model: LlamaModelLike | null = null;
  private context: LlamaContextLike | null = null;
  private chatWrapper: ChatWrapperLike | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: LlamaEngineOptions) {
    this.options = options;
    this.modelId = options.modelId;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.context !== null) return;
    let mod: NodeLlamaCppModule;
    try {
      mod = await loadNodeLlamaCpp();
    } catch {
      throw new EngineUnavailableError(
        "node-llama-cpp is not installed",
        "reinstall @hraness/sysone or run `bun add node-llama-cpp`",
      );
    }
    try {
      this.llama = await mod.getLlama({ gpu: "auto", logLevel: "fatal" });
    } catch (error) {
      if (mod.NoBinaryFoundError !== undefined && error instanceof mod.NoBinaryFoundError) {
        throw new EngineUnavailableError(
          "llama.cpp binaries are not installed",
          "run `bun pm trust node-llama-cpp && bun install` or `sysone doctor` for setup help",
        );
      }
      throw error;
    }
    try {
      this.model = await this.llama.loadModel({ modelPath: this.options.modelPath });
      this.chatWrapper = mod.resolveChatWrapper(this.model, {
        customWrapperSettings: { qwen: { thoughts: "discourage" } },
      });
      this.context = await this.model.createContext({ contextSize: this.options.contextSize });
    } catch (error) {
      if (this.context !== null) await this.context.dispose().catch(() => {});
      if (this.model !== null) await this.model.dispose().catch(() => {});
      if (this.llama !== null) await this.llama.dispose().catch(() => {});
      this.context = null;
      this.model = null;
      this.chatWrapper = null;
      this.llama = null;
      throw new EngineUnavailableError(
        "local model failed to load",
        error instanceof Error ? error.message : this.modelId,
      );
    }
  }

  firstTokenDistribution(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<FirstTokenDistribution> {
    if (this.disposed) {
      return Promise.reject(new EngineUnavailableError("engine is disposed", this.modelId));
    }
    const run = this.queue.then(() => this.evaluate(prompt, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  private async evaluate(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<FirstTokenDistribution> {
    await this.ensureLoaded();
    const model = this.model;
    const context = this.context;
    const chatWrapper = this.chatWrapper;
    if (model === null || context === null || chatWrapper === null) {
      throw new EngineUnavailableError("engine failed to initialize", this.modelId);
    }
    const rendered = chatWrapper.generateContextState({
      chatHistory: [
        {
          type: "system",
          text: "You are a precise decision engine. Follow the requested answer format exactly and do not explain.",
        },
        { type: "user", text: `/no_think\n${prompt}` },
        { type: "model", response: [] },
      ],
    });
    const tokens = rendered.contextText.tokenize(model.tokenizer);
    const sequence = context.getSequence();
    const evalSignal =
      signal === undefined
        ? AbortSignal.timeout(this.options.evalTimeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(this.options.evalTimeoutMs)]);
    try {
      const generator = sequence.evaluateWithMetadata(
        tokens,
        { probabilities: true },
        { temperature: 0, signal: evalSignal },
      );
      const first = await generator.next();
      await generator.return(undefined).catch(() => {});
      const probs = first.done ? undefined : first.value.probabilities;
      if (probs === undefined) {
        throw new EngineUnavailableError("model produced no distribution", this.modelId);
      }
      const entries: [string, number][] = [];
      for (const [token, p] of probs) {
        if (typeof p !== "number" || !(p > 0)) continue;
        entries.push([model.detokenize([token]), p]);
      }
      return { entries, inputTokens: tokens.length };
    } finally {
      await sequence.dispose().catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue.catch(() => {});
    if (this.context !== null) await this.context.dispose().catch(() => {});
    if (this.model !== null) await this.model.dispose().catch(() => {});
    if (this.llama !== null) await this.llama.dispose().catch(() => {});
    this.context = null;
    this.model = null;
    this.chatWrapper = null;
    this.llama = null;
  }
}
