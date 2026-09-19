import type { RoutingPolicy } from "./config.ts";

export type BackendKind = "hosted" | "local";

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
}

export type RouteChoice<T extends BackendCandidate = BackendCandidate> =
  | { ok: true; backend: T; reason: string }
  | {
      ok: false;
      reason: "unknown_model" | "model_unavailable" | "no_backend_available";
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
 */
export function chooseBackend<T extends BackendCandidate>(
  policy: RoutingPolicy,
  requestedModel: string | undefined,
  candidates: T[],
): RouteChoice<T> {
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
      return { ok: true, backend: pinned, reason: "pinned" };
    }
    const serving = ordered(
      policy,
      candidates.filter((c) => c.models.includes(requestedModel)),
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
    return {
      ok: false,
      reason: "unknown_model",
      detail: `no backend serves ${requestedModel}`,
    };
  }

  const fallback = ordered(policy, candidates).find((c) => c.available);
  if (fallback !== undefined) {
    return { ok: true, backend: fallback, reason: policy === "auto" ? "auto" : "policy" };
  }
  return {
    ok: false,
    reason: "no_backend_available",
    detail: "no configured backend is reachable",
  };
}
