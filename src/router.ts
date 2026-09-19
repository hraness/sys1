import type { RoutingPolicy } from "./config.ts";
import type { SystemOneRequest } from "./protocol.ts";

export type BackendKind = "hosted" | "local";

/** Published per-backend request limits; absent fields mean unbounded. */
export interface BackendCapabilities {
  /** Largest criteria count a single choice/score question may carry. */
  maxOptions?: number;
  /** Largest question count a single request may carry. */
  maxQuestions?: number;
}

export interface BackendCandidate {
  /** Unique backend name. Hosted backend is always "typesafe". */
  name: string;
  kind: BackendKind;
  /** Whether the backend answered a bounded probe just now. */
  available: boolean;
  /** Model ids this backend reported or is configured to serve. */
  models: string[];
  /** Parameter count in billions; null when unknown (always null for hosted). */
  size_b: number | null;
  /** Operator-set cost ordering; lower is cheaper. */
  cost_rank: number;
  /**
   * Specialist backends only serve requests that explicitly name them —
   * they never receive unpinned policy-order fallback traffic.
   */
  specialist?: boolean;
  /** Probed or configured request limits. */
  capabilities?: BackendCapabilities;
}

/** What one request demands of a backend, computed from its questions. */
export interface RequestNeeds {
  /** Largest criteria count across choice/score questions (noul counts 2). */
  maxOptions: number;
  /** Question count in the request. */
  questions: number;
}

export function requestNeeds(request: SystemOneRequest): RequestNeeds {
  let maxOptions = 0;
  const questions = Object.values(request.questions);
  for (const question of questions) {
    switch (question.type) {
      case "choice":
        maxOptions = Math.max(maxOptions, Object.keys(question.criteria).length);
        break;
      case "score":
        maxOptions = Math.max(maxOptions, question.criteria.length);
        break;
      case "noul":
        maxOptions = Math.max(maxOptions, 2);
        break;
    }
  }
  return { maxOptions, questions: questions.length };
}

function compatible(candidate: BackendCandidate, needs: RequestNeeds): boolean {
  const caps = candidate.capabilities;
  if (caps === undefined) return true;
  if (caps.maxOptions !== undefined && needs.maxOptions > caps.maxOptions) return false;
  if (caps.maxQuestions !== undefined && needs.questions > caps.maxQuestions) return false;
  return true;
}

export type RouteChoice<T extends BackendCandidate = BackendCandidate> =
  | { ok: true; backend: T; reason: string }
  | {
      ok: false;
      reason:
        | "unknown_model"
        | "model_unavailable"
        | "request_unsupported"
        | "no_backend_available";
      detail: string;
    };

function byCheapest(a: BackendCandidate, b: BackendCandidate): number {
  const sizeA = a.size_b ?? Number.MAX_SAFE_INTEGER;
  const sizeB = b.size_b ?? Number.MAX_SAFE_INTEGER;
  if (sizeA !== sizeB) return sizeA - sizeB;
  if (a.cost_rank !== b.cost_rank) return a.cost_rank - b.cost_rank;
  return a.name.localeCompare(b.name);
}

function ordered<T extends BackendCandidate>(policy: RoutingPolicy, candidates: T[]): T[] {
  const hosted = candidates.filter((c) => c.kind === "hosted");
  const locals = candidates.filter((c) => c.kind === "local").sort(byCheapest);
  switch (policy) {
    case "prefer-local":
      return [...locals, ...hosted];
    case "local-only":
      return locals;
    case "hosted-only":
      return hosted;
    case "auto":
    case "prefer-hosted":
      return [...hosted, ...locals];
  }
}

/**
 * Pick a backend for one System One request.
 *
 * A request naming `backend/model` pins an exact backend. A bare model name
 * matches any backend listing it, in policy order. No model means policy
 * order among available backends: `auto` prefers hosted Jev and falls back to
 * the cheapest smallest local backend, `prefer-local` inverts that.
 *
 * `needs` makes selection capability-aware: a backend whose published limits
 * the request exceeds is never chosen, and specialists are skipped unless the
 * request explicitly names them.
 */
export function chooseBackend<T extends BackendCandidate>(
  policy: RoutingPolicy,
  requestedModel: string | undefined,
  candidates: T[],
  needs?: RequestNeeds,
): RouteChoice<T> {
  const fits = (candidate: T): boolean => needs === undefined || compatible(candidate, needs);
  if (requestedModel !== undefined && requestedModel !== "auto") {
    const slash = requestedModel.indexOf("/");
    if (slash > 0) {
      const backendName = requestedModel.slice(0, slash);
      const modelId = requestedModel.slice(slash + 1);
      const pinned = candidates.find((c) => c.name === backendName);
      if (pinned === undefined) {
        return { ok: false, reason: "unknown_model", detail: `no backend named ${backendName}` };
      }
      if (!pinned.models.includes(modelId) && pinned.models.length > 0) {
        return {
          ok: false,
          reason: "unknown_model",
          detail: `backend ${backendName} does not serve ${modelId}`,
        };
      }
      if (!pinned.available) {
        return {
          ok: false,
          reason: "model_unavailable",
          detail: `backend ${backendName} is not reachable`,
        };
      }
      if (!fits(pinned)) {
        return {
          ok: false,
          reason: "request_unsupported",
          detail: `request exceeds the published limits of backend ${backendName}`,
        };
      }
      return { ok: true, backend: pinned, reason: "pinned" };
    }
    const serving = ordered(
      policy,
      candidates.filter((c) => c.models.includes(requestedModel) && fits(c)),
    );
    const available = serving.find((c) => c.available);
    if (available !== undefined) {
      return { ok: true, backend: available, reason: "model" };
    }
    if (serving.length > 0) {
      return {
        ok: false,
        reason: "model_unavailable",
        detail: `no reachable backend serves ${requestedModel}`,
      };
    }
    if (candidates.some((c) => c.models.includes(requestedModel))) {
      return {
        ok: false,
        reason: "request_unsupported",
        detail: `request exceeds the published limits of every backend serving ${requestedModel}`,
      };
    }
    return {
      ok: false,
      reason: "unknown_model",
      detail: `no backend serves ${requestedModel}`,
    };
  }

  const viable = ordered(
    policy,
    candidates.filter((c) => c.specialist !== true),
  );
  const fallback = viable.find((c) => c.available && fits(c));
  if (fallback !== undefined) {
    return { ok: true, backend: fallback, reason: policy === "auto" ? "auto" : "policy" };
  }
  if (viable.length > 0 && viable.every((c) => !fits(c))) {
    return {
      ok: false,
      reason: "request_unsupported",
      detail: "request exceeds the published limits of every configured backend",
    };
  }
  return {
    ok: false,
    reason: "no_backend_available",
    detail: "no configured backend is reachable",
  };
}
