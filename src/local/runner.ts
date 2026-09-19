import { lstatSync, readFileSync } from "node:fs";
import type { SystemOneRequest } from "../protocol.ts";
import {
  needleAnswers,
  needlePrompt,
  needleTools,
  scorerAnswer,
  scorerInput,
} from "./adapt.ts";
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
  NEEDLE_LIMITS,
  NeedleEngineError,
  runNeedleTurn,
  type NeedleTurn,
} from "./needle.ts";
import { SCORER_LIMITS, loadScorer, type OptionScorer } from "./scorer.ts";
import {
  MODEL_LIMITS,
  engineFilePath,
  findInstalled,
  installedModels,
  modelFilePath,
  type InstalledModel,
} from "./store.ts";

/**
 * The builtin local backend. Each installed model registers as a
 * pseudo-backend named `local-<id>`; the runner lazily loads weights on first
 * use, serializes work per model, and caps residency. `gguf` models run
 * through the llama.cpp engine; `scorer` checkpoints run in-process through
 * the option scorer; `needle` models spawn one bounded engine process per
 * request with telemetry disabled.
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
  specialist: boolean;
  capabilities: { maxOptions?: number; maxQuestions?: number };
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
    // Only generic GGUF models may absorb unpinned fallback traffic; scorer
    // and needle checkpoints are specialists that serve named requests only.
    specialist: model.kind !== "gguf",
    capabilities:
      model.kind === "scorer"
        ? { maxOptions: SCORER_LIMITS.maxOptions }
        : model.kind === "needle"
          ? { maxQuestions: NEEDLE_LIMITS.maxArguments }
          : { maxOptions: DECIDE_LIMITS.maxLabels },
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
  /** Per-request spawn bound for needle engine processes. */
  needleTimeoutMs?: number;
  /** Injectable process spawn for needle turns (tests only). */
  needleSpawnFn?: typeof Bun.spawn;
}

export type LocalAdapter = "generic-gguf" | "option-scorer" | "needle-extract";

export interface LocalQuestionDiagnostic {
  coverage: number;
  concentration: number;
}

export interface DecideResult {
  ok: boolean;
  adapter?: LocalAdapter;
  response?: LocalResponse;
  diagnostics?: Record<string, LocalQuestionDiagnostic>;
  error?: { type: string; message: string };
}

export class LocalRunner {
  private readonly options: RunnerOptions;
  private readonly engines = new Map<string, { engine: DecisionEngine; touched: number }>();
  private readonly scorers = new Map<string, { scorer: OptionScorer; touched: number }>();
  private readonly shutdownController = new AbortController();
  private requestQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  /** Loaded model ids, for status reporting. */
  loadedModels(): string[] {
    return [...this.engines.keys(), ...this.scorers.keys()];
  }

  private residentCount(): number {
    return this.engines.size + this.scorers.size;
  }

  private async evictOldest(): Promise<void> {
    let oldest: { map: "engine" | "scorer"; id: string; touched: number } | null = null;
    for (const [id, entry] of this.engines) {
      if (oldest === null || entry.touched < oldest.touched) {
        oldest = { map: "engine", id, touched: entry.touched };
      }
    }
    for (const [id, entry] of this.scorers) {
      if (oldest === null || entry.touched < oldest.touched) {
        oldest = { map: "scorer", id, touched: entry.touched };
      }
    }
    if (oldest === null) return;
    if (oldest.map === "engine") {
      const stale = this.engines.get(oldest.id);
      this.engines.delete(oldest.id);
      if (stale !== undefined) await stale.engine.dispose().catch(() => {});
    } else {
      this.scorers.delete(oldest.id);
    }
  }

  private async engineFor(model: InstalledModel): Promise<DecisionEngine> {
    const cached = this.engines.get(model.id);
    if (cached !== undefined) {
      cached.touched = Date.now();
      return cached.engine;
    }
    if (this.residentCount() >= this.options.maxLoadedModels) {
      await this.evictOldest();
    }
    const engine = this.options.engineFactory(model, modelFilePath(this.options.home, model));
    this.engines.set(model.id, { engine, touched: Date.now() });
    return engine;
  }

  private scorerFor(model: InstalledModel): OptionScorer {
    const cached = this.scorers.get(model.id);
    if (cached !== undefined) {
      cached.touched = Date.now();
      return cached.scorer;
    }
    // Scorers are ~3 MB of in-process tensors. When at capacity, evict the
    // oldest scorer synchronously; if none is evictable, allow one extra
    // tiny resident rather than blocking on an engine dispose.
    if (this.residentCount() >= this.options.maxLoadedModels && this.scorers.size > 0) {
      let oldestId: string | null = null;
      let oldest = Number.MAX_SAFE_INTEGER;
      for (const [id, entry] of this.scorers) {
        if (entry.touched < oldest) {
          oldest = entry.touched;
          oldestId = id;
        }
      }
      if (oldestId !== null) this.scorers.delete(oldestId);
    }
    const path = modelFilePath(this.options.home, model);
    if (lstatSync(path).size > MODEL_LIMITS.maxScorerBytes) {
      throw new Error("scorer checkpoint exceeds the 256 MiB bound");
    }
    const scorer = loadScorer(new Uint8Array(readFileSync(path)));
    this.scorers.set(model.id, { scorer, touched: Date.now() });
    return scorer;
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
    const model = findInstalled(this.options.home, modelId);
    if (model === undefined) {
      return {
        ok: false,
        error: { type: "unknown_model", message: `no installed model named ${modelId}` },
      };
    }
    if (model.kind === "scorer") return this.decideScorer(request, model, signal);
    if (model.kind === "needle") return this.decideNeedle(request, model, signal);
    return this.decideGguf(request, model, signal);
  }

  private async decideScorer(
    request: SystemOneRequest,
    model: InstalledModel,
    signal?: AbortSignal,
  ): Promise<DecideResult> {
    const questions = questionEntries(request);
    const unsupported = questions.find(([, question]) => {
      if (question.type === "choice" && Object.keys(question.criteria).length > SCORER_LIMITS.maxOptions) {
        return true;
      }
      return question.type === "score" && question.criteria.length > SCORER_LIMITS.maxOptions;
    });
    if (unsupported !== undefined) {
      return {
        ok: false,
        error: {
          type: "local_question_unsupported",
          message: `option-scorer checkpoints support at most ${SCORER_LIMITS.maxOptions} options per question`,
        },
      };
    }
    let scorer: OptionScorer;
    try {
      scorer = this.scorerFor(model);
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "engine_unavailable",
          message: error instanceof Error ? error.message : "scorer checkpoint failed to load",
        },
      };
    }
    const answers: Record<string, LocalAnswer> = {};
    const diagnostics: Record<string, LocalQuestionDiagnostic> = {};
    try {
      for (const [name, question] of questions) {
        signal?.throwIfAborted();
        const input = scorerInput(
          request.state,
          question,
          scorer.config.contextTokens,
          scorer.config.optionTokens,
        );
        const distribution = scorer.score(input.context, input.options);
        answers[name] = scorerAnswer(question, input.keys, distribution);
        diagnostics[name] = {
          coverage: 1,
          concentration: Math.round(confidenceOf(distribution) * 1000) / 1000,
        };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          type: signal?.aborted === true ? "inference_timeout" : "inference_failed",
          message: error instanceof Error ? error.message : "scorer inference failed",
        },
      };
    }
    return {
      ok: true,
      adapter: "option-scorer",
      response: toLocalResponse(model.id, answers, { input_tokens: 0, output_tokens: 0 }),
      diagnostics,
    };
  }

  private async decideNeedle(
    request: SystemOneRequest,
    model: InstalledModel,
    signal?: AbortSignal,
  ): Promise<DecideResult> {
    if (Object.keys(request.questions).length > NEEDLE_LIMITS.maxArguments) {
      return {
        ok: false,
        error: {
          type: "local_question_unsupported",
          message: `needle adapters support at most ${NEEDLE_LIMITS.maxArguments} questions per request`,
        },
      };
    }
    const enginePath = engineFilePath(this.options.home, model);
    if (enginePath === null) {
      return {
        ok: false,
        error: { type: "engine_unavailable", message: `no needle engine for ${model.id}` },
      };
    }
    const { toolsJson } = needleTools(request);
    const prompt = needlePrompt(request.state);
    let turn: NeedleTurn;
    try {
      turn = await runNeedleTurn(
        {
          enginePath,
          weightsPath: modelFilePath(this.options.home, model),
          home: this.options.home,
          timeoutMs: this.options.needleTimeoutMs ?? 60_000,
          ...(this.options.needleSpawnFn === undefined
            ? {}
            : { spawnFn: this.options.needleSpawnFn }),
        },
        toolsJson,
        prompt,
        signal,
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          type:
            signal?.aborted === true
              ? "inference_timeout"
              : error instanceof NeedleEngineError
                ? "engine_unavailable"
                : "inference_failed",
          message: error instanceof Error ? error.message : "needle turn failed",
        },
      };
    }
    const call = turn.calls.find((candidate) => candidate.name === "evaluate");
    if (call === undefined) {
      return {
        ok: false,
        error: {
          type: "inference_unreadable",
          message:
            turn.suppressed.length > 0
              ? "needle withheld its call below the grounding floor"
              : "needle produced no evaluate call",
        },
      };
    }
    const { answers, missing } = needleAnswers(request, call.arguments, turn.confidence);
    if (missing.length > 0) {
      return {
        ok: false,
        error: {
          type: "inference_unreadable",
          message: `needle returned no usable value for ${missing.join(", ")}`,
        },
      };
    }
    const confidence = turn.confidence ?? 0;
    const diagnostics: Record<string, LocalQuestionDiagnostic> = {};
    for (const [name, answer] of Object.entries(answers)) {
      diagnostics[name] = {
        coverage: 1,
        concentration:
          answer.type === "noul"
            ? Math.round(Math.max(answer.noul, 1 - answer.noul) * 1000) / 1000
            : Math.round(confidence * 1000) / 1000,
      };
    }
    return {
      ok: true,
      adapter: "needle-extract",
      response: toLocalResponse(model.id, answers, { input_tokens: 0, output_tokens: 0 }),
      diagnostics,
    };
  }

  private async decideGguf(
    request: SystemOneRequest,
    model: InstalledModel,
    signal?: AbortSignal,
  ): Promise<DecideResult> {
    const questions = questionEntries(request);
    const unsupported = questions.find(([, question]) =>
      question.type === "choice"
        ? Object.keys(question.criteria).length > DECIDE_LIMITS.maxLabels
        : question.type === "score" && question.criteria.length > DECIDE_LIMITS.maxLabels,
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
      adapter: "generic-gguf",
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
    this.scorers.clear();
    await Promise.all(engines.map((entry) => entry.engine.dispose().catch(() => {})));
  }
}
