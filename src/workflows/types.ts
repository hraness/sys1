import type { DiffMode } from "../audit/diff.ts";
import type { RuleSet } from "../audit/pack.ts";
import type { Sys1Client } from "../client.ts";

export const WORKFLOW_LIMITS = Object.freeze({
  defaultTimeoutMs: 300_000, maxTimeoutMs: 900_000,
  defaultReviewTimeoutMs: 30_000, maxReviewTimeoutMs: 120_000,
  maxRequests: 200, maxCommandArgs: 128, maxCommandBytes: 65_536, maxPaths: 100,
  maxLogBytes: 4_194_304, logRetentionMs: 7 * 86_400_000,
  maxSourceFiles: 20_000, maxSourceBytes: 268_435_456,
  maxReuseAgeMs: 3_600_000,
});
export const WORKFLOW_ID = /^wf-[a-f0-9]{24}$/;

/** Public diagnostics are fixed descriptions, never subprocess/provider output. */
export class WorkflowError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 2) {
    super(message); this.name = "WorkflowError";
  }
}

export interface WorkflowReviewOptions {
  mode: DiffMode;
  since?: string;
  paths?: readonly string[];
  route: string;
  gateway?: boolean;
  decider?: Sys1Client;
  loadRules: (repoRoot: string) => Promise<RuleSet>;
  maxRequests: number;
  timeoutMs?: number;
}

export interface WorkflowOptions {
  home: string;
  cwd: string;
  command: readonly string[];
  configurationIdentity: string;
  review?: WorkflowReviewOptions;
  timeoutMs?: number;
  pauseAfterCheck?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface WorkflowReviewIntent {
  mode: DiffMode;
  since: string | null;
  paths: string[];
  route: string;
  gateway: boolean;
  maxRequests: number;
  timeoutMs: number;
  rulesDigest: string;
  snapshot: string;
}

/** All durable workflow inputs are references, identities, and bounds. */
export interface WorkflowIntent {
  version: 1;
  logId: string;
  createdAt: number;
  repo: string;
  cwd: string;
  head: string | null;
  sourceDigest: string;
  commandDigest: string;
  toolchainDigest: string;
  environmentDigest: string;
  configurationIdentity: string;
  timeoutMs: number;
  review: WorkflowReviewIntent | null;
}

export interface WorkflowLog {
  id: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  expiresAt: number;
}

export interface WorkflowCheckResult {
  status: "passed" | "failed" | "timed_out" | "cancelled" | "uncertain";
  exitCode: number | null;
  durationMs: number;
  outputBytes: number;
  checkedAt: number;
  bindingStatus: "unchanged" | "changed" | "unavailable";
  log: WorkflowLog;
}

export interface WorkflowFinding {
  id: string;
  unit_id: string;
  rule: string;
  revision: string;
  path: string;
  line: number;
  side: "before" | "after";
}

export interface WorkflowReviewResult {
  advisory: true;
  status: "complete" | "incomplete" | "unchanged" | "stale";
  complete: boolean;
  requests: number;
  usage: { input_tokens: number; output_tokens: number; known_requests: number; unknown_requests: number };
  coverage: { changedFiles: number; units: number; evaluatedUnits: number; plannedRequests: number; skipped: { reason: string; count: number }[] } | null;
  suppressedCount: number;
  findings: WorkflowFinding[];
  findingsOmitted: number;
  snapshot: string;
  checkedAt: number | null;
}

export interface WorkflowReport {
  version: 1;
  id: string;
  advisory: true;
  reused: boolean;
  status: "planned" | "ready" | "paused" | "complete" | "failed" | "uncertain" | "stale" | "incomplete";
  processDigest: string | null;
  exitCode: number;
  intent: WorkflowIntent;
  check: WorkflowCheckResult | null;
  review: WorkflowReviewResult | null;
}

export interface WorkflowLocation { home: string; cwd?: string; id: string }
export interface WorkflowVerification { version: 1; id: string; ok: true; processDigest: string; generations: number; receipts: number }
