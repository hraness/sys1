import { createHash } from "node:crypto";
import { compileUnit, ruleApplies, QUESTION_FORMAT } from "./compile.ts";
import type { LoadedRule, RuleSet } from "./pack.ts";
import type { Rule } from "./schema.ts";
import type { DiffCollection, DiffUnit } from "./diff.ts";
import type { Sys1Client } from "../client.ts";
import type { Answer } from "../protocol.ts";
import { validateResponseForRequest } from "../response.ts";
import { runDetector } from "./detectors.ts";

export const AUDIT_LIMITS = { maxRequests: 200, defaultRequests: 20, maxTimeoutMs: 120_000, defaultTimeoutMs: 30_000 } as const;

/** An uncalibrated ranking score, never a probability that a defect exists. */
export function violationScore(rule: Rule, answer: Answer): number {
  if (rule.type !== answer.type) throw new Error("audit_answer_mismatch");
  let score: number;
  if (rule.type === "noul" && answer.type === "noul") score = 1 - answer.noul;
  else if (rule.type === "choice" && answer.type === "choice") {
    score = rule.violations.reduce((sum, option) => sum + (answer.probabilities[option] ?? 0), 0);
  } else if (rule.type === "score" && answer.type === "score") {
    score = Object.entries(answer.probabilities).reduce((sum, [level, mass]) => sum + (Number(level) >= rule.violation_at ? mass : 0), 0);
  } else throw new Error("audit_answer_mismatch");
  return Math.min(1, Math.max(0, score));
}

export interface AuditFinding {
  id: string;
  /** Exact before/after evidence digest, for advisory workflow identity. */
  unit_id: string;
  rule: string;
  revision: string;
  path: string;
  line: number;
  side: "before" | "after";
  model_score: number;
  tier: "high" | "medium";
  summary: string;
  qualification: "unqualified";
}

export interface AuditSkip { path: string; reason: string; rule?: string }
export interface AuditReport {
  version: 1;
  experimental: true;
  advisory: true;
  status: "planned" | "complete" | "incomplete";
  complete: boolean;
  qualification: "unqualified";
  mode: DiffCollection["mode"];
  base: string | null;
  head: string | null;
  route: string;
  question_format: number;
  changed_files: number;
  targets: { path: string; units: number }[];
  units: number;
  evaluated_units: number;
  planned_requests: number;
  requests: number;
  questions: number;
  usage: { input_tokens: number; output_tokens: number; known_requests: number; unknown_requests: number };
  elapsed_ms: number;
  rules: { id: string; revision: string; pack: string }[];
  findings: AuditFinding[];
  skipped: AuditSkip[];
}

export interface AuditOptions {
  diff: DiffCollection;
  rules: RuleSet;
  route: string;
  decider?: Sys1Client;
  dryRun?: boolean;
  maxRequests?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function boundedInteger(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

/** No cache or persistent content store: source evidence lives only for this call. */
export async function evaluateAudit(options: AuditOptions): Promise<AuditReport> {
  const maxRequests = options.maxRequests ?? AUDIT_LIMITS.defaultRequests;
  const timeoutMs = options.timeoutMs ?? AUDIT_LIMITS.defaultTimeoutMs;
  if (!/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/.test(options.route) || options.route.length > 128) {
    throw new Error("audit requires an explicit backend/model route");
  }
  if (!boundedInteger(maxRequests, AUDIT_LIMITS.maxRequests) || !boundedInteger(timeoutMs, AUDIT_LIMITS.maxTimeoutMs)) {
    throw new Error("audit request or time limit is invalid");
  }
  if (!options.dryRun && options.decider === undefined) throw new Error("audit requires a decider");
  const started = performance.now();
  const { diff } = options;
  const skipped: AuditSkip[] = diff.skipped.map(({ path, reason }) => ({ path, reason }));
  const work: { unit: DiffUnit; rules: LoadedRule[]; requests: ReturnType<typeof compileUnit> }[] = [];
  // Rules with a detector are decided locally and never reach the model.
  const local: { unit: DiffUnit; rules: LoadedRule[] }[] = [];
  const used = new Map<string, LoadedRule>();
  for (const unit of diff.units) {
    const selected = options.rules.rules.filter(({ rule }) => ruleApplies(rule, unit));
    const detected = selected.filter(({ rule }) => rule.detector !== undefined);
    const supported = selected.filter(({ rule }) => rule.detector === undefined && rule.unit === "hunk");
    for (const loaded of selected) {
      if (loaded.rule.detector === undefined && loaded.rule.unit !== "hunk") skipped.push({ path: unit.path, rule: loaded.id, reason: "file_unit_unsupported" });
    }
    if (selected.length === 0) {
      skipped.push({ path: unit.path, reason: "no_matching_rules" });
      continue;
    }
    if (detected.length > 0) {
      local.push({ unit, rules: detected });
      for (const loaded of detected) used.set(loaded.id, loaded);
    }
    if (supported.length === 0) continue;
    try {
      const requests = compileUnit(supported.map(({ rule }) => rule), unit.state, { model: options.route });
      work.push({ unit, rules: supported, requests });
      for (const loaded of supported) used.set(loaded.id, loaded);
    } catch {
      skipped.push({ path: unit.path, reason: "request_too_large" });
    }
  }
  const report: AuditReport = {
    version: 1, experimental: true, advisory: true,
    status: options.dryRun ? "planned" : "complete", complete: false, qualification: "unqualified",
    mode: diff.mode, base: diff.base, head: diff.head, route: options.route, question_format: QUESTION_FORMAT,
    changed_files: diff.changedFiles, units: diff.units.length, evaluated_units: 0,
    targets: [...new Set([...local, ...work].map(({ unit }) => unit.path))].map((path) => ({ path, units: new Set([...local, ...work].filter(({ unit }) => unit.path === path).map(({ unit }) => unit.id)).size })),
    planned_requests: work.reduce((sum, entry) => sum + entry.requests.length, 0),
    requests: 0, questions: 0, usage: { input_tokens: 0, output_tokens: 0, known_requests: 0, unknown_requests: 0 }, elapsed_ms: 0,
    rules: [...used.values()].map(({ id, revision, pack }) => ({ id, revision, pack: pack.name })),
    findings: [], skipped,
  };
  if (options.dryRun) {
    if (report.planned_requests > maxRequests) skipped.push({ path: ".", reason: "request_limit" });
    report.elapsed_ms = Math.round(performance.now() - started);
    return report;
  }
  const pushFinding = (loaded: LoadedRule, unit: DiffUnit, score: number, line: number, side: "before" | "after"): void => {
    report.findings.push({
      id: createHash("sha256").update(JSON.stringify([diff.repoRoot, loaded.id, loaded.revision, QUESTION_FORMAT, unit.id, options.route])).digest("hex").slice(0, 16),
      unit_id: unit.id,
      rule: loaded.id, revision: loaded.revision, path: unit.path,
      line, side,
      model_score: score, tier: score >= loaded.rule.tiers.high ? "high" : "medium",
      summary: "ensure" in loaded.rule ? loaded.rule.ensure : loaded.rule.ask,
      qualification: "unqualified",
    });
  };
  const askedUnits = new Set(work.map(({ unit }) => unit.id));
  for (const entry of local) {
    for (const loaded of entry.rules) {
      // One finding per rule and unit, at the first hit, to match model findings.
      const hit = runDetector(loaded.rule.detector!, entry.unit.patch)[0];
      if (hit !== undefined) pushFinding(loaded, entry.unit, 1, hit.line, hit.side);
    }
    if (!askedUnits.has(entry.unit.id)) report.evaluated_units++;
  }
  // Own the timer so a decider with no active I/O still has a live deadline
  // on every supported runtime, and successful calls release it immediately.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, options.signal]);
    const routeSlash = options.route.indexOf("/");
    const expectedBackend = options.route.slice(0, routeSlash);
    const expectedModel = options.route.slice(routeSlash + 1);
    let halted: string | undefined;
    for (const entry of work) {
      if (halted !== undefined || signal.aborted) {
        skipped.push({ path: entry.unit.path, reason: halted ?? "timeout_or_cancelled" });
        continue;
      }
      // Reserve the complete unit's budget before starting it. Never report a
      // partially evaluated unit as checked when its questions cross the cap.
      if (report.requests + entry.requests.length > maxRequests) {
        skipped.push({ path: entry.unit.path, reason: "request_limit" });
        halted = "request_limit";
        continue;
      }
      const scores = new Map<string, number>();
      try {
        for (const request of entry.requests) {
          if (signal.aborted) throw new Error("audit_cancelled");
          report.requests++;
          report.questions += Object.keys(request.questions).length;
          const result = await untilAborted(options.decider!.evaluate(request, { signal }), signal);
          const response = validateResponseForRequest(request, result.response, result.metadata.adapter === "kev" ? 2 : 3);
          if (result.response.model !== expectedModel || result.metadata.backend !== expectedBackend || (result.metadata.attempts ?? 1) !== 1) {
            throw new Error("audit_route_mismatch");
          }
          report.usage.input_tokens += response.usage.input_tokens;
          report.usage.output_tokens += response.usage.output_tokens;
          report.usage.known_requests++;
          for (const loaded of entry.rules) {
            const answer = response.answers[loaded.id];
            if (answer !== undefined) scores.set(loaded.id, violationScore(loaded.rule, answer));
          }
        }
        if (scores.size !== entry.rules.length) throw new Error("audit_incomplete_response");
        report.evaluated_units++;
        for (const loaded of entry.rules) {
          const score = scores.get(loaded.id)!;
          if (score < loaded.rule.tiers.medium) continue;
          const before = entry.unit.newRange.count === 0;
          pushFinding(loaded, entry.unit, score, Math.max(1, before ? entry.unit.oldRange.start : entry.unit.newRange.start), before ? "before" : "after");
        }
      } catch {
        // Never echo an untrusted provider exception (it may contain the source).
        halted = signal.aborted ? "timeout_or_cancelled" : "backend_error";
        skipped.push({ path: entry.unit.path, reason: halted });
      }
    }
    report.findings.sort((a, b) => b.model_score - a.model_score || a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
    report.usage.unknown_requests = report.requests - report.usage.known_requests;
    report.complete = diff.complete && skipped.length === 0;
    report.status = report.complete ? "complete" : "incomplete";
    report.elapsed_ms = Math.round(performance.now() - started);
    return report;
  } finally { clearTimeout(timer); }
}

/** Bound injected deciders too; cancel real transports through their signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error("audit_cancelled"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
