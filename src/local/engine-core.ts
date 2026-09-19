/** Native state lives only inside the owned worker process. */
import { EngineUnavailableError, type FirstTokenDistribution, type LlamaEngineOptions, type NativeRuntimeProbe } from "./engine-types.ts";
import { LocalInputError } from "./input.ts";

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
  readonly contextSize: number;
  getSequence(): LlamaSequenceLike;
  dispose(): Promise<void>;
}

interface LlamaSequenceLike {
  evaluateWithMetadata(
    tokens: unknown,
    metadata: { probabilities: true },
    options?: { temperature?: number; yieldEogToken?: boolean },
  ): AsyncGenerator<{ token: unknown; probabilities?: Map<unknown, number> }, unknown, unknown>;
  dispose(): Promise<void>;
}

interface NodeLlamaCppModule {
  getLlama(options?: { gpu?: string; logLevel?: "fatal"; build?: "never"; skipDownload?: boolean }): Promise<LlamaLike>;
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

export async function runNativeProbe(): Promise<NativeRuntimeProbe> {
  let llama: LlamaLike | null = null;
  try {
    const mod = await loadNodeLlamaCpp();
    const supported = await mod.getLlamaGpuTypes("supported");
    llama = await mod.getLlama({ gpu: "auto", logLevel: "fatal", build: "never", skipDownload: true });
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

/** Native inference has no cancellation claim; its owner kills this process. */
export class NativeLlamaEngine {
  readonly modelId: string;
  private readonly options: LlamaEngineOptions;
  private llama: LlamaLike | null = null;
  private model: LlamaModelLike | null = null;
  private context: LlamaContextLike | null = null;
  private chatWrapper: ChatWrapperLike | null = null;
  private disposed = false;

  constructor(options: LlamaEngineOptions, private readonly loadModule: () => Promise<NodeLlamaCppModule> = loadNodeLlamaCpp) {
    this.options = options;
    this.modelId = options.modelId;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.context !== null) return;
    let mod: NodeLlamaCppModule;
    try {
      mod = await this.loadModule();
    } catch {
      throw new EngineUnavailableError(
        "node-llama-cpp is not installed",
        "reinstall @hraness/sys1 or run `bun add node-llama-cpp`",
      );
    }
    try {
      this.llama = await mod.getLlama({ gpu: "auto", logLevel: "fatal", build: "never", skipDownload: true });
    } catch (error) {
      if (mod.NoBinaryFoundError !== undefined && error instanceof mod.NoBinaryFoundError) {
        throw new EngineUnavailableError(
          "llama.cpp binaries are not installed",
          "run `bun pm trust node-llama-cpp && bun install` or `sys1 doctor` for setup help",
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

  async firstTokenDistribution(prompt: string): Promise<FirstTokenDistribution> {
    if (this.disposed) throw new EngineUnavailableError("engine is disposed", this.modelId);
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
    if (tokens.length >= context.contextSize) {
      throw new LocalInputError("prompt tokens exceed the model context capacity");
    }
    const sequence = context.getSequence();
    try {
      const generator = sequence.evaluateWithMetadata(
        tokens,
        { probabilities: true },
        { temperature: 0, yieldEogToken: true },
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
    if (this.context !== null) await this.context.dispose().catch(() => {});
    if (this.model !== null) await this.model.dispose().catch(() => {});
    if (this.llama !== null) await this.llama.dispose().catch(() => {});
    this.context = null;
    this.model = null;
    this.chatWrapper = null;
    this.llama = null;
  }
}
