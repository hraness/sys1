import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { compileUnit, QUESTION_FORMAT } from "../../src/audit/compile.ts";
import { canonicalJson } from "../../src/audit/schema.ts";
import { serializedBytes } from "../../src/protocol.ts";
import { directory, loadContractCorpus, sha256 } from "./corpus.ts";

const ROUTE = "typesafe/jev-1.13.0";
const MODEL = "jev-1.13.0";
const FREEZE = "cc007041a031d90dd4a5415253a949cdc32dda182b5b1cdd56dbc79c7f6e9155";
// The complete 44-entry source map from the frozen experiment, in canonical JSON.
const SOURCE_DIGESTS = "b95fdff734d5962136aea14de11e6a1cb90dbdec503a782210d241ce309b44d5";
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ start: count, count });
const id = z.string().regex(/^sys1-response-finality-(?:introduction|repair|control)-h[1-3]$/);
const unitSchema = z.strictObject({
  id, group: z.enum(["introduction", "repair", "clean"]), expected: z.enum(["violation", "no-new-violation"]),
  unit_id: hash, old_range: range, new_range: range, request_sha256: hash, wire_request_sha256: hash,
  state_sha256: hash, questions_sha256: hash, state_bytes: count, request_bytes: count,
});
const resultSchema = z.strictObject({
  id, request_sha256: hash, status: z.literal("evaluated"), model_score: z.number().finite().min(0).max(1),
  flagged: z.boolean(), elapsed_ms: count,
  usage: z.strictObject({ input_tokens: count, output_tokens: count }),
});
const sourcePath = z.string().regex(/^(?:src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.ts|package\.json|bun\.lock)$/);
export const resultsSchema = z.strictObject({
  schema: z.literal(1), source_commit: z.literal("7305524daed2712dd71084b4c697f35eab457167"),
  route: z.literal(ROUTE), question_format: z.literal(2), freeze_sha256: z.literal(FREEZE),
  max_requests: z.literal(6), thresholds: z.strictObject({ medium: z.literal(0.8), high: z.literal(0.9) }),
  source_digests: z.record(sourcePath, hash), units: z.array(unitSchema).length(6),
  results: z.array(resultSchema).length(6), calls: z.literal(6), dispatches: z.literal(6),
  complete: z.literal(true), elapsed_ms: count,
});

function readBounded(path: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.size <= 1_048_576, "expected a bounded regular evidence or source file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Validate published observations without a router, provider, or inference path. */
export function verifyResults(input: unknown) {
  const evidence = resultsSchema.parse(input);
  assert.equal(QUESTION_FORMAT, evidence.question_format, "production question format changed");
  assert.equal(sha256(canonicalJson(evidence.source_digests)), SOURCE_DIGESTS, "frozen source map changed or is incomplete");
  const repo = resolve(directory, "../..");
  for (const [path, digest] of Object.entries(evidence.source_digests)) {
    assert.equal(sha256(readBounded(join(repo, path))), digest, `source changed: ${path}`);
  }
  const { manifest, fixtures, pack } = loadContractCorpus();
  const rule = pack.rules[0]!;
  assert.deepEqual(rule.tiers, evidence.thresholds);
  assert.equal(rule.gate, false);
  const expectedUnits = fixtures.map((fixture, index) => {
    const metadata = manifest.units[index]!;
    const requests = compileUnit([rule], fixture.state, { model: ROUTE });
    assert.equal(requests.length, 1, "each fixture must compile to one request");
    const request = requests[0]!;
    assert.deepEqual(Object.keys(request.questions), [rule.id]);
    return {
      id: fixture.id, group: metadata.role === "control" ? "clean" : metadata.role,
      expected: fixture.label === "violation" ? "violation" : "no-new-violation",
      unit_id: sha256(fixture.state), old_range: metadata.old_range, new_range: metadata.new_range,
      request_sha256: sha256(JSON.stringify(request)),
      wire_request_sha256: sha256(JSON.stringify({ ...request, model: MODEL })),
      state_sha256: sha256(JSON.stringify(request.state)), questions_sha256: sha256(JSON.stringify(request.questions)),
      state_bytes: serializedBytes(request.state), request_bytes: Buffer.byteLength(JSON.stringify(request)),
    };
  });
  assert.deepEqual(evidence.units, expectedUnits, "unit inputs must match all six compiled fixtures in frozen order");
  const resultsById = new Map(evidence.results.map(result => [result.id, result]));
  assert.equal(resultsById.size, 6, "result IDs must be unique");
  const requestDigests = new Set<string>();
  let inputTokens = 0, outputTokens = 0, evaluationMs = 0, mediumFlags = 0, highFlags = 0;
  for (const unit of expectedUnits) {
    const result = resultsById.get(unit.id);
    assert(result !== undefined, "every unit must have one result");
    assert.equal(result.request_sha256, unit.request_sha256, "result request digest does not match its unit");
    assert(!requestDigests.has(result.request_sha256), "each result must describe a distinct request");
    requestDigests.add(result.request_sha256);
    assert.equal(result.flagged, result.model_score >= evidence.thresholds.medium, "flag does not match the frozen threshold");
    assert(result.elapsed_ms <= evidence.elapsed_ms, "one evaluation cannot exceed the entire serial run");
    inputTokens += result.usage.input_tokens; outputTokens += result.usage.output_tokens;
    evaluationMs += result.elapsed_ms;
    if (result.flagged) mediumFlags += 1;
    if (result.model_score >= evidence.thresholds.high) highFlags += 1;
  }
  assert(Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) && Number.isSafeInteger(evaluationMs), "aggregate counters exceed safe integer range");
  // Each of six measurements and the overall measurement was rounded separately.
  assert(evaluationMs <= evidence.elapsed_ms + 4, "serial evaluation durations exceed run duration");
  assert.equal(requestDigests.size, evidence.calls);
  assert.equal(evidence.calls, evidence.dispatches);
  return { verified: true, units: expectedUnits.length, recorded_calls: evidence.calls,
    recorded_dispatches: evidence.dispatches, medium_flags: mediumFlags, high_flags: highFlags,
    input_tokens: inputTokens, output_tokens: outputTokens, elapsed_ms: evidence.elapsed_ms,
    freeze_sha256: evidence.freeze_sha256, network_requests: 0 };
}

if (import.meta.main) {
  assert.equal(process.argv.length, 2, "Usage: bun --no-env-file --no-install benchmarks/reviewer-contract/verify-results.ts");
  const input: unknown = JSON.parse(new TextDecoder().decode(readBounded(join(directory, "results.json"))));
  console.log(JSON.stringify(verifyResults(input)));
}
