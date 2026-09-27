import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Sys1Client } from "../src/client.ts";
import type { SystemOneRequest } from "../src/protocol.ts";
import { CORPUS_DIRECTORY, evaluateReviewerCorpus, loadReviewerCorpus, parseReviewerCorpus, sha256 } from "../benchmarks/reviewer/corpus.ts";

import { reproduceReviewerDefects } from "../benchmarks/reviewer/reproduce.ts";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function texts() {
  return Promise.all([readFile(join(CORPUS_DIRECTORY, "manifest.json"), "utf8"), readFile(join(CORPUS_DIRECTORY, "fixtures.jsonl"), "utf8")]);
}
async function reviewedDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sys1-reviewer-corpus-"));
  temporary.push(directory);
  await cp(CORPUS_DIRECTORY, directory, { recursive: true });
  const corpus = await loadReviewerCorpus(directory);
  corpus.manifest.status = "independently-reviewed";
  await writeFile(join(directory, "manifest.json"), JSON.stringify(corpus.manifest));
  return directory;
}
function fakeDecider() {
  const calls: SystemOneRequest[] = [];
  const client: Sys1Client = { async evaluate(request) {
    calls.push(request);
    return { response: { model: "test", answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.9 }])),
      usage: { input_tokens: 100, output_tokens: 4 } }, metadata: { backend: "fixture", attempts: 1 } };
  } };
  return { calls, client };
}

test("frozen natural corpus binds labels to public source hashes and excludes unsettled whole families", async () => {
  const corpus = await loadReviewerCorpus();
  expect(corpus.fixtures.length).toBe(15);
  expect(new Set(corpus.manifest.units.map(unit => unit.repository)).size).toBe(3);
  expect(corpus.manifest.purpose).toBe("discovery-not-heldout");
  for (const unit of corpus.manifest.units) {
    expect(unit.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(unit.evidence.length).toBeGreaterThan(20);
  }
  const pendingPairs = new Set(corpus.manifest.units.filter(unit => unit.label_confidence !== "supported").map(unit => unit.pair));
  expect(corpus.excluded).toEqual(corpus.manifest.units.filter(unit => pendingPairs.has(unit.pair)).map(unit => unit.id));
});

test("tampered source bytes, labels and source windows are rejected before requests", async () => {
  const [manifest, fixtures] = await texts();
  expect(() => parseReviewerCorpus(manifest!, `${fixtures} `)).toThrow("hash mismatch");
  const changed = JSON.parse(manifest!);
  changed.units[0].label = "clean";
  expect(() => parseReviewerCorpus(JSON.stringify(changed), fixtures!)).toThrow("identity mismatch");
  changed.units[0].label = "violation";
  changed.units[0].sections[0].end = 1;
  expect(() => parseReviewerCorpus(JSON.stringify(changed), fixtures!)).toThrow("complete source window");
  changed.units[0].sections[0].end = 161;
  changed.units[0].sections[0].path = "../../private";
  expect(() => parseReviewerCorpus(JSON.stringify(changed), fixtures!)).toThrow();
});

test("duplicate identities cannot be admitted by updating only the fixture-file hash", async () => {
  const [manifestText, fixtureText] = await texts();
  const manifest = JSON.parse(manifestText!);
  const fixtures = fixtureText!.trim().split("\n");
  fixtures[1] = fixtures[0]!;
  manifest.units[1] = manifest.units[0];
  const changed = `${fixtures.join("\n")}\n`;
  manifest.fixtures_sha256 = sha256(changed);
  expect(() => parseReviewerCorpus(JSON.stringify(manifest), changed)).toThrow("identity mismatch");
});

test("validation compiles frozen rules without a decider and never calls this a heldout result", async () => {
  const report = await evaluateReviewerCorpus({ route: "fixture/test", maxRequests: 20, timeoutMs: 1_000, validateOnly: true });
  expect(report).toMatchObject({ status: "planned", requests: 0, split: "natural-discovery", qualification: "unqualified" });
  expect(report.planned_requests).toBe(report.planned_fixtures);
  expect(report.rules).toHaveLength(4);
  expect(report.rules.every(rule => !Object.hasOwn(rule, "calibration_thresholds"))).toBe(true);
});

test("request caps preserve incomplete results without source or numeric answers in reports", async () => {
  const directory = await reviewedDirectory();
  const fake = fakeDecider();
  const report = await evaluateReviewerCorpus({ directory, route: "fixture/test", decider: fake.client, maxRequests: 1, timeoutMs: 1_000 });
  expect(fake.calls).toHaveLength(1);
  expect(report).toMatchObject({ requests: 1, complete: false, status: "incomplete", evaluated_fixtures: 1 });
  expect(report.cases[1]!.status).toBe("request_limit");
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("saveRefreshToken");
  expect(serialized).not.toContain('"noul"');
  expect(serialized).not.toContain("awaited working fallback");
});

test("unreviewed labels cannot trigger even a fake live request", async () => {
  const directory = await reviewedDirectory();
  const corpus = await loadReviewerCorpus(directory);
  corpus.manifest.status = "frozen-for-independent-label-review";
  await writeFile(join(directory, "manifest.json"), JSON.stringify(corpus.manifest));
  const fake = fakeDecider();
  await expect(evaluateReviewerCorpus({ directory, route: "fixture/test", decider: fake.client, maxRequests: 20, timeoutMs: 1_000 })).rejects.toThrow("independent label review");
  expect(fake.calls).toHaveLength(0);
});

test("three public repairs change the original executable behavior", async () => {
  const report = await reproduceReviewerDefects();
  expect(report).toMatchObject({ status: "passed", families: 3 });
});
