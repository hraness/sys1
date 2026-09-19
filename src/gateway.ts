import {
  forwardToBackend,
  probeAll,
  runtimeBackends,
  type RuntimeBackend,
} from "./backends.ts";
import type { SysoneConfig } from "./config.ts";
import {
  LocalRunner,
  defaultEngineFactory,
  type DecideResult,
} from "./local/runner.ts";
import {
  PROTOCOL_LIMITS,
  errorBody,
  serializedBytes,
  systemOneRequestSchema,
  type SystemOneRequest,
} from "./protocol.ts";
import { chooseBackend } from "./router.ts";

export const SYSONE_VERSION = "0.3.0";
const MAX_ATTEMPTS = 2;

export interface GatewayDeps {
  config: SysoneConfig;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /**
   * Re-read config per request so `sysone config set` / `backend add` take
   * effect on a running daemon. May throw; a thrown read answers 503.
   */
  reloadConfig?: () => SysoneConfig;
  /**
   * State directory. Required for builtin local models; when absent the
   * gateway only serves URL-registered and hosted backends.
   */
  home?: string;
  /** Injectable local runner (tests substitute a fake engine factory). */
  localRunner?: LocalRunner;
}

function currentConfig(deps: GatewayDeps): SysoneConfig {
  return deps.reloadConfig === undefined ? deps.config : deps.reloadConfig();
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Model id a backend should see for one request. A caller-pinned
 * `backend/model` resolves to its model part; a bare model passes through;
 * `auto`/absent resolves to the backend's configured default.
 */
function forwardModel(requested: string | undefined, backend: RuntimeBackend): string {
  if (requested === undefined || requested === "auto") return backend.default_model;
  const slash = requested.indexOf("/");
  if (slash > 0) return requested.slice(slash + 1);
  return requested;
}

export function createFetchHandler(deps: GatewayDeps): (req: Request) => Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  let runner: LocalRunner | null = deps.localRunner ?? null;

  function localRunner(config: SysoneConfig): LocalRunner | null {
    if (deps.home === undefined) return null;
    if (runner === null) {
      runner = new LocalRunner({
        home: deps.home,
        maxLoadedModels: config.local.max_loaded_models,
        engineFactory: defaultEngineFactory(
          config.local.context_tokens,
          config.local.eval_timeout_ms,
        ),
      });
    }
    return runner;
  }

  async function boundedLocalDecision(
    active: LocalRunner,
    body: SystemOneRequest,
    modelId: string,
    timeoutMs: number,
  ): Promise<DecideResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DecideResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          ok: false,
          error: { type: "inference_timeout", message: "local inference timed out" },
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        active.decide(body, modelId, controller.signal),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function loadActiveConfig(): SysoneConfig | Response {
    try {
      return currentConfig(deps);
    } catch (error) {
      return json(
        errorBody(
          "config_invalid",
          error instanceof Error ? error.message : "config could not be loaded",
        ),
        503,
      );
    }
  }

  async function handleModels(): Promise<Response> {
    const config = loadActiveConfig();
    if (config instanceof Response) return config;
    const backends = runtimeBackends(config, deps.env, deps.home);
    await probeAll(backends, config.gateway.probe_timeout_ms, fetchFn);
    const data = backends.flatMap((backend) =>
      backend.models.map((id) => ({
        id,
        backend: backend.name,
        kind: backend.kind,
        available: backend.available,
      })),
    );
    return json({ object: "list", data });
  }

  async function handleSystemOne(request: Request): Promise<Response> {
    const lengthHeader = request.headers.get("content-length");
    if (lengthHeader !== null && Number(lengthHeader) > PROTOCOL_LIMITS.maxBodyBytes) {
      return json(errorBody("request_too_large", "body exceeds 1 MiB"), 413);
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > PROTOCOL_LIMITS.maxBodyBytes) {
      return json(errorBody("request_too_large", "body exceeds 1 MiB"), 413);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return json(errorBody("invalid_json", "request body is not valid JSON"), 400);
    }
    const parsed = systemOneRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? "" : `${issue.path.join(".")}: `;
      const what = issue === undefined ? "invalid request" : issue.message;
      return json(errorBody("invalid_request", `${where}${what}`), 422);
    }
    const body: SystemOneRequest = parsed.data;
    if (serializedBytes(body.state) > PROTOCOL_LIMITS.maxStateBytes) {
      return json(errorBody("request_too_large", "state exceeds 256 KiB"), 413);
    }

    const config = loadActiveConfig();
    if (config instanceof Response) return config;
    const backends = runtimeBackends(config, deps.env, deps.home);
    if (backends.length === 0) {
      return json(
        errorBody(
          "no_backend_configured",
          "no backends configured; set TYPESAFE_API_KEY, run `sysone pull`, or add a backend with `sysone backend add`",
        ),
        503,
      );
    }
    await probeAll(backends, config.gateway.probe_timeout_ms, fetchFn);

    const policy = config.routing.policy;
    const pinned = body.model !== undefined && body.model.includes("/");
    let remaining = backends;
    let lastTransport: string | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && remaining.length > 0; attempt += 1) {
      const choice = chooseBackend(policy, body.model, remaining);
      if (!choice.ok) {
        if (lastTransport !== null && choice.reason === "no_backend_available") break;
        const status = choice.reason === "unknown_model" ? 404 : 503;
        return json(errorBody(choice.reason, choice.detail), status);
      }
      const backend = choice.backend;
      let result;
      if (backend.builtin !== undefined) {
        const active = localRunner(config);
        if (active === null) {
          result = { kind: "transport" as const, detail: "local runner unavailable" };
        } else {
          const decided = await boundedLocalDecision(
            active,
            body,
            backend.builtin.model.id,
            config.gateway.request_timeout_ms,
          );
          result = decided.ok
            ? {
                kind: "response" as const,
                status: 200,
                body: JSON.stringify(decided.response),
                content_type: "application/json",
              }
            : { kind: "transport" as const, detail: decided.error?.type ?? "local_failed" };
        }
      } else {
        result = await forwardToBackend(
          backend,
          rawBody,
          forwardModel(body.model, backend),
          config.gateway.request_timeout_ms,
          fetchFn,
        );
      }
      if (result.kind === "response") {
        return new Response(result.body, {
          status: result.status,
          headers: {
            "content-type": result.content_type,
            "x-sysone-backend": backend.name,
            "x-sysone-attempts": String(attempt + 1),
          },
        });
      }
      lastTransport = result.detail;
      if (pinned) break;
      remaining = remaining.filter((candidate) => candidate.name !== backend.name);
    }

    return json(
      errorBody(
        "no_backend_available",
        `no reachable backend answered the request${lastTransport === null ? "" : ` (${lastTransport})`}`,
      ),
      503,
    );
  }

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, version: SYSONE_VERSION });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return handleModels();
    }
    if (request.method === "POST" && url.pathname === "/v1/systemone") {
      return handleSystemOne(request);
    }
    return json(errorBody("not_found", "unknown route"), 404);
  };
}

export interface RunningGateway {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

export function startGateway(deps: GatewayDeps & { port?: number }): RunningGateway {
  const localRunner =
    deps.localRunner ??
    (deps.home === undefined
      ? undefined
      : new LocalRunner({
          home: deps.home,
          maxLoadedModels: deps.config.local.max_loaded_models,
          engineFactory: defaultEngineFactory(
            deps.config.local.context_tokens,
            deps.config.local.eval_timeout_ms,
          ),
        }));
  const handler = createFetchHandler({ ...deps, ...(localRunner === undefined ? {} : { localRunner }) });
  const server = Bun.serve({
    hostname: deps.config.gateway.host,
    port: deps.port ?? deps.config.gateway.port,
    fetch: handler,
    // Bound concurrent intake; this gateway is a loopback service for local agents.
    maxRequestBodySize: PROTOCOL_LIMITS.maxBodyBytes,
  });
  const boundPort = server.port ?? deps.port ?? deps.config.gateway.port;
  return {
    url: `http://${deps.config.gateway.host}:${boundPort}`,
    port: boundPort,
    stop: async () => {
      const disposing = localRunner?.dispose();
      await server.stop(true);
      if (disposing !== undefined) await disposing;
    },
  };
}
