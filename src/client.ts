import { HttpBodyLimitError, readBoundedText } from "./http.ts";
import { validateResponseForRequest } from "./response.ts";
import { adaptKevRequest, adaptKevResponse } from "./kev.ts";
import {
  PROTOCOL_LIMITS,
  systemOneRequestSchema,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./protocol.ts";

export type {
  Answer, ChoiceAnswer, ChoiceQuestion, EntryType, JsonValue, NoulAnswer,
  NoulQuestion, Question, ScoreAnswer, ScoreQuestion, SystemOneRequest,
  SystemOneResponse,
} from "./protocol.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:13900";
const MAX_RESPONSE_BYTES = 4_194_304;

export type ClientErrorCode =
  | "invalid_options" | "invalid_request" | "aborted" | "timeout"
  | "transport_error" | "http_error" | "response_too_large" | "invalid_response";

const ERROR_MESSAGES: Record<ClientErrorCode, string> = {
  invalid_options: "Invalid Sys1 client options",
  invalid_request: "Invalid System One request",
  aborted: "Sys1 request aborted",
  timeout: "Sys1 request timed out",
  transport_error: "Sys1 transport failed",
  http_error: "Sys1 endpoint returned an HTTP error",
  response_too_large: "Sys1 response exceeded the byte limit",
  invalid_response: "Sys1 endpoint returned an invalid or mismatched response",
};

/** Never includes request bodies, credentials, URLs, or untrusted server errors. */
export class Sys1ClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number | undefined;

  constructor(code: ClientErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "Sys1ClientError";
    this.code = code;
    this.status = status;
  }
}

export interface ClientOptions {
  /** Use only for a direct Kev endpoint. Sys1 gateways declare their own adapter. */
  adapter?: "systemone" | "kev";
  /** An explicit HTTP(S) endpoint root; /v1/systemone is appended. */
  baseUrl?: string;
  /** Explicit headers, including Authorization if needed. Never read from env. */
  headers?: HeadersInit;
  /** Total HTTP request and response-body deadline, 1..300000 ms. Default 30000. */
  timeoutMs?: number;
  /** Optional transport injection. It must respect Fetch semantics. */
  fetch?: typeof globalThis.fetch;
}

export interface EvaluationOptions {
  signal?: AbortSignal;
}

export interface RouteMetadata {
  /** Native Kev probabilities retain their published two-decimal precision. */
  adapter?: "kev";
  probabilityDecimals?: 2;
  backend?: string;
  attempts?: number;
  local?: {
    /** Adapter identity, not a claim of calibrated probabilities. */
    adapter: string;
    minCoverage?: number;
    minConcentration?: number;
  };
}

export interface EvaluationResult {
  response: SystemOneResponse;
  /** Empty for direct endpoints that do not supply Sys1 routing headers. */
  metadata: RouteMetadata;
}

export interface Sys1Client {
  /** Makes exactly one HTTP attempt. Never retries, starts a daemon, or falls back. */
  evaluate(request: SystemOneRequest, options?: EvaluationOptions): Promise<EvaluationResult>;
}

function metadata(headers: Headers): RouteMetadata {
  const result: RouteMetadata = {};
  const adapter = headers.get("x-sys1-adapter");
  const decimals = headers.get("x-sys1-probability-decimals");
  if (adapter !== null || decimals !== null) {
    if (adapter !== "kev" || decimals !== "2") throw new Sys1ClientError("invalid_response");
    result.adapter = "kev";
    result.probabilityDecimals = 2;
  }
  const name = (key: string): string | undefined => {
    const value = headers.get(key);
    if (value === null) return undefined;
    if (!/^[a-zA-Z0-9_.:/-]{1,128}$/.test(value)) throw new Sys1ClientError("invalid_response");
    return value;
  };
  const backend = name("x-sys1-backend");
  if (backend !== undefined) result.backend = backend;
  const attempts = headers.get("x-sys1-attempts");
  if (attempts !== null) {
    if (!/^[1-9]\d{0,5}$/.test(attempts)) throw new Sys1ClientError("invalid_response");
    result.attempts = Number(attempts);
  }
  const localAdapter = name("x-sys1-local-adapter");
  if (localAdapter !== undefined) {
    result.local = { adapter: localAdapter };
    for (const [header, key] of [
      ["x-sys1-local-min-coverage", "minCoverage"],
      ["x-sys1-local-min-concentration", "minConcentration"],
    ] as const) {
      const value = headers.get(header);
      if (value === null) continue;
      if (!/^(0(?:\.\d{1,16})?|1(?:\.0{1,16})?)$/.test(value)) {
        throw new Sys1ClientError("invalid_response");
      }
      result.local[key] = Number(value);
    }
  }
  return result;
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** Bound even an injected transport that fails to observe AbortSignal. */
function fetchUntilAborted(
  fetchFn: typeof globalThis.fetch, url: string, init: RequestInit, signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Sys1ClientError("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
      return;
    }
    Promise.resolve().then(() => fetchFn(url, init)).then((response) => {
      if (signal.aborted) cancelBody(response);
      resolve(response);
    }, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A dependency-light client. No filesystem, environment, native runtime, or daemon access. */
export function createClient(options: ClientOptions = {}): Sys1Client {
  let endpoint: string;
  let headers: Headers;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const adapter = options.adapter ?? "systemone";
  try {
    if (adapter !== "systemone" && adapter !== "kev") throw new Error();
    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    if (base.length > 2_048) throw new Error();
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/systemone`;
    endpoint = url.href;
    headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    let headerBytes = 0;
    headers.forEach((value, key) => { headerBytes += new TextEncoder().encode(key + value).byteLength; });
    if (headerBytes > 16_384 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || typeof fetchFn !== "function") {
      throw new Error();
    }
  } catch {
    throw new Sys1ClientError("invalid_options");
  }

  return {
    async evaluate(input, evaluation = {}) {
      if (evaluation.signal?.aborted) throw new Sys1ClientError("aborted");
      let request: SystemOneRequest;
      let body: string;
      try {
        const serialized = JSON.stringify(input);
        if (new TextEncoder().encode(serialized).byteLength > PROTOCOL_LIMITS.maxBodyBytes) throw new Error();
        request = systemOneRequestSchema.parse(JSON.parse(serialized) as unknown);
        const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
        if (new TextEncoder().encode(state).byteLength > PROTOCOL_LIMITS.maxStateBytes) throw new Error();
        body = JSON.stringify(adapter === "kev" ? adaptKevRequest(request) : request);
        if (new TextEncoder().encode(body).byteLength > PROTOCOL_LIMITS.maxBodyBytes) throw new Error();
      } catch {
        throw new Sys1ClientError("invalid_request");
      }

      const controller = new AbortController();
      let timedOut = false;
      const onAbort = (): void => controller.abort();
      evaluation.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchUntilAborted(fetchFn, endpoint, {
          method: "POST", headers: new Headers(headers), body,
          signal: controller.signal, redirect: "error", credentials: "omit",
        }, controller.signal);
        if (!response.ok) {
          cancelBody(response);
          throw new Sys1ClientError("http_error", response.status);
        }
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES, controller.signal);
        let parsed: SystemOneResponse;
        let route: RouteMetadata;
        try {
          route = metadata(response.headers);
          const value: unknown = JSON.parse(text);
          if (adapter === "kev") {
            parsed = adaptKevResponse(request, value);
            route.adapter = "kev";
            route.probabilityDecimals = 2;
          } else {
            parsed = validateResponseForRequest(request, value, route.probabilityDecimals ?? 3);
          }
        } catch {
          throw new Sys1ClientError("invalid_response");
        }
        return { response: parsed, metadata: route };
      } catch (error) {
        if (controller.signal.aborted) throw new Sys1ClientError(timedOut ? "timeout" : "aborted");
        if (error instanceof Sys1ClientError) throw error;
        if (error instanceof HttpBodyLimitError) throw new Sys1ClientError("response_too_large");
        throw new Sys1ClientError("transport_error");
      } finally {
        clearTimeout(timer);
        evaluation.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export {
  PROTOCOL_LIMITS, answerSchema, questionSchema,
  noulQuestionSchema, choiceQuestionSchema, scoreQuestionSchema,
  noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema,
  systemOneRequestSchema, systemOneResponseSchema,
} from "./protocol.ts";

export { createProfile, Sys1ProfileError } from "./profile.ts";
export type {
  DecisionProfile, ProfileDefinition, ReadonlyProfileDefinition, ProfileErrorCode,
} from "./profile.ts";
