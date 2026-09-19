import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LocalBackendConfig, SysoneConfig } from "./config.ts";
import { builtinCandidates } from "./local/runner.ts";
import { modelsDir, type InstalledModel } from "./local/store.ts";
import type { BackendCandidate } from "./router.ts";

export const HOSTED_BACKEND_NAME = "typesafe";

export interface RuntimeBackend extends BackendCandidate {
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

/**
 * Build the runtime backend list from config and environment. The hosted Jev
 * backend exists only when enabled and an API key is present in the configured
 * env var; keys are read from the environment, never from the config file.
 * When `home` is given and `local.enabled` is on, every installed GGUF joins
 * as a builtin `local-<id>` pseudo-backend served by the in-process runner.
 */
export function runtimeBackends(
  config: SysoneConfig,
  env: NodeJS.ProcessEnv,
  home?: string,
): RuntimeBackend[] {
  const backends: RuntimeBackend[] = [];
  if (config.hosted.enabled) {
    const apiKey = env[config.hosted.api_key_env];
    if (apiKey !== undefined && apiKey.length > 0) {
      backends.push({
        name: HOSTED_BACKEND_NAME,
        kind: "hosted",
        available: false,
        models: [config.hosted.model],
        size_b: null,
        cost_rank: 0,
        base_url: config.hosted.base_url.replace(/\/+$/, ""),
        headers: { authorization: `Bearer ${apiKey}` },
        default_model: config.hosted.model,
      });
    }
  }
  for (const local of config.backends) {
    if (!local.enabled) continue;
    backends.push(localRuntimeBackend(local));
  }
  if (home !== undefined && config.local.enabled) {
    for (const candidate of builtinCandidates(home, true)) {
      backends.push({
        name: candidate.name,
        kind: "local",
        available: candidate.available,
        models: candidate.models,
        size_b: candidate.size_b,
        cost_rank: candidate.cost_rank,
        specialist: candidate.specialist,
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
  return {
    name: local.name,
    kind: "local",
    available: false,
    models: [local.model],
    size_b: local.size_b ?? null,
    cost_rank: local.cost_rank ?? 0,
    base_url: local.base_url.replace(/\/+$/, ""),
    headers: {},
    default_model: local.model,
  };
}

/**
 * Best-effort `GET /v1/limits`: backends that publish openjev-style request
 * limits (e.g. Nimble's 26-option cap) get those merged into their routing
 * capabilities. Any failure leaves capabilities untouched — an unpublished
 * limit means unbounded, not zero.
 */
async function probeLimits(
  backend: RuntimeBackend,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<void> {
  try {
    const response = await fetchFn(`${backend.base_url}/v1/limits`, {
      method: "GET",
      headers: { accept: "application/json", ...backend.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return;
    const parsed = limitsResponseSchema.safeParse(await response.json());
    if (!parsed.success) return;
    const caps = backend.capabilities ?? {};
    if (parsed.data.max_answers_per_question !== undefined) {
      caps.maxOptions = parsed.data.max_answers_per_question;
    }
    if (parsed.data.max_questions !== undefined) {
      caps.maxQuestions = parsed.data.max_questions;
    }
    backend.capabilities = caps;
  } catch {
    // limits probing is advisory only
  }
}

export async function probeBackend(
  backend: RuntimeBackend,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<ProbeResult> {
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
    const response = await fetchFn(`${backend.base_url}/v1/models`, {
      method: "GET",
      headers: { accept: "application/json", ...backend.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - started;
    if (!response.ok) {
      return {
        available: false,
        models: backend.models,
        latency_ms: latency,
        detail: `GET /v1/models -> ${response.status}`,
      };
    }
    const body: unknown = await response.json();
    const models = extractModelIds(body);
    await probeLimits(backend, timeoutMs, fetchFn);
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
      detail: error instanceof Error ? error.name : "probe_failed",
    };
  }
}

export async function probeAll(
  backends: RuntimeBackend[],
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, ProbeResult>> {
  const results = await Promise.all(
    backends.map(async (backend) => {
      const result = await probeBackend(backend, timeoutMs, fetchFn);
      backend.available = result.available;
      backend.models = result.models;
      return [backend.name, result] as const;
    }),
  );
  return new Map(results);
}

export type ForwardResult =
  | { kind: "response"; status: number; body: string; content_type: string }
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
  try {
    const response = await fetchFn(`${backend.base_url}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...backend.headers,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return {
      kind: "response",
      status: response.status,
      body: text.slice(0, 4_194_304),
      content_type: response.headers.get("content-type") ?? "application/json",
    };
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "TimeoutError"
        ? "backend timeout"
        : error instanceof Error
          ? error.name
          : "transport failure";
    return { kind: "transport", detail };
  }
}
