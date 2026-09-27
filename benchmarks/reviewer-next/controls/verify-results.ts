import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeThreshold } from "../../../src/audit/benchmark.ts";
import { directory, loadControls, sha256 } from "./corpus.ts";

const corpus = loadControls();
const read = (name: string) => readFileSync(join(directory, name), "utf8");
const freeze = JSON.parse(read("freeze.json")), results = JSON.parse(read("results.json"));
assert.equal(sha256(read("run.ts")), freeze.script_sha256);
assert.equal(corpus.manifest_sha256, freeze.manifest_sha256);
assert.equal(sha256(read("freeze.json")), results.freeze_sha256);
assert.equal(results.script_sha256, freeze.script_sha256);
assert.equal(results.route, "typesafe/jev-1.13.0"); assert.equal(results.route, freeze.route);
assert.equal(freeze.purpose, "fresh-clean-controls-original-broad-questions");
assert.equal(freeze.cap, 12); assert.equal(freeze.retries, 0);
assert.deepEqual(freeze.thresholds, { medium: 0.8, high: 0.9 });
assert.equal(results.cap, 12); assert.equal(results.requests, 12); assert.equal(results.dispatches, 12);
assert.equal(results.complete, true); assert.equal(results.results.length, 12); assert.equal(freeze.requests.length, 12);
const fixtures = [...corpus.fixtures, ...corpus.diagnostics];
const expectedRules = freeze.rules.map((rule: { id: string }) => rule.id).sort();
assert.equal(new Set(expectedRules).size, 4);
const samples: { label: "clean"; score: number }[] = [];
let answers = 0;
for (const [index, result] of results.results.entries()) {
  const request = freeze.requests[index], fixture = fixtures[index]!;
  assert.equal(result.id, fixture.id); assert.equal(result.id, request.id);
  assert.equal(result.target, fixture.rule); assert.equal(result.target, request.target);
  assert.equal(result.role, index < 10 ? "primary" : "diagnostic");
  assert.equal(result.admitted_label, index < 10 ? "clean" : null);
  assert.equal(result.diagnostic_hypothesis, index < 10 ? null : fixture.label);
  assert.equal(result.request_sha256, request.request_sha256);
  assert.equal(request.state_sha256, sha256(fixture.state)); assert.equal(request.question_count, 4);
  assert.equal(result.status, "evaluated");
  assert(Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0);
  assert(Number.isSafeInteger(result.input_tokens) && result.input_tokens >= 0);
  assert(Number.isSafeInteger(result.output_tokens) && result.output_tokens >= 0);
  assert.deepEqual(result.answers.map((answer: { rule: string }) => answer.rule).sort(), expectedRules);
  for (const answer of result.answers) {
    assert(Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= 1);
    assert.equal(answer.tier, answer.score >= 0.9 ? "high" : answer.score >= 0.8 ? "medium" : "low");
    const admitted = index < 10 && answer.rule === result.target;
    assert.equal(answer.admitted_target_label, admitted ? "clean" : null);
    if (admitted) samples.push({ label: "clean", score: answer.score });
    answers++;
  }
}
assert.equal(samples.length, 10); assert.equal(answers, 48);
assert.deepEqual(results.primary, { planned: 10, evaluated: 10,
  high: summarizeThreshold(samples, 0.9), at_least_medium: summarizeThreshold(samples, 0.8) });
assert.equal(results.primary.high.recall.value, null); assert.equal(results.primary.at_least_medium.recall.value, null);
const byRule = expectedRules.map((rule: string) => {
  const scores = results.results.filter((result: { role: string; target: string }) => result.role === "primary" && result.target === rule)
    .map((result: { answers: { rule: string; score: number }[] }) => ({ label: "clean" as const, score: result.answers.find(answer => answer.rule === rule)!.score }));
  return { rule, clean: scores.length, high: summarizeThreshold(scores, 0.9), at_least_medium: summarizeThreshold(scores, 0.8) };
});
console.log(JSON.stringify({ verified_requests: 12, primary_target_labels: 10, diagnostic_only: 2, numeric_answers: answers,
  high_target_flags: results.primary.high.fp, at_least_medium_target_flags: results.primary.at_least_medium.fp,
  per_rule_support: byRule.map((item: { rule: string; clean: number }) => ({ rule: item.rule, clean: item.clean })),
  network_requests: 0 }));
