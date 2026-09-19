import type { SystemOneRequest } from "../protocol.ts";
import {
  DECIDE_LIMITS,
  aggregateMass,
  answerLabels,
  confidenceOf,
  decisionPrompt,
  outcomeFromMass,
  questionEntries,
  toLocalAnswer,
  toLocalResponse,
  type LocalAnswer,
  type LocalResponse,
} from "./decide.ts";
import { EngineUnavailableError, LlamaEngine, type DecisionEngine } from "./engine.ts";
import {
  findInstalled,
  installedModels,
  modelFilePath,
  type InstalledModel,
} from "./store.ts";

/**
 * The builtin local backend. Each installed GGUF registers as a pseudo-backend
 * named `local-<id>`; the runner lazily loads weights on first use, serializes
 * evaluations per model, and caps how many models stay resident.
 */

export const BUILTIN_PREFIX = "local-";

export interface BuiltinCandidate {
  name: string;
  kind: "local";
  builtin: true;
  model: InstalledModel;
  available: boolean;
  models: string[];
  size_b: number | null;
  cost_rank: number;
}

export function builtinName(modelId: string): string {
  return `${BUILTIN_PREFIX}${modelId}`;
}

/** Installed models as router candidates — one pseudo-backend per model. */
export function builtinCandidates(home: string, enabled: boolean): BuiltinCandidate[] {
  if (!enabled) return [];
  return installedModels(home).map((model) => ({
    name: builtinName(model.id),
    kind: "local",
    builtin: true,
    model,
    available: true,
    models: [model.id],
    size_b: model.size_b ?? null,
    cost_rank: 0,
  }));
}

export type EngineFactory = (model: InstalledModel, path: string) => DecisionEngine;

export function defaultEngineFactory(
  contextSize: number,
  evalTimeoutMs: number,
): EngineFactory {
  return (model, path) =>
    new LlamaEngine({
      modelPath: path,
      modelId: model.id,
      contextSize,
      evalTimeoutMs,
    });
}

export interface RunnerOptions {
  home: string;
  maxLoadedModels: number;
  engineFactory: EngineFactory;
}

export interface LocalQuestionDiagnostic {
  coverage: number;
  concentration: number;
}

export interface DecideResult {
  ok: boolean;
  response?: LocalResponse;
  diagnostics?: Record<string, LocalQuestionDiagnostic>;
  error?: { type: string; message: string };
}

export class LocalRunner {
  private readonly options: RunnerOptions;
  private readonly engines = new Map<string, { engine: DecisionEngine; touched: number }>();
  private readonly shutdownController = new AbortController();
  private requestQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  /** Loaded model ids, for status reporting. */
  loadedModels(): string[] {
    return [...this.engines.keys()];
  }

  private async engineFor(model: InstalledModel): Promise<DecisionEngine> {
    const cached = this.engines.get(model.id);
    if (cached !== undefined) {
      cached.touched = Date.now();
      return cached.engine;
    }
    if (this.engines.size >= this.options.maxLoadedModels) {
      let oldestId: string | null = null;
      let oldest = Number.MAX_SAFE_INTEGER;
      for (const [id, entry] of this.engines) {
        if (entry.touched < oldest) {
          oldest = entry.touched;
          oldestId = id;
        }
      }
      if (oldestId !== null) {
        const stale = this.engines.get(oldestId);
        this.engines.delete(oldestId);
        if (stale !== undefined) await stale.engine.dispose().catch(() => {});
      }
    }
    const engine = this.options.engineFactory(model, modelFilePath(this.options.home, model));
    this.engines.set(model.id, { engine, touched: Date.now() });
    return engine;
  }

  /**
   * Run one validated request against an installed model. Each question is an
   * independent one-token decision; empty label mass fails rather than
   * returning a malformed Jev answer.
   */
  decide(
    request: SystemOneRequest,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<DecideResult> {
    const activeSignal =
      signal === undefined
        ? this.shutdownController.signal
        : AbortSignal.any([signal, this.shutdownController.signal]);
    const run: Promise<DecideResult> = this.requestQueue
      .then(() => this.decideNow(request, modelId, activeSignal))
      .catch((error: unknown): DecideResult => ({
        ok: false,
        error: {
          type: activeSignal.aborted ? "inference_timeout" : "inference_failed",
          message: error instanceof Error ? error.message : "local inference failed",
        },
      }));
    this.requestQueue = run;
    return run;
  }

  private async decideNow(
    request: SystemOneRequest,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<DecideResult> {
    signal?.throwIfAborted();
    const questions = questionEntries(request);
    const unsupported = questions.find(
      ([, question]) =>
        question.type === "choice" &&
        Object.keys(question.criteria).length > DECIDE_LIMITS.maxLabels,
    );
    if (unsupported !== undefined) {
      return {
        ok: false,
        error: {
          type: "local_question_unsupported",
          message: `builtin GGUF models support at most ${DECIDE_LIMITS.maxLabels} choice options`,
        },
      };
    }
    const model = findInstalled(this.options.home, modelId);
    if (model === undefined) {
      return {
        ok: false,
        error: { type: "unknown_model", message: `no installed model named ${modelId}` },
      };
    }
    let engine: DecisionEngine;
    try {
      engine = await this.engineFor(model);
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "engine_unavailable",
          message: error instanceof Error ? error.message : "engine failed to load",
        },
      };
    }

    const answers: Record<string, LocalAnswer> = {};
    const diagnostics: Record<string, LocalQuestionDiagnostic> = {};
    let inputTokens = 0;
    try {
      signal?.throwIfAborted();
      for (const [name, question] of questions) {
        signal?.throwIfAborted();
        const labels = answerLabels(question);
        const prompt = decisionPrompt(request.state, question);
        const distribution = await engine.firstTokenDistribution(prompt, signal);
        inputTokens += distribution.inputTokens;
        const mass = aggregateMass(distribution.entries, labels);
        const outcome = outcomeFromMass(mass, labels);
        if (outcome === null) {
          return {
            ok: false,
            error: {
              type: "inference_unreadable",
              message: `model assigned no probability mass to allowed labels for ${name}`,
            },
          };
        }
        answers[name] = toLocalAnswer(question, outcome);
        diagnostics[name] = {
          coverage: Math.round(outcome.coverage * 1000) / 1000,
          concentration: Math.round(confidenceOf(outcome.distribution) * 1000) / 1000,
        };
      }
    } catch (error) {
      const unavailable = error instanceof EngineUnavailableError;
      return {
        ok: false,
        error: {
          type:
            signal?.aborted === true
              ? "inference_timeout"
              : unavailable
                ? "engine_unavailable"
                : "inference_failed",
          message: error instanceof Error ? error.message : "local inference failed",
        },
      };
    }

    return {
      ok: true,
      response: toLocalResponse(model.id, answers, {
        input_tokens: inputTokens,
        output_tokens: 0,
      }),
      diagnostics,
    };
  }

  async dispose(): Promise<void> {
    this.shutdownController.abort();
    await this.requestQueue.catch(() => {});
    const engines = [...this.engines.values()];
    this.engines.clear();
    await Promise.all(engines.map((entry) => entry.engine.dispose().catch(() => {})));
  }
}
