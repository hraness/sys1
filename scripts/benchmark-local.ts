/** Opt-in, synthetic-only adapter benchmark. Never downloads or reads config. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { systemOneRequestSchema, type SystemOneRequest, type SystemOneResponse } from "../src/protocol.ts";
import { validateResponseForRequest } from "../src/response.ts";
import { probeNativeRuntime, type NativeRuntimeProbe } from "../src/local/engine.ts";
import { LocalRunner, defaultEngineFactory, type LocalAdapter } from "../src/local/runner.ts";
import { MODEL_REGISTRY, findInstalled, modelFilePath, verifyModel, type InstalledModel } from "../src/local/store.ts";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE_PATH = join(ROOT, "benchmarks", "forms-v1.json");
const MODEL_IDS = MODEL_REGISTRY.map((entry) => entry.id);
const REQUEST_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const COLD_SAMPLES = 3;
const WARMUPS = 2;
const REPETITIONS = 5;
const keySchema = z.enum(["submit", "correct", "wait"]);
const fixtureSchema = z.object({
  version: z.literal(1),
  id: z.literal("forms-v1"),
  description: z.string().max(512),
  instructions: z.string().max(128),
  criteria: z.object({ submit: z.string(), correct: z.string(), wait: z.string() }).strict(),
  cases: z.array(z.object({
    id: z.string().regex(/^form-\d{2}$/),
    state: z.string().min(1).max(224),
    expected: keySchema,
    option_order: z.array(keySchema).length(3),
  }).strict()).length(20),
}).strict();
type Fixture = z.infer<typeof fixtureSchema>;
type Case = Fixture["cases"][number];
type Phase = "fresh_runner" | "warmup" | "repeated";

interface Sample {
  phase: Phase;
  repetition: number;
  case_id: string;
  expected: string;
  elapsed_ms: number;
  schema_valid: boolean;
  correct: boolean;
  error: string | null;
  response: SystemOneResponse | null;
  diagnostics: unknown;
}

interface ModelReport {
  id: string;
  kind: InstalledModel["kind"];
  adapter: LocalAdapter;
  weight_sha256: string;
  weight_bytes: number;
  engine_sha256: string | null;
  engine_bytes: number | null;
  usage_semantics: string;
  repeated_state: string;
  status: "running" | "complete" | "stopped_after_errors" | "interrupted";
  planned_calls: number;
  skipped_calls: number;
  samples: Sample[];
  summary: ReturnType<typeof summarize> | null;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function runtimeSourceDigest(): string {
  const hash = createHash("sha256");
  const visit = (relative: string): void => {
    const directory = join(ROOT, "src", relative);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = `${relative}${entry.name}`;
      if (entry.isDirectory()) visit(`${name}/`);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        hash.update(`${name}\0`).update(readFileSync(join(ROOT, "src", name))).update("\0");
      }
    }
  };
  visit("");
  return hash.digest("hex");
}

export function requestFor(fixture: Fixture, item: Case, model: string): SystemOneRequest {
  return systemOneRequestSchema.parse({
    model,
    state: item.state,
    questions: {
      action: {
        type: "choice",
        instructions: fixture.instructions,
        criteria: Object.fromEntries(item.option_order.map((key) => [key, fixture.criteria[key]])),
      },
    },
  });
}

export function loadFixture(): Fixture {
  if (lstatSync(FIXTURE_PATH).size > 32_768) throw new Error("fixture exceeds 32 KiB");
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown);
  const ids = new Set<string>();
  const answerCounts = [0, 0, 0];
  const positionCounts = [0, 0, 0];
  for (const item of fixture.cases) {
    if (ids.has(item.id) || new Set(item.option_order).size !== 3) throw new Error("fixture has duplicate ids or options");
    ids.add(item.id);
    requestFor(fixture, item, "fixture-validation");
    // The same byte limits apply to all cases, including multi-byte text.
    if (Buffer.byteLength(`${item.state}\n${fixture.instructions}`) > 224 || Object.entries(fixture.criteria).some(([key, value]) => Buffer.byteLength(`${key}: ${value}`) > 96)) throw new Error("historical fixture byte bounds exceeded");
    const answerIndex = keySchema.options.indexOf(item.expected);
    const positionIndex = item.option_order.indexOf(item.expected);
    answerCounts[answerIndex] = (answerCounts[answerIndex] ?? 0) + 1;
    positionCounts[positionIndex] = (positionCounts[positionIndex] ?? 0) + 1;
  }
  for (const counts of [answerCounts, positionCounts]) {
    if (Math.max(...counts) - Math.min(...counts) > 1) throw new Error("fixture answers and positions must be balanced");
  }
  return fixture;
}

function options(args: string[]): { home: string; models: string[]; output: string } | null {
  if (args.length === 1 && args[0] === "--validate-only") return null;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !["--home", "--models", "--output"].includes(flag) || value === undefined || value.startsWith("--") || values.has(flag)) {
      throw new Error("usage: bun scripts/benchmark-local.ts --home DIR --output FILE [--models qwen3-1.7b,qwen3-0.6b] | --validate-only");
    }
    values.set(flag, value);
  }
  const home = values.get("--home");
  const output = values.get("--output");
  const models = (values.get("--models") ?? "qwen3-1.7b").split(",");
  if (home === undefined || output === undefined) throw new Error("explicit --home and --output are required; no default user store is read");
  if (models.length < 1 || models.length > 2 || new Set(models).size !== models.length || models.some((model) => !MODEL_IDS.includes(model))) {
    throw new Error("--models must contain one or two unique curated model ids");
  }
  return { home: resolve(home), output: resolve(output), models };
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 5_000, maxBuffer: 65_536 });
  if (result.status !== 0) throw new Error("cannot record source Git provenance");
  return result.stdout.trim();
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(quantile * ordered.length) - 1] ?? null;
}

function summarize(samples: Sample[], repeatedElapsedMs: number) {
  const repeated = samples.filter((sample) => sample.phase === "repeated");
  const firstPass = repeated.filter((sample) => sample.repetition === 0);
  const successful = repeated.filter((sample) => sample.schema_valid);
  return {
    fresh_runner_ms: samples.filter((sample) => sample.phase === "fresh_runner").map((sample) => sample.elapsed_ms),
    repeated_attempts: repeated.length,
    repeated_valid: successful.length,
    repeated_failures: repeated.length - successful.length,
    repeated_correct: repeated.filter((sample) => sample.correct).length,
    unique_first_pass_cases: firstPass.length,
    unique_first_pass_correct: firstPass.filter((sample) => sample.correct).length,
    accuracy_denominator: "unique_first_pass_cases is the observed denominator; a complete pass contains 20 authored cases. Failures count as incorrect. Repeats are not independent examples.",
    p50_attempt_ms: percentile(repeated.map((sample) => sample.elapsed_ms), 0.5),
    p95_attempt_ms: percentile(repeated.map((sample) => sample.elapsed_ms), 0.95),
    p50_valid_ms: percentile(successful.map((sample) => sample.elapsed_ms), 0.5),
    p95_valid_ms: percentile(successful.map((sample) => sample.elapsed_ms), 0.95),
    repeated_total_elapsed_ms: repeatedElapsedMs,
    attempted_decisions_per_second: repeatedElapsedMs > 0 ? repeated.length * 1_000 / repeatedElapsedMs : null,
    valid_decisions_per_second: repeatedElapsedMs > 0 ? successful.length * 1_000 / repeatedElapsedMs : null,
    repeated_reported_input_tokens: successful.reduce((sum, sample) => sum + (sample.response?.usage.input_tokens ?? 0), 0),
    repeated_reported_output_tokens: successful.reduce((sum, sample) => sum + (sample.response?.usage.output_tokens ?? 0), 0),
  };
}

function modelReport(model: InstalledModel): ModelReport {
  return {
    id: model.id,
    kind: model.kind,
    adapter: "generic-gguf",
    weight_sha256: model.sha256,
    weight_bytes: model.bytes,
    engine_sha256: null,
    engine_bytes: null,
    usage_semantics: "Actual fully wrapped prompt tokens, separately evaluated per question; output_tokens=0 means no generated text returned, not no computation.",
    repeated_state: "Same runner and resident model after two warmups.",
    status: "running",
    planned_calls: COLD_SAMPLES + WARMUPS + 20 * REPETITIONS,
    skipped_calls: 0,
    samples: [],
    summary: null,
  };
}

async function admittedModel(home: string, id: string): Promise<InstalledModel> {
  const registry = MODEL_REGISTRY.find((entry) => entry.id === id)!;
  const installed = findInstalled(home, id);
  if (installed === undefined || installed.kind !== registry.kind || installed.sha256 !== registry.sha256 || installed.bytes !== registry.bytes) {
    throw new Error(`model ${id} is absent or does not match the curated pin; explicitly pull it before benchmarking`);
  }
  if (lstatSync(modelFilePath(home, installed)).size !== registry.bytes) throw new Error(`model ${id} has unexpected bytes`);
  const verification = await verifyModel(home, id);
  if (!verification.ok || verification.actual !== registry.sha256) throw new Error(`model ${id} failed digest or structure verification`);
  return installed;
}

async function sample(runner: LocalRunner, fixture: Fixture, item: Case, model: string, phase: Phase, repetition: number, signal: AbortSignal): Promise<Sample> {
  signal.throwIfAborted();
  const request = requestFor(fixture, item, model);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  let result: Awaited<ReturnType<LocalRunner["decide"]>>;
  try { result = await runner.decide(request, model, AbortSignal.any([signal, deadline.signal])); }
  finally { clearTimeout(timer); }
  const elapsed = performance.now() - started;
  let response: SystemOneResponse | null = null;
  let error: string | null = null;
  if (result.ok && result.response !== undefined) {
    try { response = validateResponseForRequest(request, result.response); }
    catch { error = "invalid_response"; }
  } else {
    const allowed = new Set(["unknown_model", "engine_unavailable", "local_question_unsupported", "inference_timeout", "inference_failed", "inference_unreadable"]);
    error = result.error !== undefined && allowed.has(result.error.type) ? result.error.type : "inference_failed";
  }
  const answer = response?.answers["action"];
  return {
    phase,
    repetition,
    case_id: item.id,
    expected: item.expected,
    elapsed_ms: elapsed,
    schema_valid: response !== null,
    correct: answer?.type === "choice" && answer.choice === item.expected,
    error,
    response,
    diagnostics: result.diagnostics ?? null,
  };
}

async function main(): Promise<void> {
  const fixture = loadFixture();
  const opts = options(process.argv.slice(2));
  if (opts === null) {
    console.log(JSON.stringify({ ok: true, fixture: fixture.id, cases: fixture.cases.length, max_context_bytes: Math.max(...fixture.cases.map((item) => Buffer.byteLength(`${item.state}\n${fixture.instructions}`))), fixture_sha256: sha256(readFileSync(FIXTURE_PATH)) }));
    return;
  }
  const models: InstalledModel[] = [];
  for (const id of opts.models) models.push(await admittedModel(opts.home, id));
  const native: NativeRuntimeProbe | null = models.some((model) => model.kind === "gguf") ? await probeNativeRuntime() : null;
  const cpu = cpus();
  const report = {
    version: 1,
    benchmark: "forms-v1-local-adapter",
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null as string | null,
    requested_model_ids: opts.models,
    source: {
      commit: git("rev-parse", "HEAD"),
      relevant_worktree_modified: git("status", "--porcelain", "--untracked-files=normal", "--", "src", "scripts/benchmark-local.ts", "benchmarks/forms-v1.json", "package.json", "bun.lock").length > 0,
      harness_sha256: sha256(readFileSync(import.meta.path)),
      fixture_sha256: sha256(readFileSync(FIXTURE_PATH)),
      registry_source_sha256: sha256(readFileSync(join(ROOT, "src/local/store.ts"))),
      runtime_source_sha256: runtimeSourceDigest(),
      lockfile_sha256: sha256(readFileSync(join(ROOT, "bun.lock"))),
    },
    environment: {
      platform: process.platform, arch: process.arch, os_release: release(), bun: Bun.version,
      cpu_model: cpu[0]?.model ?? "unknown", logical_cpus: cpu.length, system_memory_bytes: totalmem(),
      native_backend: native?.backend ?? null,
      gpu_offloading: native?.gpu_offloading ?? null,
      native_probe: native === null ? null : { ok: native.ok, elapsed_ms: native.elapsed_ms ?? null, failure_code: native.failure_code ?? null },
      native_backend_evidence: "Separate capability probe outside measured calls; the adapter does not expose a per-inference GPU measurement.",
      memory_measurement: "System capacity only; no peak process-group RAM or GPU-memory measurement.",
    },
    methodology: {
      fixture: fixture.id, unique_cases: 20, fresh_runner_samples: COLD_SAMPLES, warmups: WARMUPS,
      repetitions: REPETITIONS, repeated_calls_per_model: 100, concurrency: 1, context_tokens: 2_048,
      request_timeout_ms: REQUEST_TIMEOUT_MS, run_timeout_ms: RUN_TIMEOUT_MS,
      stop_rule: "Stop a model after three consecutive invalid/error responses; record actual and skipped calls. Incorrect but valid answers do not trigger this rule.",
      latency_boundary: "LocalRunner.decide wall time, including its manifest lookup, adaptation, model work and worker IPC; excludes response validation, HTTP, downloads and hash verification.",
      first_call_boundary: "Fresh LocalRunner, not a cold machine: verification has read weights into OS file caches; parent runtime/JIT and OS caches are not reset.",
      percentile_method: "nearest rank, ceil(p*n)-1 in sorted elapsed times",
      quality_scope: fixture.description,
      raw_answers: "Only the fixed public synthetic fixture is accepted. No private inputs, config, credentials or hosted calls are read.",
    },
    models: [] as ModelReport[],
  };
  mkdirSync(dirname(opts.output), { recursive: true });
  // Reserve a new result path; never silently replace an earlier experiment.
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
  const newRunner = (): LocalRunner => new LocalRunner({ home: opts.home, maxLoadedModels: 1, engineFactory: defaultEngineFactory(2_048, REQUEST_TIMEOUT_MS) });
  try {
    for (const model of models) {
      const entry = modelReport(model);
      report.models.push(entry);
      let consecutiveErrors = 0;
      class StopModel extends Error {}
      const record = (value: Sample): void => {
        entry.samples.push(value);
        consecutiveErrors = value.schema_valid ? 0 : consecutiveErrors + 1;
        if (consecutiveErrors >= 3) throw new StopModel();
      };
      console.error(`benchmark ${model.id}: three fresh runners, two warmups, 100 repeated calls`);
      try {
        // Same first case on all fresh runners makes startup samples comparable.
        for (let i = 0; i < COLD_SAMPLES; i += 1) {
          const runner = newRunner();
          try { record(await sample(runner, fixture, fixture.cases[0]!, model.id, "fresh_runner", i, cancellation.signal)); }
          finally { await runner.dispose(); save(); }
        }
        const runner = newRunner();
        let started: number | null = null;
        try {
          for (let i = 0; i < WARMUPS; i += 1) record(await sample(runner, fixture, fixture.cases[i]!, model.id, "warmup", i, cancellation.signal));
          started = performance.now();
          for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
            for (const item of fixture.cases) record(await sample(runner, fixture, item, model.id, "repeated", repetition, cancellation.signal));
          }
        } finally {
          entry.summary = summarize(entry.samples, started === null ? 0 : performance.now() - started);
          await runner.dispose();
        }
        entry.status = "complete";
      } catch (error) {
        if (!(error instanceof StopModel)) {
          entry.status = "interrupted";
          entry.skipped_calls = entry.planned_calls - entry.samples.length;
          throw error;
        }
        entry.status = "stopped_after_errors";
        entry.skipped_calls = entry.planned_calls - entry.samples.length;
        entry.summary ??= summarize(entry.samples, 0);
      } finally {
        save();
      }
    }
    report.status = report.models.every((entry) => entry.status === "complete") ? "complete" : "complete_with_model_failures";
    if (report.status !== "complete") process.exitCode = 1;
  } catch {
    report.status = cancellation.signal.aborted ? "interrupted" : "failed";
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    report.finished_at = new Date().toISOString();
    save();
  }
  console.log(JSON.stringify({ status: report.status, models: report.models.map((entry) => ({ id: entry.id, status: entry.status, skipped_calls: entry.skipped_calls, summary: entry.summary })) }));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    // All input is the fixed public fixture. Never print a native/provider error.
    console.error(error instanceof Error && !error.message.includes("\n") ? error.message : "benchmark setup failed");
    process.exitCode = 1;
  }
}
