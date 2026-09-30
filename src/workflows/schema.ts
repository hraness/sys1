import { z } from "zod";
import { storedFindingSchema } from "../review/state.ts";
import { WORKFLOW_LIMITS, WorkflowError, type WorkflowCheckResult, type WorkflowIntent, type WorkflowReviewResult } from "./types.ts";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const path = z.string().min(1).max(8192).regex(/^[^\x00-\x1f\x7f]+$/);
const reviewIntent = z.strictObject({
  mode: z.enum(["worktree", "staged", "since"]), since: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  paths: z.array(path).max(WORKFLOW_LIMITS.maxPaths), route: z.string().max(128).regex(/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/),
  gateway: z.boolean(), maxRequests: z.number().int().min(1).max(WORKFLOW_LIMITS.maxRequests),
  timeoutMs: z.number().int().min(1).max(WORKFLOW_LIMITS.maxReviewTimeoutMs), rulesDigest: hex, snapshot: hex,
});
export const intentSchema = z.strictObject({
  version: z.literal(1), logId: z.string().regex(/^[a-f0-9]{32}\.log$/), createdAt: count, repo: path, cwd: path,
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(), sourceDigest: hex,
  commandDigest: hex, toolchainDigest: hex, environmentDigest: hex, configurationIdentity: hex,
  timeoutMs: z.number().int().min(1).max(WORKFLOW_LIMITS.maxTimeoutMs), review: reviewIntent.nullable(),
});
const checkSchema = z.strictObject({
  status: z.enum(["passed", "failed", "timed_out", "cancelled", "uncertain"]),
  exitCode: z.number().int().min(0).max(255).nullable(), durationMs: count, outputBytes: count, checkedAt: count,
  bindingStatus: z.enum(["unchanged", "changed", "unavailable"]),
  log: z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}\.log$/), bytes: count.max(WORKFLOW_LIMITS.maxLogBytes), sha256: hex,
    truncated: z.boolean(), expiresAt: count }),
});
const reviewSchema = z.strictObject({
  advisory: z.literal(true), status: z.enum(["complete", "incomplete", "unchanged", "stale"]), complete: z.boolean(),
  requests: count.max(WORKFLOW_LIMITS.maxRequests),
  usage: z.strictObject({ input_tokens: count, output_tokens: count, known_requests: count, unknown_requests: count }),
  coverage: z.strictObject({ changedFiles: count, units: count, evaluatedUnits: count, plannedRequests: count,
    skipped: z.array(z.strictObject({ reason: z.string().regex(/^[a-z_]+$/).max(100), count })).max(100) }).nullable(),
  suppressedCount: count, findingsOmitted: count,
  findings: z.array(storedFindingSchema.pick({ id: true, unit_id: true, rule: true, revision: true, path: true, line: true, side: true })).max(200),
  snapshot: hex, checkedAt: count.nullable(),
});
export const stateSchema = z.strictObject({ intent: intentSchema, check: checkSchema.nullable(), review: reviewSchema.nullable() });
export interface WorkflowState { intent: WorkflowIntent; check: WorkflowCheckResult | null; review: WorkflowReviewResult | null }
export function parseState(value: unknown): WorkflowState {
  const result = stateSchema.safeParse(value);
  if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > 60_000
    || Buffer.byteLength(JSON.stringify(result.data.intent)) > 30_000) throw new WorkflowError("state_corrupt", "Saved workflow metadata is invalid or exceeds its bounds");
  return result.data;
}
