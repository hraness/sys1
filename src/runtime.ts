import { createClient, type Sys1Client } from "./client.ts";
import { configSchema, type Sys1Config } from "./config.ts";
import { createFetchHandler } from "./gateway.ts";
import { LocalRunner, defaultEngineFactory } from "./local/runner.ts";
import { errorBody } from "./protocol.ts";

export interface RouterOptions {
  config: Sys1Config;
  /** Explicit credential environment. Pass {} for credential-free routing. */
  env: NodeJS.ProcessEnv;
  /** Explicit model store. Omit to use only registered HTTP or hosted backends. */
  home?: string;
  /** Caller-owned runner: disposal remains the caller's responsibility. */
  localRunner?: LocalRunner;
  /** Optional transport used only for configured remote backends and probes. */
  fetchFn?: typeof fetch;
}

export interface EmbeddedRouter extends Sys1Client {
  /** In-process Fetch handler. Does not listen on any TCP port. */
  fetch(request: Request): Promise<Response>;
  /** Cancel this router's work and dispose its owned local runner. Idempotent. */
  dispose(): Promise<void>;
}

/** Embedded Bun router with explicit configuration and no daemon lifecycle. */
export function createRouter(options: RouterOptions): EmbeddedRouter {
  const config = configSchema.parse(options.config);
  if (options.env === undefined) throw new Error("createRouter requires an explicit env object");
  const owned = options.localRunner === undefined && options.home !== undefined;
  const runner = options.localRunner ?? (options.home === undefined ? undefined : new LocalRunner({
    home: options.home,
    maxLoadedModels: config.local.max_loaded_models,
    engineFactory: defaultEngineFactory(config.local.context_tokens, config.local.eval_timeout_ms),
    needleTimeoutMs: config.gateway.request_timeout_ms,
  }));
  const handler = createFetchHandler({
    config, env: { ...options.env },
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(runner === undefined ? {} : { localRunner: runner }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
  const shutdown = new AbortController();
  let disposal: Promise<void> | undefined;
  const handle = async (request: Request): Promise<Response> => {
    if (shutdown.signal.aborted) {
      return Response.json(errorBody("router_disposed", "embedded router is disposed"), { status: 503 });
    }
    return handler(new Request(request, { signal: AbortSignal.any([request.signal, shutdown.signal]) }));
  };
  const client = createClient({
    timeoutMs: config.gateway.request_timeout_ms,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
  });
  return {
    evaluate: client.evaluate,
    fetch: handle,
    dispose() {
      if (disposal === undefined) {
        shutdown.abort();
        disposal = owned ? runner!.dispose() : Promise.resolve();
      }
      return disposal;
    },
  };
}
