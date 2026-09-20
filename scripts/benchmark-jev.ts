/** Explicitly opt-in hosted benchmark of the fixed public synthetic fixture. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { forwardToBackend, type RuntimeBackend } from "../src/backends.ts";
import type { SystemOneResponse } from "../src/protocol.ts";
import { validateResponseForRequest } from "../src/response.ts";
import { loadFixture, requestFor, runtimeSourceDigest, sha256 } from "./benchmark-local.ts";

const ROOT = resolve(import.meta.dir, "..");
export const JEV_MODEL = "jev-1.13.0";
export const JEV_ORIGIN = "https://api.typesafe.ai";
const REQUEST_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const INITIAL_CALLS = 3;
const WARMUPS = 2;
const REPETITIONS = 5;
const PLANNED_CALLS = INITIAL_CALLS + WARMUPS + 20 * REPETITIONS;
const INPUT_USD_PER_MILLION = 0.042;
type Phase = "initial_client" | "warmup" | "repeated";
type Fixture = ReturnType<typeof loadFixture>;
export interface JevSample {
  phase: Phase;
  repetition: number;
  case_id: string;
  expected: string;
  elapsed_ms: number;
  http_status: number | null;
  schema_valid: boolean;
  correct: boolean;
  error: "http_error" | "transport_error" | "timeout" | "cancelled" | "invalid_response" | null;
  returned_model: string | null;
  response: SystemOneResponse | null;
}

export function parseBenchmarkOptions(args: string[]): { output: string; region: string } | null {
  if (args.length === 1 && args[0] === "--validate-only") return null;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !["--output", "--region"].includes(flag) || value === undefined || value.startsWith("--") || values.has(flag)) {
      throw new Error("usage: bun scripts/benchmark-jev.ts --output FILE --region LABEL | --validate-only");
    }
    values.set(flag, value);
  }
  const output = values.get("--output");
  const region = values.get("--region");
  if (!output || !region || !/^[a-zA-Z0-9][a-zA-Z0-9 .,_/-]{0,79}$/.test(region)) {
    throw new Error("explicit --output and a public --region label (1–80 characters) are required");
  }
  return { output: resolve(output), region };
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 5_000, maxBuffer: 65_536 });
  if (result.status !== 0) throw new Error("cannot record source Git provenance");
  return result.stdout.trim();
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(quantile * values.length) - 1] ?? null;
}

function usageTotals(samples: JevSample[]) {
  const known = samples.filter((sample) => sample.response !== null);
  return {
    calls_with_validated_usage: known.length,
    calls_without_validated_usage: samples.length - known.length,
    reported_input_tokens: known.length ? known.reduce((sum, sample) => sum + sample.response!.usage.input_tokens, 0) : null,
    reported_output_tokens: known.length ? known.reduce((sum, sample) => sum + sample.response!.usage.output_tokens, 0) : null,
  };
}

export function summarizeJev(samples: JevSample[], repeatedElapsedMs: number) {
  const repeated = samples.filter((sample) => sample.phase === "repeated");
  const valid = repeated.filter((sample) => sample.schema_valid);
  const first = repeated.filter((sample) => sample.repetition === 0);
  const allUsage = usageTotals(samples);
  const repeatedUsage = usageTotals(repeated);
  return {
    initial_client_ms: samples.filter((sample) => sample.phase === "initial_client").map((sample) => sample.elapsed_ms),
    attempted_calls: samples.length,
    skipped_calls: PLANNED_CALLS - samples.length,
    repeated_attempts: repeated.length,
    repeated_valid: valid.length,
    repeated_failures: repeated.length - valid.length,
    repeated_correct: repeated.filter((sample) => sample.correct).length,
    unique_first_pass_cases: first.length,
    unique_first_pass_correct: first.filter((sample) => sample.correct).length,
    accuracy_denominator: "Observed first-pass cases; failures count as incorrect. A complete pass has 20 cases; repeated calls are not independent quality examples.",
    p50_attempt_ms: percentile(repeated.map((sample) => sample.elapsed_ms), 0.5),
    p95_attempt_ms: percentile(repeated.map((sample) => sample.elapsed_ms), 0.95),
    p50_valid_ms: percentile(valid.map((sample) => sample.elapsed_ms), 0.5),
    p95_valid_ms: percentile(valid.map((sample) => sample.elapsed_ms), 0.95),
    repeated_total_elapsed_ms: repeatedElapsedMs,
    attempted_decisions_per_second: repeatedElapsedMs > 0 ? repeated.length * 1_000 / repeatedElapsedMs : null,
    valid_decisions_per_second: repeatedElapsedMs > 0 ? valid.length * 1_000 / repeatedElapsedMs : null,
    repeated_reported_input_tokens: repeatedUsage.reported_input_tokens,
    repeated_reported_output_tokens: repeatedUsage.reported_output_tokens,
    all_calls_usage: allUsage,
    repeated_usage: repeatedUsage,
    estimated_repeated_known_input_cost_usd: repeatedUsage.reported_input_tokens === null ? null : repeatedUsage.reported_input_tokens * INPUT_USD_PER_MILLION / 1_000_000,
    estimated_known_input_cost_usd: allUsage.reported_input_tokens === null ? null : allUsage.reported_input_tokens * INPUT_USD_PER_MILLION / 1_000_000,
    unknown_billing_calls: allUsage.calls_without_validated_usage,
    cost_scope: "Estimate for validated reported input tokens across all attempted phases, including initial calls and warmups. Not an invoice; billing for calls without validated usage is unknown. Published output-token price is zero; output counts are still reported separately.",
  };
}

async function sample(backend: RuntimeBackend, fixture: Fixture, item: Fixture["cases"][number], phase: Phase, repetition: number, fetchFn: typeof fetch, signal: AbortSignal): Promise<JevSample> {
  const request = requestFor(fixture, item, JEV_MODEL);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  let result: Awaited<ReturnType<typeof forwardToBackend>>;
  try {
    result = await forwardToBackend(backend, JSON.stringify(request), undefined, REQUEST_TIMEOUT_MS, fetchFn, AbortSignal.any([signal, deadline.signal]));
  } finally { clearTimeout(timer); }
  // forwardToBackend consumes the bounded complete body. Parsing and protocol validation are outside this boundary.
  const elapsed = performance.now() - started;
  let response: SystemOneResponse | null = null;
  let returnedModel: string | null = null;
  let error: JevSample["error"] = null;
  if (signal.aborted) error = "cancelled";
  else if (deadline.signal.aborted || (result.kind === "transport" && result.detail === "backend timeout")) error = "timeout";
  else if (result.kind === "transport") error = "transport_error";
  else if (result.status < 200 || result.status >= 300) error = "http_error";
  else {
    try {
      const validated = validateResponseForRequest(request, JSON.parse(result.body) as unknown);
      // Keep a recognizable provider model identity, never arbitrary text from a rejected response.
      returnedModel = /^jev-(?:latest|\d+\.\d+\.\d+)$/.test(validated.model) ? validated.model : null;
      if (validated.model !== JEV_MODEL) throw new Error("model mismatch");
      response = validated;
    } catch { error = "invalid_response"; }
  }
  const answer = response?.answers["action"];
  return {
    phase, repetition, case_id: item.id, expected: item.expected, elapsed_ms: elapsed,
    http_status: result.kind === "response" ? result.status : null,
    schema_valid: response !== null,
    correct: answer?.type === "choice" && answer.choice === item.expected,
    error, returned_model: returnedModel, response,
  };
}

/** Tests inject only an offline fetch and fake environment; the target and model cannot be overridden. */
export async function runJevBenchmark(opts: { output: string; region: string }, dependencies: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  const fixture = loadFixture();
  const env = dependencies.env ?? process.env;
  const key = env["TYPESAFE_API_KEY"];
  if (key === undefined || key.trim().length === 0 || /[\r\n]/.test(key)) throw new Error("TYPESAFE_API_KEY must be present in the environment");
  const backend: RuntimeBackend = {
    name: "typesafe", kind: "hosted", available: true, models: [JEV_MODEL], size_b: null, cost_rank: 0,
    base_url: JEV_ORIGIN, default_model: JEV_MODEL, headers: { authorization: `Bearer ${key}` },
  };
  const cpu = cpus();
  const report = {
    version: 1, benchmark: "forms-v1-hosted-jev", status: "running", started_at: new Date().toISOString(), finished_at: null as string | null,
    requested_model_id: JEV_MODEL, endpoint: `${JEV_ORIGIN}/v1/systemone`, client_region: opts.region,
    source: {
      commit: git("rev-parse", "HEAD"),
      relevant_worktree_modified: git("status", "--porcelain", "--untracked-files=normal", "--", "src", "scripts/benchmark-jev.ts", "scripts/benchmark-local.ts", "benchmarks/forms-v1.json", "package.json", "bun.lock").length > 0,
      harness_sha256: sha256(readFileSync(import.meta.path)),
      shared_harness_sha256: sha256(readFileSync(join(ROOT, "scripts/benchmark-local.ts"))),
      fixture_sha256: sha256(readFileSync(join(ROOT, "benchmarks/forms-v1.json"))),
      runtime_source_sha256: runtimeSourceDigest(),
      lockfile_sha256: sha256(readFileSync(join(ROOT, "bun.lock"))),
      package_sha256: sha256(readFileSync(join(ROOT, "package.json"))),
    },
    environment: {
      platform: process.platform, arch: process.arch, os_release: release(), bun: Bun.version,
      cpu_model: cpu[0]?.model ?? "unknown", logical_cpus: cpu.length, system_memory_bytes: totalmem(),
      region_evidence: "Operator-supplied client-region label, not provider region or verified geolocation.",
      server_environment: "Hosted server hardware, load, cache state and inference-only time are not exposed. The model version is provider-asserted, not an independently verified weight hash.",
    },
    methodology: {
      fixture: fixture.id, unique_cases: 20, initial_client_calls: INITIAL_CALLS, warmups: WARMUPS,
      repetitions: REPETITIONS, repeated_calls: 100, concurrency: 1, planned_calls: PLANNED_CALLS,
      request_timeout_ms: REQUEST_TIMEOUT_MS, run_timeout_ms: RUN_TIMEOUT_MS, retries: 0,
      stop_rule: "Stop after three consecutive invalid/error responses; valid incorrect answers reset this error counter.",
      latency_boundary: "Client wall time through the existing forwardToBackend transport, including DNS/TLS/HTTP, provider processing and complete bounded response body; excludes JSON/protocol validation and result persistence. Not directly equivalent to local inference or provider throughput.",
      throughput_boundary: "Serial repeated-phase wall time including validation and loop overhead; result-file persistence occurs outside this phase. Server-side caching is unknown and is not disabled or controlled.",
      initial_client_boundary: "First three sequential requests from this process, not independent cold connections or cold server starts. The same Bun fetch pool may reuse connections throughout.",
      percentile_method: "nearest rank, ceil(p*n)-1 in sorted elapsed times",
      quality_scope: fixture.description,
      raw_answers: "Only the fixed public synthetic fixture is sent. Stored answers passed protocol/request validation and the exact model pin. No credentials, headers, raw error bodies or transport exception text are stored.",
      usage_semantics: "Provider-reported input/output counters from valid responses; missing or invalid usage fails validation and remains unknown, never zero-filled.",
      input_usd_per_million: INPUT_USD_PER_MILLION,
      output_usd_per_million: 0,
      price_source: "https://docs.typesafe.ai/models",
      price_verified_date: "2026-09-19",
      price_scope: "Published Jev input-token price; verify current price before using the estimate for spending decisions.",
    },
    samples: [] as JevSample[], summary: null as ReturnType<typeof summarizeJev> | null,
  };
  mkdirSync(dirname(opts.output), { recursive: true });
  writeFileSync(opts.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const save = (): void => {
    const temporary = `${opts.output}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, opts.output);
    } finally { rmSync(temporary, { force: true }); }
  };
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), RUN_TIMEOUT_MS);
  const interrupt = (): void => cancellation.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const signal = dependencies.signal === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, dependencies.signal]);
  let consecutiveErrors = 0;
  let repeatedStarted: number | null = null;
  let repeatedFinished: number | null = null;
  try {
    const schedule = [
      ...Array.from({ length: INITIAL_CALLS }, (_, repetition) => ({ phase: "initial_client" as const, repetition, item: fixture.cases[0]! })),
      ...Array.from({ length: WARMUPS }, (_, repetition) => ({ phase: "warmup" as const, repetition, item: fixture.cases[repetition]! })),
      ...Array.from({ length: REPETITIONS }, (_, repetition) => fixture.cases.map((item) => ({ phase: "repeated" as const, repetition, item }))).flat(),
    ];
    for (const entry of schedule) {
      signal.throwIfAborted();
      if (entry.phase === "repeated") repeatedStarted ??= performance.now();
      const value = await sample(backend, fixture, entry.item, entry.phase, entry.repetition, dependencies.fetchFn ?? fetch, signal);
      if (entry.phase === "repeated") repeatedFinished = performance.now();
      report.samples.push(value);
      consecutiveErrors = value.schema_valid ? 0 : consecutiveErrors + 1;
      // Keep filesystem work outside the repeated-phase throughput boundary. The finalizer
      // persists all settled repeated attempts on normal completion and handled interruption.
      if (entry.phase !== "repeated") save();
      signal.throwIfAborted();
      if (consecutiveErrors >= 3) { report.status = "stopped_after_errors"; break; }
    }
    if (report.status === "running") report.status = "complete";
  } catch {
    report.status = signal.aborted ? "interrupted" : "failed";
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    report.finished_at = new Date().toISOString();
    report.summary = summarizeJev(report.samples, repeatedStarted === null || repeatedFinished === null ? 0 : repeatedFinished - repeatedStarted);
    save();
  }
  return report;
}

async function main(): Promise<void> {
  const opts = parseBenchmarkOptions(process.argv.slice(2));
  if (opts === null) {
    const fixture = loadFixture();
    console.log(JSON.stringify({ ok: true, fixture: fixture.id, cases: fixture.cases.length, model: JEV_MODEL, endpoint: `${JEV_ORIGIN}/v1/systemone`, planned_calls: PLANNED_CALLS, fixture_sha256: sha256(readFileSync(join(ROOT, "benchmarks/forms-v1.json"))) }));
    return;
  }
  const report = await runJevBenchmark(opts);
  console.log(JSON.stringify({ status: report.status, model: report.requested_model_id, summary: report.summary }));
  if (report.status !== "complete") process.exitCode = 1;
}

if (import.meta.main) {
  try { await main(); }
  catch {
    // Never print arbitrary filesystem, transport or provider exceptions: they may contain secret data.
    console.error("Jev benchmark setup/persistence failed; check --output, --region and environment-only TYPESAFE_API_KEY. Existing output files are never overwritten.");
    process.exitCode = 1;
  }
}
