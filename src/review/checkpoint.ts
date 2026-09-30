import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { collectDiff, type DiffCollection, type DiffMode } from "../audit/diff.ts";
import { evaluateAudit, type AuditFinding, type AuditReport } from "../audit/evaluate.ts";
import { QUESTION_FORMAT } from "../audit/compile.ts";
import { canonicalJson } from "../audit/schema.ts";
import type { RuleSet } from "../audit/pack.ts";
import type { Sys1Client } from "../client.ts";
import {
  mutateReviewState, readReviewState, resolveReviewRoot, REVIEW_STATE_LIMITS, ReviewError,
  reviewFeedbackSchema, reviewSelectionSchema, type ReviewFeedback, type ReviewSelection, type StoredFinding,
} from "./state.ts";

export { ReviewError, resolveReviewRoot } from "./state.ts";
export const REVIEW_RECEIPT_TTL_MS = 86_400_000;

export interface ReviewRuntimeOptions {
  home: string;
  cwd: string;
  route: string;
  decider?: Sys1Client;
  dryRun?: boolean;
  maxRequests?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  loadRules: (repoRoot: string) => Promise<RuleSet>;
}
export interface ReviewCheckpointOptions extends ReviewRuntimeOptions {
  mode: DiffMode;
  since?: string;
  paths?: readonly string[];
  /** Refuse changed prepared inputs before any model call or saved-state access. */
  expectedSnapshot?: string;
}
export interface ReviewCheckpointReport {
  version: 1;
  advisory: true;
  status: "planned" | "complete" | "incomplete" | "unchanged" | "stale";
  complete: boolean;
  snapshot: string;
  checked_at: number | null;
  age_ms: number | null;
  receipt_ttl_ms: number;
  requests: number;
  suppressed_count: number;
  findings: AuditFinding[];
  /** Transient report. Its findings are the same new candidates as above. */
  audit: AuditReport | null;
}

async function selectionFor(diff: DiffCollection, paths: readonly string[] | undefined): Promise<ReviewSelection> {
  const normalized = await Promise.all((paths ?? []).map(async value => {
    let absolute = resolve(diff.repoRoot, value);
    if (isAbsolute(value)) {
      // Match collectDiff's absolute-path handling, including an OS temporary
      // alias and selected files that have since been deleted.
      let parent = absolute;
      const missing: string[] = [];
      for (;;) {
        try { absolute = resolve(await realpath(parent), ...missing); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent) throw error;
          missing.unshift(basename(parent)); parent = dirname(parent);
        }
      }
    }
    const name = relative(diff.repoRoot, absolute);
    if (name === "" || name === ".") return ".";
    if (isAbsolute(name) || name === ".." || name.startsWith(`..${sep}`)) throw new ReviewError("invalid_selection", "Review paths must stay in the worktree", 2);
    return name.split(sep).join("/");
  }));
  return reviewSelectionSchema.parse({ mode: diff.mode, since: diff.mode === "since" ? diff.base : null, paths: [...new Set(normalized)].sort() });
}

export function reviewSnapshot(diff: DiffCollection, rules: RuleSet, route: string, selection: ReviewSelection): string {
  return createHash("sha256").update(canonicalJson({
    repo: diff.repoRoot, selection, mode: diff.mode, base: diff.base, head: diff.head,
    units: diff.units.map(unit => unit.id), skipped: diff.skipped, complete: diff.complete,
    rules: rules.rules.map(rule => [rule.id, rule.revision]), route, question_format: QUESTION_FORMAT,
  })).digest("hex");
}

const report = (snapshot: string): ReviewCheckpointReport => ({
  version: 1, advisory: true, status: "planned", complete: false, snapshot,
  checked_at: null, age_ms: null, receipt_ttl_ms: REVIEW_RECEIPT_TTL_MS,
  requests: 0, suppressed_count: 0, findings: [], audit: null,
});

function metadata(finding: AuditFinding, snapshot: string, selection: ReviewSelection, route: string, now: number): StoredFinding {
  return {
    id: finding.id, unit_id: finding.unit_id, snapshot, rule: finding.rule, revision: finding.revision,
    route, question_format: QUESTION_FORMAT, selection, path: finding.path, line: finding.line,
    side: finding.side, first_seen: now, last_seen: now, feedback: null,
  };
}

async function collect(options: ReviewCheckpointOptions): Promise<DiffCollection> {
  return collectDiff({ cwd: options.cwd, mode: options.mode,
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  });
}

function auditOptions(options: ReviewRuntimeOptions) {
  return {
    route: options.route,
    ...(options.decider === undefined ? {} : { decider: options.decider }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function snapshotStillCurrent(options: ReviewCheckpointOptions, snapshot: string): Promise<boolean> {
  try {
    const after = await collect(options);
    const rules = await options.loadRules(after.repoRoot);
    return reviewSnapshot(after, rules, options.route, await selectionFor(after, options.paths)) === snapshot;
  } catch { return false; }
}

export async function checkpointReview(options: ReviewCheckpointOptions): Promise<ReviewCheckpointReport> {
  if (options.expectedSnapshot !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedSnapshot)) {
    throw new ReviewError("invalid_snapshot", "Expected review snapshot must be a SHA-256 identity", 2);
  }
  const diff = await collect(options);
  const rules = await options.loadRules(diff.repoRoot);
  const selection = await selectionFor(diff, options.paths);
  const snapshot = reviewSnapshot(diff, rules, options.route, selection);
  const result = report(snapshot);
  if (options.expectedSnapshot !== undefined && snapshot !== options.expectedSnapshot) {
    result.status = "stale";
    return result;
  }
  // Compile/validate even when reusing a receipt. Preview must neither read nor create state.
  const preview = await evaluateAudit({ ...auditOptions(options), diff, rules, dryRun: true });
  if (options.dryRun) { result.audit = preview; return result; }
  const previous = await readReviewState(options.home, diff.repoRoot);
  const now = Date.now();
  const receipt = previous.receipts.find(item => item.snapshot === snapshot && item.created_at <= now && now - item.created_at < REVIEW_RECEIPT_TTL_MS);
  if (receipt !== undefined) {
    if (!await snapshotStillCurrent(options, snapshot)) { result.status = "stale"; return result; }
    result.status = "unchanged"; result.complete = true;
    result.checked_at = receipt.created_at; result.age_ms = now - receipt.created_at;
    result.suppressed_count = receipt.finding_ids.length;
    return result;
  }
  const audit = await evaluateAudit({ ...auditOptions(options), diff, rules });
  result.requests = audit.requests;
  result.audit = audit;
  if (!await snapshotStillCurrent(options, snapshot)) { result.status = "stale"; result.audit = { ...audit, findings: [] }; return result; }
  const checked = Date.now();
  const findings = await mutateReviewState(options.home, diff.repoRoot, state => {
    const seen = new Map(state.findings.map(item => [item.id, item]));
    const newlySeen = audit.findings.filter(item => !seen.has(item.id));
    if (state.findings.length + newlySeen.length > REVIEW_STATE_LIMITS.findings) {
      throw new ReviewError("state_limit", "Review finding metadata is full");
    }
    for (const item of audit.findings) {
      const existing = seen.get(item.id);
      if (existing !== undefined) {
        if (existing.unit_id !== item.unit_id || existing.rule !== item.rule || existing.revision !== item.revision
          || existing.route !== options.route || existing.question_format !== QUESTION_FORMAT) {
          throw new ReviewError("state_corrupt", "A review identifier refers to different evidence");
        }
        existing.last_seen = checked; existing.snapshot = snapshot;
      }
      else state.findings.push(metadata(item, snapshot, selection, options.route, checked));
    }
    if (audit.complete) {
      state.receipts = state.receipts.filter(item => item.snapshot !== snapshot && checked - item.created_at < REVIEW_RECEIPT_TTL_MS);
      state.receipts.push({ snapshot, created_at: checked, finding_ids: audit.findings.map(item => item.id) });
      state.receipts = state.receipts.slice(-REVIEW_STATE_LIMITS.receipts);
    }
    return newlySeen;
  });
  result.status = audit.complete ? "complete" : "incomplete";
  result.complete = audit.complete;
  result.checked_at = checked; result.age_ms = 0;
  result.suppressed_count = audit.findings.length - findings.length;
  result.findings = findings;
  result.audit = { ...audit, findings };
  return result;
}

export async function listReviewIssues(options: { home: string; cwd: string }): Promise<{ version: 1; advisory: true; issues: StoredFinding[] }> {
  const root = await resolveReviewRoot(options.cwd);
  return { version: 1, advisory: true, issues: (await readReviewState(options.home, root)).findings };
}

export async function feedbackReview(options: { home: string; cwd: string; id: string; feedback: ReviewFeedback }): Promise<{ version: 1; advisory: true; issue: StoredFinding }> {
  const feedback = reviewFeedbackSchema.safeParse(options.feedback);
  if (!feedback.success || !/^[a-f0-9]{16}$/.test(options.id)) throw new ReviewError("invalid_feedback", "Choose a finding ID and useful, incorrect, or unverifiable", 2);
  const root = await resolveReviewRoot(options.cwd);
  // Unknown identifiers must not create a state store.
  if (!(await readReviewState(options.home, root)).findings.some(item => item.id === options.id)) throw new ReviewError("unknown_finding", "The finding is not recorded in this worktree", 2);
  const issue = await mutateReviewState(options.home, root, state => {
    const item = state.findings.find(value => value.id === options.id);
    if (item === undefined) throw new ReviewError("unknown_finding", "The finding is not recorded in this worktree", 2);
    item.feedback = feedback.data;
    return { ...item };
  });
  return { version: 1, advisory: true, issue };
}

export interface ReviewRecheckReport {
  version: 1;
  advisory: true;
  id: string;
  status: "planned" | "reported" | "not_reported" | "superseded" | "unavailable" | "incomplete" | "stale";
  reason: string | null;
  audit: AuditReport | null;
}

export async function recheckReview(options: ReviewRuntimeOptions & { id: string }): Promise<ReviewRecheckReport> {
  const result: ReviewRecheckReport = { version: 1, advisory: true, id: options.id, status: "unavailable", reason: null, audit: null };
  if (!/^[a-f0-9]{16}$/.test(options.id)) throw new ReviewError("invalid_finding", "A finding ID is required", 2);
  const root = await resolveReviewRoot(options.cwd);
  const stored = (await readReviewState(options.home, root)).findings.find(item => item.id === options.id);
  if (stored === undefined) { result.reason = "unknown_finding"; return result; }
  if (stored.route !== options.route) { result.reason = "route_changed"; return result; }
  const rules = await options.loadRules(root);
  const rule = rules.get(stored.rule);
  if (rule === undefined || rule.revision !== stored.revision || QUESTION_FORMAT !== stored.question_format) {
    result.status = "superseded"; result.reason = "rule_changed"; return result;
  }
  const checkpointOptions: ReviewCheckpointOptions = {
    ...options, mode: stored.selection.mode, paths: stored.selection.paths,
    ...(stored.selection.since === null ? {} : { since: stored.selection.since }),
  };
  let diff: DiffCollection;
  try { diff = await collect(checkpointOptions); }
  catch { result.reason = "evidence_unavailable"; return result; }
  const unit = diff.units.find(item => item.id === stored.unit_id);
  if (unit === undefined) {
    result.status = diff.complete ? "superseded" : "unavailable";
    result.reason = diff.complete ? "evidence_changed" : "evidence_unavailable";
    return result;
  }
  const selectedRules: RuleSet = { ...rules, rules: [rule] };
  const selectedDiff: DiffCollection = { ...diff, units: [unit], skipped: [], changedFiles: 1, complete: true };
  const originalSnapshot = reviewSnapshot(diff, rules, options.route, await selectionFor(diff, stored.selection.paths));
  result.audit = await evaluateAudit({ ...auditOptions(options), diff: selectedDiff, rules: selectedRules });
  if (options.dryRun) { result.status = "planned"; return result; }
  if (!await snapshotStillCurrent(checkpointOptions, originalSnapshot)) {
    result.status = "stale"; result.audit = { ...result.audit, findings: [] }; return result;
  }
  result.status = !result.audit.complete ? "incomplete" : result.audit.findings.length > 0 ? "reported" : "not_reported";
  // Rechecks bypass receipts and never overwrite a person's explicit judgment.
  return result;
}
