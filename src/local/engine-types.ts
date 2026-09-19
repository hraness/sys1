export interface FirstTokenDistribution {
  entries: [string, number][];
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

export interface LlamaEngineOptions {
  modelPath: string;
  modelId: string;
  contextSize: number;
  evalTimeoutMs: number;
}

export interface NativeRuntimeProbe {
  ok: boolean;
  backend?: string;
  gpu_offloading?: boolean;
  supported_backends?: string[];
  message?: string;
  /** Sanitized parent-side diagnostic; never native output or request data. */
  failure_code?: string;
  elapsed_ms?: number;
}

export const ENGINE_IPC_LIMITS = {
  requestBytes: 131_072,
  responseBytes: 16 * 1_048_576,
  maxEntries: 300_000,
  maxTokenBytes: 4_096,
  maxPromptBytes: 65_536,
} as const;
