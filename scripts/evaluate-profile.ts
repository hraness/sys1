/** Experimental source-checkout evaluator. No model call without --run. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { createClient, DEFAULT_BASE_URL, Sys1ClientError, type RouteMetadata } from "../src/client.ts";
import { createProfile } from "../src/profile.ts";
import { entrySchema, PROTOCOL_LIMITS, type Answer, type Question } from "../src/protocol.ts";

export const EVALUATION_LIMITS = {
  profileBytes: PROTOCOL_LIMITS.maxBodyBytes,
  fixtureBytes: 16_777_216,
  cases: 1_000,
  maxRequests: 1_000,
  timeoutMs: 300_000,
  deadlineMs: 3_600_000,
} as const;

export const PROFILE_EVALUATION_HELP = `Usage: bun scripts/evaluate-profile.ts --profile FILE --fixtures FILE [options]

Experimental evaluator for a Sys1 source checkout. Validates the complete profile
and fixture dataset without inference by default; --run enables model requests.
Fixtures are a JSON array of {id, state, expected}, where expected maps every
question ID to its string, boolean, or integer label.

Options:
  --profile FILE       Required versioned decision profile JSON
  --fixtures FILE      Required labeled fixture JSON
  --run                Send serialized requests with no retries
  --url URL            Endpoint root (default: ${DEFAULT_BASE_URL})
  --max-requests N      Request cap (default: 100; range: 1..1000)
  --timeout-ms N        Per-request timeout (default: 30000; range: 1..300000)
  --deadline-ms N       Whole-run deadline (default: 300000; range: 1..3600000)
  --help               Show this help without reading files or sending requests

Reports are JSON on stdout; errors are sanitized JSON on stderr.
Exit codes: 0 = validated or completed (any accuracy); 1 = invalid input/options;
            2 = --run incomplete because a request failed or a case was skipped.`;

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const fixturesSchema = z.array(z.object({
  id: identifier,
  state: entrySchema,
  expected: z.record(z.string(), z.union([z.string(), z.boolean(), z.number().int()])),
  split: identifier.optional(),
  family: identifier.optional(),
}).strict()).min(1).max(EVALUATION_LIMITS.cases);

type Expected = string | boolean | number;
type Outcome = "correct" | "incorrect" | "unresolved";
type SkipReason = "validate_only" | "max_requests" | "deadline" | "aborted";

/** Error text deliberately excludes input paths, source content, and server bodies. */
export class ProfileEvaluationError extends Error {
  constructor(readonly code: "invalid_input" | "invalid_options" | "input_file_error") {
    super(`Profile evaluation ${code}`);
    this.name = "ProfileEvaluationError";
  }
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Hashes use JSON serialization of the validated values, with their input key order. */
export function prepareEvaluation(profileInput: unknown, fixtureInput: unknown) {
  try {
    const profile = createProfile(profileInput);
    const fixtures = fixturesSchema.parse(fixtureInput);
    if (Buffer.byteLength(JSON.stringify(fixtures)) > EVALUATION_LIMITS.fixtureBytes) throw new Error();
    if (new Set(fixtures.map(item => item.id)).size !== fixtures.length) throw new Error();
    const cases = fixtures.map(fixture => {
      const request = profile.request(fixture.state);
      const names = Object.keys(request.questions);
      if (Object.keys(fixture.expected).length !== names.length) throw new Error();
      for (const name of names) {
        if (!Object.hasOwn(fixture.expected, name)) throw new Error();
        const expected = fixture.expected[name]!;
        const question = request.questions[name]!;
        if (question.type === "noul" && typeof expected !== "boolean") throw new Error();
        if (question.type === "choice" && (typeof expected !== "string" || !Object.hasOwn(question.criteria, expected))) throw new Error();
        if (question.type === "score" && (typeof expected !== "number" || expected < 0 || expected >= question.criteria.length)) throw new Error();
      }
      return { fixture, request, request_sha256: sha256(request) };
    });
    return {
      profile: { id: profile.definition.id, revision: profile.definition.revision, model: profile.definition.model, sha256: sha256(profile.definition) },
      fixtures_sha256: sha256(fixtures),
      cases,
    };
  } catch {
    throw new ProfileEvaluationError("invalid_input");
  }
}

export interface QuestionGrade {
  outcome: Outcome;
  /** Choice: profile criterion order; Noul: [false, true]; Score: ascending level. */
  probabilities: number[];
  /** Provider field, not measured accuracy or a calibration claim. */
  confidence: number | null;
  score_absolute_error: number | null;
}

/** Grade only an answer already checked against its request by the Sys1 client. */
export function gradeAnswer(question: Question, expected: Expected, answer: Answer): QuestionGrade {
  if (question.type !== answer.type) throw new ProfileEvaluationError("invalid_input");
  if (answer.type === "noul") {
    const predicted = answer.noul === 0.5 ? null : answer.noul > 0.5;
    return {
      outcome: predicted === null ? "unresolved" : predicted === expected ? "correct" : "incorrect",
      probabilities: [1 - answer.noul, answer.noul], confidence: null, score_absolute_error: null,
    };
  }
  const keys = question.type === "choice" ? Object.keys(question.criteria) : Object.keys(answer.probabilities);
  const probabilities = keys.map(key => answer.probabilities[key]!);
  const maximum = Math.max(...probabilities);
  const winners = keys.filter(key => answer.probabilities[key] === maximum);
  const predicted = winners.length === 1 ? (answer.type === "score" ? Number(winners[0]) : winners[0]) : null;
  return {
    outcome: predicted === null ? "unresolved" : predicted === expected ? "correct" : "incorrect",
    probabilities,
    confidence: answer.confidence,
    score_absolute_error: answer.type === "score" ? Math.abs(answer.score - Number(expected)) : null,
  };
}

export interface ProfileEvaluationOptions {
  run?: boolean;
  url?: string;
  maxRequests?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

interface CaseResult {
  id: string;
  split: string | null;
  family: string | null;
  request_sha256: string;
  status: "completed" | "error" | "skipped";
  skip_reason: SkipReason | null;
  elapsed_ms: number | null;
  error: string | null;
  http_status: number | null;
  route: (RouteMetadata & { model: string }) | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  questions: Record<string, QuestionGrade> | null;
}

function boundedInteger(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new ProfileEvaluationError("invalid_options");
  return value;
}

function normalizeOptions(options: ProfileEvaluationOptions) {
  if (options.run !== undefined && typeof options.run !== "boolean") throw new ProfileEvaluationError("invalid_options");
  return {
    run: options.run ?? false,
    maxRequests: boundedInteger(options.maxRequests ?? 100, EVALUATION_LIMITS.maxRequests),
    timeoutMs: boundedInteger(options.timeoutMs ?? 30_000, EVALUATION_LIMITS.timeoutMs),
    deadlineMs: boundedInteger(options.deadlineMs ?? 300_000, EVALUATION_LIMITS.deadlineMs),
  };
}

/** Serialized, single-attempt requests. Injection uses the same validating client as the CLI. */
export async function runEvaluation(
  profileInput: unknown,
  fixtureInput: unknown,
  options: ProfileEvaluationOptions = {},
  transport?: typeof globalThis.fetch,
) {
  // Validate the complete dataset before creating or sending any request.
  const prepared = prepareEvaluation(profileInput, fixtureInput);
  const settings = normalizeOptions(options);
  const client = createClient({
    baseUrl: options.url ?? DEFAULT_BASE_URL,
    timeoutMs: settings.timeoutMs,
    ...(transport === undefined ? {} : { fetch: transport }),
  });
  const started = performance.now();
  const controller = new AbortController();
  let deadlineReached = false;
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = settings.run ? setTimeout(() => { deadlineReached = true; controller.abort(); }, settings.deadlineMs) : null;
  const cases: CaseResult[] = [];
  let attempted = 0;
  try {
    for (const { fixture, request, request_sha256 } of prepared.cases) {
      const row: CaseResult = {
        id: fixture.id, split: fixture.split ?? null, family: fixture.family ?? null, request_sha256,
        status: "skipped", skip_reason: null, elapsed_ms: null, error: null,
        http_status: null, route: null, usage: null, questions: null,
      };
      cases.push(row);
      if (!settings.run) row.skip_reason = "validate_only";
      else if (deadlineReached || performance.now() - started >= settings.deadlineMs) row.skip_reason = "deadline";
      else if (controller.signal.aborted) row.skip_reason = "aborted";
      else if (attempted >= settings.maxRequests) row.skip_reason = "max_requests";
      if (row.skip_reason !== null) continue;
      attempted++;
      const requestStarted = performance.now();
      try {
        const { response, metadata } = await client.evaluate(request, { signal: controller.signal });
        row.status = "completed";
        row.route = { ...metadata, model: response.model };
        row.usage = response.usage;
        row.questions = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [
          name, gradeAnswer(question, fixture.expected[name]!, response.answers[name]!),
        ]));
      } catch (error) {
        row.status = "error";
        row.error = deadlineReached ? "deadline" : error instanceof Sys1ClientError ? error.code : "evaluation_error";
        row.http_status = error instanceof Sys1ClientError ? error.status ?? null : null;
      } finally {
        row.elapsed_ms = performance.now() - requestStarted;
      }
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  const questionCounts = { correct: 0, incorrect: 0, unresolved: 0 };
  const usage = { known_calls: 0, unknown_calls: 0, input_tokens: 0, output_tokens: 0 };
  for (const row of cases) {
    for (const grade of Object.values(row.questions ?? {})) questionCounts[grade.outcome]++;
    if (row.usage !== null) {
      usage.known_calls++;
      usage.input_tokens += row.usage.input_tokens;
      usage.output_tokens += row.usage.output_tokens;
    } else if (row.status === "error") usage.unknown_calls++;
  }
  return {
    schema_version: 1,
    mode: settings.run ? "run" : "validate_only",
    profile: prepared.profile,
    fixtures_sha256: prepared.fixtures_sha256,
    limits: { max_requests: settings.maxRequests, timeout_ms: settings.timeoutMs, deadline_ms: settings.deadlineMs },
    summary: {
      planned: cases.length, attempted,
      completed: cases.filter(row => row.status === "completed").length,
      errors: cases.filter(row => row.status === "error").length,
      skipped: cases.filter(row => row.status === "skipped").length,
      questions: questionCounts, usage, elapsed_ms: performance.now() - started,
    },
    cases,
  };
}

/** Check the path and opened identity; read at most the byte budget plus one. */
export function readEvaluationJson(path: string, maximumBytes: number): unknown {
  let fd: number | undefined;
  try {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > EVALUATION_LIMITS.fixtureBytes) throw new Error();
    // O_NOFOLLOW is unavailable on some platforms, so inspect the path as well.
    // Identity comparison detects a different file opened after that inspection;
    // it is not a full hostile-filesystem race guarantee on Windows.
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > maximumBytes) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== existing.dev || stat.ino !== existing.ino || stat.size > maximumBytes) throw new Error();
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maximumBytes) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } catch {
    throw new ProfileEvaluationError("input_file_error");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseEvaluationOptions(args: string[]): ProfileEvaluationOptions & { profile: string; fixtures: string } {
  const values = new Map<string, string>();
  const allowed = new Set(["--profile", "--fixtures", "--url", "--max-requests", "--timeout-ms", "--deadline-ms", "--run"]);
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!allowed.has(key) || values.has(key)) throw new ProfileEvaluationError("invalid_options");
    const value = key === "--run" ? "true" : args[++index];
    if (!value || value.startsWith("--")) throw new ProfileEvaluationError("invalid_options");
    values.set(key, value);
  }
  const profile = values.get("--profile");
  const fixtures = values.get("--fixtures");
  if (!profile || !fixtures) throw new ProfileEvaluationError("invalid_options");
  const number = (key: string, fallback: number): number => {
    const value = values.get(key);
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value)) throw new ProfileEvaluationError("invalid_options");
    return Number(value);
  };
  const result = {
    profile, fixtures, run: values.has("--run"), url: values.get("--url") ?? DEFAULT_BASE_URL,
    maxRequests: number("--max-requests", 100), timeoutMs: number("--timeout-ms", 30_000), deadlineMs: number("--deadline-ms", 300_000),
  };
  normalizeOptions(result);
  return result;
}

if (import.meta.main && process.argv.length === 3 && process.argv[2] === "--help") {
  console.log(PROFILE_EVALUATION_HELP);
} else if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const options = parseEvaluationOptions(process.argv.slice(2));
    const report = await runEvaluation(
      readEvaluationJson(options.profile, EVALUATION_LIMITS.profileBytes),
      readEvaluationJson(options.fixtures, EVALUATION_LIMITS.fixtureBytes),
      { ...options, signal: controller.signal },
    );
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = options.run && (report.summary.errors > 0 || report.summary.skipped > 0) ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof ProfileEvaluationError || error instanceof Sys1ClientError ? error.code : "evaluation_error" }));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
