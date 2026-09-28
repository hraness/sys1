import assert from "node:assert/strict";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileUnit, QUESTION_FORMAT } from "../../../src/audit/compile.ts";
import { violationScore } from "../../../src/audit/evaluate.ts";
import { summarizeThreshold } from "../../../src/audit/benchmark.ts";
import { loadPack } from "../../../src/audit/pack.ts";
import { ruleRevision } from "../../../src/audit/schema.ts";
import { validateResponseForRequest } from "../../../src/response.ts";
import { configSchema } from "../../../src/config.ts";
import { createRouter } from "../../../src/runtime.ts";
import { directory, loadControls, sha256 } from "./corpus.ts";

const route = "typesafe/jev-1.13.0", cap = 12;
const corpus = loadControls();
const pack = await loadPack(join(directory, "../../reviewer/reviewer-candidates"), "repo");
assert.equal(pack.rules.length, 4); assert.equal(pack.revision, "2026.09.discovery.1");
const plan = [...corpus.fixtures, ...corpus.diagnostics].map((fixture, index) => {
  const requests = compileUnit(pack.rules, fixture.state, { model: route });
  assert.equal(requests.length, 1);
  return { id: fixture.id, role: index < 10 ? "primary" : "diagnostic", target: fixture.rule,
    admitted_label: index < 10 ? "clean" : null,
    diagnostic_hypothesis: index < 10 ? null : fixture.label, request: requests[0]! };
});
assert.equal(plan.length, cap);
const scriptHash = sha256(await readFile(import.meta.filename, "utf8"));
const publicProof = JSON.parse(await readFile(join(directory, "public-payload.json"), "utf8"));
assert.equal(publicProof.maximum_model_requests, cap);
for (const item of plan) assert(publicProof.payloads_reconstructed_from_anonymous_public_bytes.some(
  (proof: { id: string; state_sha256: string }) => proof.id === item.id && proof.state_sha256 === sha256(item.request.state as string)));
const freeze = { version: 1, purpose: "fresh-clean-controls-original-broad-questions", route, cap,
  question_format: QUESTION_FORMAT, thresholds: { medium: 0.8, high: 0.9 }, retries: 0,
  request_timeout_ms: 20000, overall_timeout_ms: 600000, script_sha256: scriptHash,
  manifest_sha256: corpus.manifest_sha256, fixtures_sha256: corpus.manifest.fixtures_sha256,
  diagnostics_sha256: corpus.manifest.diagnostics_sha256,
  rules: pack.rules.map(rule => ({ id: rule.id, revision: ruleRevision(rule) })),
  limitations: ["Ten target-rule clean controls; no admitted positive examples or recall estimate.",
    "Original unchanged four broad discovery questions, not the narrower discovery-only claim strategy.",
    "Two release timing diagnostics and all non-target outputs have no admitted labels and are excluded from metrics.",
    "Seven snapshot-as-additions controls and three actual diffs; small purposive sample, not random production traffic.",
    "No thresholds are tuned after predictions. Model scores are uncalibrated."],
  requests: plan.map(({ request, ...item }) => ({ ...item, request_sha256: sha256(JSON.stringify(request)),
    state_sha256: sha256(request.state as string), questions_sha256: sha256(JSON.stringify(request.questions)),
    state_bytes: Buffer.byteLength(request.state as string), question_count: Object.keys(request.questions).length })),
};
const mode = process.argv[2];
if (mode === "--freeze") {
  await writeFile(join(directory, "freeze.json"), JSON.stringify({ ...freeze, frozen_at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: "frozen", requests: cap, script_sha256: scriptHash })); process.exit(0);
}
const { frozen_at, ...stored } = JSON.parse(await readFile(join(directory, "freeze.json"), "utf8"));
assert.deepEqual(stored, freeze, "Frozen experiment changed");
if (mode === "--validate") {
  console.log(JSON.stringify({ status: "validated", planned_requests: cap, requests: 0, frozen_at })); process.exit(0);
}
assert.equal(mode, "--live", "Use --freeze, --validate, or --live");
assert(process.env.TYPESAFE_API_KEY, "Required environment credential is absent");
const privateDirectory = join(directory, "../../../artifacts/reviewer-next");
await mkdir(privateDirectory, { recursive: true });
// Never remove/reset this one-shot marker to repeat the frozen run.
const marker = await open(join(privateDirectory, "controls-live.started"), "wx", 0o600);
await marker.writeFile(JSON.stringify({ started_at: new Date().toISOString(), cap, script_sha256: scriptHash }) + "\n"); await marker.close();
let requests = 0, dispatches = 0;
const forwarded = new Set<string>(), overall = new AbortController();
const timer = setTimeout(() => overall.abort(), 600000);
const router = createRouter({
  config: configSchema.parse({ version: 1, routing: { policy: "hosted-only" }, hosted: { enabled: true, model: "jev-1.13.0" },
    local: { enabled: false }, gateway: { request_timeout_ms: 20000 } }),
  env: { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY },
  fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert(url.startsWith("https://api.typesafe.ai/"));
    // Pin discovery locally; each real inference response must attest this
    // exact hosted backend/model and a single attempt. No discovery HTTP calls.
    if (url === "https://api.typesafe.ai/v1/models") return Response.json({ data: [{ id: "jev-1.13.0" }] });
    if (url === "https://api.typesafe.ai/v1/limits") return new Response(null, { status: 404 });
    assert.equal(url, "https://api.typesafe.ai/v1/systemone"); assert.equal(init?.method, "POST");
    assert(dispatches < cap, "Transport request cap reached");
    const digest = sha256(String(init?.body)); assert(!forwarded.has(digest), "Duplicate dispatch refused");
    forwarded.add(digest); dispatches++;
    await appendFile(join(privateDirectory, "controls-dispatches.jsonl"), JSON.stringify({ dispatch: dispatches, request_sha256: digest, time: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return fetch(input, { ...init, signal: AbortSignal.any([overall.signal, ...(init?.signal ? [init.signal] : [])]) });
  }) as typeof fetch,
});
type Result = { id: string; role: string; target: string; admitted_label: string | null; diagnostic_hypothesis: string | null;
  request_sha256: string; status: string; elapsed_ms: number;
  answers?: { rule: string; score: number; tier: string; admitted_target_label: string | null }[];
  input_tokens?: number; output_tokens?: number };
const results: Result[] = []; const started = performance.now(); let failed = false;
try {
  for (const item of plan) {
    assert(requests < cap); overall.signal.throwIfAborted(); requests++;
    const time = performance.now(), { request, ...identity } = item;
    try {
      const result = await router.evaluate(request, { signal: overall.signal });
      const response = validateResponseForRequest(request, result.response);
      assert.equal(response.model, "jev-1.13.0"); assert.equal(result.metadata.backend, "typesafe"); assert.equal(result.metadata.attempts, 1);
      const answers = pack.rules.map(rule => {
        const score = violationScore(rule, response.answers[rule.id]!);
        return { rule: rule.id, score, tier: score >= 0.9 ? "high" : score >= 0.8 ? "medium" : "low",
          admitted_target_label: item.role === "primary" && rule.id === item.target ? "clean" : null };
      });
      results.push({ ...identity, request_sha256: sha256(JSON.stringify(request)), status: "evaluated", answers,
        elapsed_ms: Math.round(performance.now() - time), input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens });
    } catch {
      failed = true;
      results.push({ ...identity, request_sha256: sha256(JSON.stringify(request)), status: "failed", elapsed_ms: Math.round(performance.now() - time) });
      break; // No provider exception text, retries, or replacement requests.
    }
    await writeFile(join(directory, "results.json"), JSON.stringify({ version: 1, complete: false, route, cap, requests, dispatches, results }, null, 2) + "\n");
  }
} finally { clearTimeout(timer); await router.dispose(); }
const samples = results.filter(result => result.role === "primary" && result.status === "evaluated").map(result =>
  ({ label: "clean" as const, score: result.answers!.find(answer => answer.rule === result.target)!.score }));
const report = { version: 1, complete: !failed && results.length === cap, route, cap, script_sha256: scriptHash,
  freeze_sha256: sha256(await readFile(join(directory, "freeze.json"), "utf8")),
  requests, dispatches, elapsed_ms: Math.round(performance.now() - started), results,
  metrics_scope: "Admitted target-rule labels on ten primary clean controls only; diagnostics and non-target outputs excluded.",
  primary: { planned: 10, evaluated: samples.length, high: summarizeThreshold(samples, 0.9), at_least_medium: summarizeThreshold(samples, 0.8) },
};
await writeFile(join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ complete: report.complete, requests, dispatches, primary_evaluated: samples.length,
  high_target_flags: report.primary.high.fp, medium_or_high_target_flags: report.primary.at_least_medium.fp }));
if (!report.complete) process.exitCode = 1;
