import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Sys1Client } from "../client.ts";
import { PROTOCOL_LIMITS, type SystemOneRequest } from "../protocol.ts";
import { validateResponseForRequest } from "../response.ts";
import { compileUnit, QUESTION_FORMAT, ruleApplies } from "./compile.ts";
import { violationScore } from "./evaluate.ts";
import type { LoadedPack } from "./pack.ts";
import { canonicalJson, ruleIdSchema, ruleRevision } from "./schema.ts";

export const BENCHMARK_LIMITS = {
  maxFileBytes: 4_194_304, maxFixtures: 2_000, maxRequests: 3_000,
  maxTimeoutMs: 1_800_000, supportWarningMinimum: 8,
} as const;
export type BenchmarkSplit = "calibration" | "heldout";
export type FixtureLabel = "clean" | "violation";
export const benchmarkFixtureSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  rule: ruleIdSchema,
  label: z.enum(["clean", "violation"]),
  path: z.string().min(1).max(1_024).refine(value => !value.startsWith("/") &&
    !value.includes("\\") && !value.includes(":") && !/[\x00-\x1f]/.test(value) && !value.split("/").includes("..")),
  language: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9+#._-]*$/).optional(),
  state: z.string().min(1).refine(value => Buffer.byteLength(value) <= PROTOCOL_LIMITS.maxStateBytes),
});
export type BenchmarkFixture = z.infer<typeof benchmarkFixtureSchema>;

/** Safe messages contain neither foreign input nor provider exceptions. */
export class AuditBenchmarkError extends Error {
  constructor(message: string) { super(message); this.name = "AuditBenchmarkError"; }
}
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fixtureDigest = (fixture: BenchmarkFixture): string => digest(canonicalJson(fixture));

export interface BenchmarkFixtures {
  split: BenchmarkSplit;
  file_sha256: { calibration: string; heldout: string };
  content_sha256: string;
  fixtures: readonly BenchmarkFixture[];
}

async function readFixtureFile(file: string): Promise<Uint8Array> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > BENCHMARK_LIMITS.maxFileBytes) throw new Error();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > BENCHMARK_LIMITS.maxFileBytes) throw new Error();
    const buffer = Buffer.alloc(BENCHMARK_LIMITS.maxFileBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > BENCHMARK_LIMITS.maxFileBytes) throw new Error();
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

/** Both files are checked for exact overlap; only the selected split is evaluated. */
export async function loadBenchmarkFixtures(packDir: string, split: BenchmarkSplit): Promise<BenchmarkFixtures> {
  if (split !== "calibration" && split !== "heldout") throw new AuditBenchmarkError("invalid benchmark split");
  try {
    const files = await Promise.all((["calibration", "heldout"] as const).map(async name => {
      const bytes = await readFixtureFile(join(packDir, "fixtures", `${name}.jsonl`));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
      if (lines.length === 0 || lines.length > BENCHMARK_LIMITS.maxFixtures) throw new Error();
      return { name, sha256: digest(bytes), fixtures: lines.map(line => benchmarkFixtureSchema.parse(JSON.parse(line) as unknown)) };
    }));
    const ids = new Set<string>();
    const states = new Map<string, BenchmarkSplit>();
    for (const file of files) {
      const pairs = new Set<string>();
      for (const fixture of file.fixtures) {
        if (ids.has(fixture.id)) throw new Error();
        ids.add(fixture.id);
        const state = digest(fixture.state.replace(/\r\n/g, "\n").trim());
        if (states.has(state) && states.get(state) !== file.name) throw new Error();
        states.set(state, file.name);
        const pair = `${fixture.rule}:${state}`;
        if (pairs.has(pair)) throw new Error();
        pairs.add(pair);
      }
    }
    const selected = files.find(file => file.name === split)!;
    return {
      split, file_sha256: { calibration: files[0]!.sha256, heldout: files[1]!.sha256 },
      content_sha256: digest(canonicalJson(selected.fixtures)), fixtures: selected.fixtures,
    };
  } catch { throw new AuditBenchmarkError("benchmark fixtures must be bounded valid JSONL with unique IDs and no cross-split state overlap"); }
}

export interface BinomialMetric {
  numerator: number;
  denominator: number;
  value: number | null;
  wilson95: [number, number] | null;
}
/** Wilson score interval; a zero denominator is unknown, never perfect accuracy. */
export function binomialMetric(numerator: number, denominator: number): BinomialMetric {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator < numerator) {
    throw new AuditBenchmarkError("invalid metric counts");
  }
  if (denominator === 0) return { numerator, denominator, value: null, wilson95: null };
  const p = numerator / denominator, z = 1.959963984540054, z2 = z * z;
  const divisor = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / divisor;
  const radius = z * Math.sqrt(p * (1 - p) / denominator + z2 / (4 * denominator ** 2)) / divisor;
  return { numerator, denominator, value: p, wilson95: [Math.max(0, center - radius), Math.min(1, center + radius)] };
}

export interface ClassifiedScore { label: FixtureLabel; score: number }
export function summarizeThreshold(samples: readonly ClassifiedScore[], threshold: number) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new AuditBenchmarkError("invalid threshold");
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { label, score } of samples) {
    if (!Number.isFinite(score) || score < 0 || score > 1 || (label !== "clean" && label !== "violation")) {
      throw new AuditBenchmarkError("invalid classification sample");
    }
    if (score >= threshold) { if (label === "violation") tp++; else fp++; }
    else { if (label === "violation") fn++; else tn++; }
  }
  return {
    threshold, tp, fp, tn, fn,
    precision: binomialMetric(tp, tp + fp), recall: binomialMetric(tp, tp + fn),
    false_positive_rate: binomialMetric(fp, fp + tn),
  };
}

type CaseStatus = "planned" | "evaluated" | "request_limit" | "deadline" | "cancelled" | "backend_error";
export interface BenchmarkCase {
  id: string;
  rule: string;
  label: FixtureLabel;
  fixture_sha256: string;
  request_sha256: string[];
  status: CaseStatus;
  tier: "high" | "medium" | "low" | null;
}
export interface AuditBenchmarkOptions {
  pack: LoadedPack;
  fixtures: BenchmarkFixtures;
  route: string;
  decider?: Sys1Client;
  maxRequests: number;
  timeoutMs: number;
  validateOnly?: boolean;
  signal?: AbortSignal;
}

export function validateBenchmarkLimits(route: string, maxRequests: number, timeoutMs: number): void {
  if (!/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/.test(route) || route.length > 128) {
    throw new AuditBenchmarkError("benchmark requires an explicit backend/model route");
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > BENCHMARK_LIMITS.maxRequests ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BENCHMARK_LIMITS.maxTimeoutMs) {
    throw new AuditBenchmarkError("invalid benchmark request limit or deadline");
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error("benchmark_aborted"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
const percentile = (values: readonly number[], fraction: number): number | null => values.length === 0 ? null :
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;

/** Explicit opt-in, no retries or writes. Numeric answers are retained only in memory. */
export async function benchmarkPack(options: AuditBenchmarkOptions) {
  const started = performance.now();
  validateBenchmarkLimits(options.route, options.maxRequests, options.timeoutMs);
  if (!options.validateOnly && options.decider === undefined) throw new AuditBenchmarkError("benchmark requires a decider");
  const { pack, fixtures } = options;
  if ((fixtures.split !== "calibration" && fixtures.split !== "heldout") || fixtures.fixtures.length === 0 ||
      fixtures.fixtures.length > BENCHMARK_LIMITS.maxFixtures ||
      ![fixtures.file_sha256.calibration, fixtures.file_sha256.heldout].every(value => /^[0-9a-f]{64}$/.test(value)) ||
      digest(canonicalJson(fixtures.fixtures)) !== fixtures.content_sha256) {
    throw new AuditBenchmarkError("invalid or changed benchmark fixture set");
  }
  const ids = new Set<string>();
  const work = fixtures.fixtures.map(value => {
    const parsed = benchmarkFixtureSchema.safeParse(value);
    if (!parsed.success || ids.has(parsed.data.id)) throw new AuditBenchmarkError("invalid or duplicate benchmark fixture");
    const fixture = parsed.data;
    ids.add(fixture.id);
    const rule = pack.rules.find(candidate => candidate.id === fixture.rule);
    const applicable = pack.rules.filter(candidate => candidate.unit === "hunk" && ruleApplies(candidate, fixture));
    if (rule === undefined || !applicable.includes(rule)) throw new AuditBenchmarkError("fixture target rule does not apply to its path and language");
    let requests: SystemOneRequest[];
    try { requests = compileUnit(applicable, fixture.state, { model: options.route }); }
    catch { throw new AuditBenchmarkError("fixture does not compile within request bounds"); }
    return { fixture, rule, requests, hashes: requests.map(request => digest(canonicalJson(request))) };
  });
  const samples = new Map<string, ClassifiedScore[]>();
  const cases: BenchmarkCase[] = [];
  const latencies: number[] = [];
  const validLatencies: number[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, known_requests: 0, unknown_requests: 0 };
  let requests = 0, questions = 0;
  const slash = options.route.indexOf("/");
  const expectedBackend = options.route.slice(0, slash), expectedModel = options.route.slice(slash + 1);
  const deadline = new AbortController();
  const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, options.signal]);
  const timer = setTimeout(() => deadline.abort(), Math.max(1, options.timeoutMs - (performance.now() - started)));
  let halted: Exclude<CaseStatus, "evaluated" | "planned"> | undefined;
  const interruption = (): "deadline" | "cancelled" | undefined =>
    deadline.signal.aborted || performance.now() - started >= options.timeoutMs ? "deadline" : options.signal?.aborted ? "cancelled" : undefined;
  try {
    for (const entry of work) {
      const record: BenchmarkCase = {
        id: entry.fixture.id, rule: entry.fixture.rule, label: entry.fixture.label,
        fixture_sha256: fixtureDigest(entry.fixture), request_sha256: entry.hashes,
        status: options.validateOnly ? "planned" : "evaluated", tier: null,
      };
      cases.push(record);
      if (options.validateOnly) continue;
      halted ??= interruption();
      if (halted !== undefined) { record.status = halted; continue; }
      // Reserve complete fixture evidence; independently check the hard cap before every attempt.
      if (requests + entry.requests.length > options.maxRequests) {
        halted = "request_limit"; record.status = halted; continue;
      }
      let targetScore: number | undefined;
      try {
        for (const request of entry.requests) {
          halted ??= interruption();
          if (halted !== undefined || requests >= options.maxRequests) throw new Error("benchmark_stopped");
          requests++;
          questions += Object.keys(request.questions).length;
          const requestStarted = performance.now();
          let valid = false;
          try {
            const result = await untilAborted(options.decider!.evaluate(request, { signal }), signal);
            const response = validateResponseForRequest(request, result.response, result.metadata.adapter === "kev" ? 2 : 3);
            if (response.model !== expectedModel || result.metadata.backend !== expectedBackend || (result.metadata.attempts ?? 1) !== 1) {
              throw new Error("benchmark_route_mismatch");
            }
            usage.input_tokens += response.usage.input_tokens;
            usage.output_tokens += response.usage.output_tokens;
            usage.known_requests++;
            valid = true;
            const answer = response.answers[entry.rule.id];
            if (answer !== undefined) targetScore = violationScore(entry.rule, answer);
          } finally {
            const elapsed = performance.now() - requestStarted;
            latencies.push(elapsed);
            if (valid) validLatencies.push(elapsed);
          }
        }
        if (targetScore === undefined) throw new Error("benchmark_missing_answer");
        record.tier = targetScore >= entry.rule.tiers.high ? "high" : targetScore >= entry.rule.tiers.medium ? "medium" : "low";
        const observed = samples.get(entry.rule.id) ?? [];
        observed.push({ label: entry.fixture.label, score: targetScore });
        samples.set(entry.rule.id, observed);
      } catch {
        // Never propagate provider text: it may echo source, questions, or credentials.
        halted = interruption() ?? halted ?? "backend_error";
        record.status = halted;
      }
    }
  } finally { clearTimeout(timer); }
  usage.unknown_requests = requests - usage.known_requests;
  const rules = pack.rules.map(rule => {
    const planned = work.filter(entry => entry.rule.id === rule.id);
    const observed = samples.get(rule.id) ?? [];
    const clean = observed.filter(sample => sample.label === "clean").length;
    const violations = observed.length - clean;
    const high = summarizeThreshold(observed, rule.tiers.high);
    const medium = summarizeThreshold(observed, rule.tiers.medium);
    const min = BENCHMARK_LIMITS.supportWarningMinimum;
    return {
      id: rule.id, revision: ruleRevision(rule),
      support: {
        planned: planned.length, evaluated: observed.length, clean, violations,
        minimum_for_warning: min, below_minimum: clean < min || violations < min,
        high_predictions_below_minimum: high.precision.denominator < min,
        medium_predictions_below_minimum: medium.precision.denominator < min,
      },
      high, at_least_medium: medium,
      ...(fixtures.split === "calibration" ? { calibration_thresholds: [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99].map(threshold => summarizeThreshold(observed, threshold)) } : {}),
    };
  });
  const complete = !options.validateOnly && cases.every(item => item.status === "evaluated");
  return {
    version: 1 as const, experimental: true as const, qualification: "unqualified" as const,
    score_interpretation: "uncalibrated_model_score" as const,
    status: options.validateOnly ? "planned" as const : complete ? "complete" as const : "incomplete" as const,
    complete, split: fixtures.split, route: options.route, question_format: QUESTION_FORMAT,
    pack: { name: pack.name, revision: pack.revision },
    fixture_sha256: fixtures.file_sha256, fixture_content_sha256: fixtures.content_sha256,
    limits: { max_requests: options.maxRequests, timeout_ms: options.timeoutMs, retries: 0 },
    planned_fixtures: work.length, evaluated_fixtures: cases.filter(item => item.status === "evaluated").length,
    planned_requests: work.reduce((sum, entry) => sum + entry.requests.length, 0), requests, questions,
    usage, elapsed_ms: Math.round(performance.now() - started),
    latency_ms: { attempts: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95),
      valid_attempts: validLatencies.length, valid_p50: percentile(validLatencies, 0.5), valid_p95: percentile(validLatencies, 0.95) },
    rules, cases,
    warnings: ["Model scores are not calibrated defect probabilities.", "Synthetic fixture precision does not establish precision on real changes.",
      "Wilson intervals assume independent cases; related templates can make them optimistic.",
      "Minimum support flags are warnings, not a quality approval."],
  };
}
