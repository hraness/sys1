import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isLoopbackHost, type LocalBackendConfig, type Sys1Config } from "./config.ts";
import { HttpBodyLimitError, readBoundedText } from "./http.ts";
import { builtinCandidates } from "./local/runner.ts";
import { modelsDir, type InstalledModel } from "./local/store.ts";
import { errorBody } from "./protocol.ts";
import type { BackendCandidate, BackendCapabilities } from "./router.ts";

import { CLEF_MODELS, clefEndpoint, clefRequestSchema, cloudflareCredentials, type ClefModel } from "./clef.ts";

export const HOSTED_BACKEND_NAME = "cloudflare";
export const LEGACY_HOSTED_BACKEND_NAME = "typesafe";
const MAX_PROBE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 4_194_304;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function fetchUntilAborted(fetchFn: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
      return;
    }
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return fetchFn(url, init);
    }).then((response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      resolve(response);
    }, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function boundedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export interface RuntimeBackend extends BackendCandidate {
  adapter?: "systemone" | "kev" | "clef";
  cloudflare_account?: string;
  base_url: string;
  headers: Record<string, string>;
  /** Model id forwarded in the request body when the caller did not pin one. */
  default_model: string;
  /**
   * Present when this backend is a builtin local model served by the
   * in-process runner rather than an HTTP endpoint. `base_url` is empty.
   */
  builtin?: { model: InstalledModel; path: string };
}

export interface ProbeResult {
  available: boolean;
  models: string[];
  latency_ms: number | null;
  detail: string | null;
}

const modelsResponseSchema = z.union([
  z.object({ data: z.array(z.union([z.string(), z.object({ id: z.string() })])) }),
  z.object({ models: z.array(z.union([z.string(), z.object({ id: z.string() })])) }),
  z.array(z.union([z.string(), z.object({ id: z.string() })])),
]);

const limitsResponseSchema = z
  .object({
    max_answers_per_question: z.number().int().positive().optional(),
    max_questions: z.number().int().positive().optional(),
  })
  .loose();

export function extractModelIds(body: unknown): string[] {
  const parsed = modelsResponseSchema.safeParse(body);
  if (!parsed.success) return [];
  const list = Array.isArray(parsed.data)
    ? parsed.data
    : "data" in parsed.data
      ? parsed.data.data
      : parsed.data.models;
  return list
    .map((entry) => (typeof entry === "string" ? entry : entry.id))
    .filter((id) => id.length > 0)
    .slice(0, 512);
}

export function extractBackendCapabilities(body: unknown): BackendCapabilities | null {
  const parsed = limitsResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  return {
    ...(parsed.data.max_answers_per_question === undefined
      ? {}
      : { maxOptions: parsed.data.max_answers_per_question }),
    ...(parsed.data.max_questions === undefined
      ? {}
      : { maxQuestions: parsed.data.max_questions }),
  };
}

function constrainedCapabilities(
  configured: BackendCapabilities | undefined,
  published: BackendCapabilities,
): BackendCapabilities {
  const maxOptions =
    configured?.maxOptions === undefined
      ? published.maxOptions
      : published.maxOptions === undefined
        ? configured.maxOptions
        : Math.min(configured.maxOptions, published.maxOptions);
  const maxQuestions =
    configured?.maxQuestions === undefined
      ? published.maxQuestions
      : published.maxQuestions === undefined
        ? configured.maxQuestions
        : Math.min(configured.maxQuestions, published.maxQuestions);
  return {
    ...(maxOptions === undefined ? {} : { maxOptions }),
    ...(maxQuestions === undefined ? {} : { maxQuestions }),
  };
}

/**
 * Build the runtime backend list from config and environment. The hosted Jev
 * backend exists only when enabled and an API key is present in the configured
 * env var; keys are read from the environment, never from the config file.
 * When `home` is given and `local.enabled` is on, every installed GGUF joins
 * as a builtin `local-<id>` pseudo-backend served by the in-process runner.
 * Only config.local.model is eligible for automatic local routing. Other
 * installed models and URL-registered backends require an explicit request pin.
 */
export function runtimeBackends(
  config: Sys1Config,
  env: NodeJS.ProcessEnv,
  home?: string,
): RuntimeBackend[] {
  const backends: RuntimeBackend[] = [];
  if (config.hosted.enabled) {
    const credentials = config.hosted.provider === "cloudflare" ? cloudflareCredentials(env) : null;
    const apiKey = config.hosted.provider === "cloudflare" ? credentials?.token : env[config.hosted.api_key_env];
    if (apiKey !== undefined && apiKey.length > 0) {
      backends.push({
        name: config.hosted.provider === "cloudflare" ? HOSTED_BACKEND_NAME : LEGACY_HOSTED_BACKEND_NAME,
        kind: "hosted",
        available: false,
        models: config.hosted.provider === "cloudflare" ? [...CLEF_MODELS] : [config.hosted.model],
        size_b: null,
        cost_rank: 0,
        base_url: trimTrailingSlashes(config.hosted.base_url),
        headers: { authorization: `Bearer ${apiKey}` },
        default_model: config.hosted.model,
        ...(credentials === null ? {} : { adapter: "clef" as const, cloudflare_account: credentials.accountId, capabilities: { images: true, maxQuestions: 64, maxOptions: 255 } }),
      });
    }
  }
  for (const local of config.backends) {
    if (!local.enabled) continue;
    backends.push(localRuntimeBackend(local));
  }
  if (home !== undefined && config.local.enabled && config.routing.policy !== "hosted-only") {
    for (const candidate of builtinCandidates(home, true, config.local.model)) {
      backends.push({
        name: candidate.name,
        kind: "local",
        available: candidate.available,
        models: candidate.models,
        size_b: candidate.size_b,
        cost_rank: candidate.cost_rank,
        explicitOnly: candidate.explicitOnly,
        capabilities: candidate.capabilities,
        base_url: "",
        headers: {},
        default_model: candidate.model.id,
        builtin: {
          model: candidate.model,
          path: join(modelsDir(home), candidate.model.file),
        },
      });
    }
  }
  return backends;
}

function localRuntimeBackend(local: LocalBackendConfig): RuntimeBackend {
  const hostname = new URL(local.base_url).hostname;
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return {
    name: local.name,
    explicitOnly: true,
    // Operator ownership does not make an off-machine service local. Policy
    // boundaries follow where the request goes, not how it was registered.
    kind: isLoopbackHost(host) ? "local" : "hosted",
    available: false,
    models: [local.model],
    size_b: local.size_b ?? null,
    cost_rank: local.cost_rank ?? 0,
    ...(local.capabilities === undefined
      ? {}
      : {
          capabilities: {
            ...(local.capabilities.max_options === undefined
              ? {}
              : { maxOptions: local.capabilities.max_options }),
            ...(local.capabilities.max_questions === undefined
              ? {}
              : { maxQuestions: local.capabilities.max_questions }),
          },
        }),
    base_url: trimTrailingSlashes(local.base_url),
    headers: {},
    default_model: local.model,
    ...(local.adapter === undefined ? {} : { adapter: local.adapter }),
  };
}

/**
 * Best-effort `GET /v1/limits`: backends that publish openjev-style request
 * limits get those merged into their routing capabilities. Any failure leaves
 * capabilities untouched — an unpublished limit means unbounded, not zero.
 */
async function probeLimits(
  backend: RuntimeBackend,
  timeoutMs: number,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const activeSignal = boundedSignal(timeoutMs, signal);
    activeSignal.throwIfAborted();
    const response = await fetchUntilAborted(fetchFn, `${backend.base_url}/v1/limits`, {
      method: "GET",
      headers: { accept: "application/json", ...backend.headers },
      redirect: "manual",
      signal: activeSignal,
    }, activeSignal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    const published = extractBackendCapabilities(
      JSON.parse(await readBoundedText(response, MAX_PROBE_BYTES, activeSignal)) as unknown,
    );
    if (published === null) return;
    backend.capabilities = constrainedCapabilities(backend.capabilities, published);
  } catch {
    // limits probing is advisory only
  }
}

export async function probeBackend(
  backend: RuntimeBackend,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  signal?.throwIfAborted();
  if (backend.builtin !== undefined) {
    const present = existsSync(backend.builtin.path);
    return {
      available: present,
      models: backend.models,
      latency_ms: 0,
      detail: present ? null : "model file missing",
    };
  }
  const started = Date.now();
  try {
    const activeSignal = boundedSignal(timeoutMs, signal);
    const discoveryPath = backend.adapter === "clef" ? `/accounts/${backend.cloudflare_account}/ai/models/search?search=clef` : "/v1/models";
    const response = await fetchUntilAborted(fetchFn, `${backend.base_url}${discoveryPath}`, {
      method: "GET",
      headers: { accept: "application/json", ...backend.headers },
      redirect: "manual",
      signal: activeSignal,
    }, activeSignal);
    const latency = Date.now() - started;
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return {
        available: false,
        models: backend.models,
        latency_ms: latency,
        detail: `GET ${backend.adapter === "clef" ? "Cloudflare model catalog" : "/v1/models"} -> ${response.status}`,
      };
    }
    const body: unknown = JSON.parse(await readBoundedText(response, MAX_PROBE_BYTES, activeSignal));
    if (backend.adapter === "clef") {
      const catalog = z.object({ success: z.literal(true), result: z.array(z.object({ name: z.string() })).max(512) }).parse(body);
      const models = CLEF_MODELS.filter((model) => catalog.result.some((entry) => entry.name === `@cf/cloudflare/${model}`));
      const available = models.includes(backend.default_model as ClefModel);
      return { available, models, latency_ms: latency, detail: available ? null : "configured Clef model not listed in Cloudflare catalog" };
    }
    const models = extractModelIds(body);
    await probeLimits(backend, timeoutMs, fetchFn, signal);
    return {
      available: true,
      models: models.length > 0 ? models : backend.models,
      latency_ms: latency,
      detail: null,
    };
  } catch (error) {
    return {
      available: false,
      models: backend.models,
      latency_ms: null,
      detail: backend.adapter === "clef" ? "Cloudflare model catalog unavailable"
        : error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name) ? error.name : "probe_failed",
    };
  }
}

export async function probeAll(
  backends: RuntimeBackend[],
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Map<string, ProbeResult>> {
  const results = await Promise.all(
    backends.map(async (backend) => {
      const result = await probeBackend(backend, timeoutMs, fetchFn, signal);
      backend.available = result.available;
      backend.models = result.models;
      return [backend.name, result] as const;
    }),
  );
  return new Map(results);
}

export type ForwardResult =
  | { kind: "response"; status: number; body: string; content_type: string; generated_error?: true }
  | { kind: "transport"; detail: string };

/**
 * Forward one already-validated System One request body to a backend. Only
 * transport failures (no HTTP response at all) report `transport`; any HTTP
 * response — including backend errors — is definitive and passed through.
 */
export async function forwardToBackend(
  backend: RuntimeBackend,
  rawBody: string,
  resolvedModel: string | undefined,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ForwardResult> {
  let body = rawBody;
  if (resolvedModel !== undefined) {
    // The caller pinned a model this backend serves under a different id;
    // rewrite the model field for this hop.
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      parsed["model"] = resolvedModel;
      body = JSON.stringify(parsed);
    } catch {
      // body was already schema-validated; keep it unchanged on a parse surprise
    }
  }
  let endpoint = `${backend.base_url}/v1/systemone`;
  if (backend.adapter === "clef") {
    try {
      const request = clefRequestSchema.parse(JSON.parse(body) as unknown);
      endpoint = clefEndpoint(backend.cloudflare_account ?? "", request.model);
      body = JSON.stringify(request);
    } catch {
      return { kind: "response", status: 422, body: JSON.stringify(errorBody("request_unsupported", "request does not meet Cloudflare Clef input requirements")), content_type: "application/json" };
    }
  } else {
    try {
      const request = JSON.parse(body) as { images?: unknown[] };
      if ((request.images?.length ?? 0) > 0) return { kind: "response", status: 422, body: JSON.stringify(errorBody("request_unsupported", "backend does not support images")), content_type: "application/json" };
    } catch {
      return { kind: "response", status: 422, body: JSON.stringify(errorBody("invalid_request", "invalid request body")), content_type: "application/json" };
    }
  }
  const activeSignal = boundedSignal(timeoutMs, signal);
  let response: Response;
  try {
    activeSignal.throwIfAborted();
    response = await fetchUntilAborted(fetchFn, endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...backend.headers,
      },
      body,
      redirect: "manual",
      signal: activeSignal,
    }, activeSignal);
  } catch (error) {
    if (backend.adapter === "clef") {
      return {
        kind: "response", status: 503, generated_error: true,
        body: JSON.stringify(errorBody("backend_outcome_uncertain", "Cloudflare Clef request outcome is unknown; the request was not retried")),
        content_type: "application/json",
      };
    }
    const detail =
      error instanceof Error && error.name === "TimeoutError"
        ? "backend timeout"
        : error instanceof Error
          ? error.name
          : "transport failure";
    return { kind: "transport", detail };
  }
  // Receiving HTTP headers makes this attempt definitive. A reset, timeout,
  // or oversized body after that point must never cause another dispatch.
  try {
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES, activeSignal);
    return {
      kind: "response",
      status: response.status,
      body: text,
      content_type: response.headers.get("content-type") ?? "application/json",
    };
  } catch (error) {
    return {
      kind: "response",
      status: 502,
      body: JSON.stringify(errorBody(
        error instanceof HttpBodyLimitError ? "backend_response_too_large" : "backend_response_unreadable",
        error instanceof HttpBodyLimitError ? "backend response exceeds 4 MiB" : "backend response body could not be read",
      )),
      content_type: "application/json",
    };
  }
}
