import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { benchmarkFixtureSchema } from "../../src/audit/benchmark.ts";
import { packFileSchema } from "../../src/audit/schema.ts";

export const directory = import.meta.dir;
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const role = z.enum(["introduction", "repair", "control"]);
const label = z.enum(["clean", "violation"]);
const range = z.strictObject({ start: z.number().int().nonnegative(), count: z.number().int().nonnegative() });
const snapshotLabel = z.enum(["introduction", "repair_parent", "repair", "clean_parent", "clean"]);
const snapshot = z.strictObject({
  label: snapshotLabel, commit, src_tree: commit, source_files: z.number().int().positive(),
  files: z.strictObject({ "src/backends.ts": hash, "package.json": hash, "bun.lock": hash, LICENSE: hash }),
  archive_sha256: hash, archive_bytes: z.number().int().positive(), archive_url: z.url(),
  verified_records: z.number().int().positive(),
});
const scenario = z.strictObject({ posts: z.number().int().positive(), response_status: z.number().int(), response_error: z.string().nullable() });
export const manifestSchema = z.strictObject({
  version: z.literal(1), corpus: z.literal("reviewer-contract-response-finality-2026-09-28"),
  status: z.literal("source-only-experimental"), repository: z.literal("https://github.com/hraness/sys1"),
  path: z.literal("src/backends.ts"), family: z.literal("http-response-finality"),
  fixture_representation: z.literal("collector-unified-diff-hunk"), context_lines: z.literal(15),
  fixtures_sha256: hash, pack_sha256: hash, snapshots: z.array(snapshot).length(5),
  diffs: z.array(z.strictObject({ role, commit, parent: commit.nullable(), sha256: hash,
    hunks: z.number().int().positive(), git_header: z.string() })).length(3),
  units: z.array(z.strictObject({ id: z.string(), role, commit, parent: commit.nullable(),
    hunk_index: z.number().int().positive(), label, state_sha256: hash,
    old_range: range, new_range: range, evidence: z.string() })).length(6),
  authoring: z.strictObject({ frozen_at: z.string(), predictions_before_freeze: z.literal(0),
    rule_json_sha256: hash, rule_json: z.string(), author_note_sha256: hash, author_note_rendering: z.string(), author_note_rendering_sha256: hash,
    author_note_rendering_notice: z.string(),
    contract_packet_sha256: hash, contract_packet: z.string() }),
  requirement_sources: z.array(z.strictObject({ commit, path: z.string(), sha256: hash, url: z.url() })).length(2),
  public_verification: z.strictObject({ date: z.string(), method: z.string(), records: z.literal(122) }),
  reproduction: z.strictObject({ bun: z.literal("1.3.14"), zod: z.literal("4.6.2"), expected_assertions: z.literal(63),
    results: z.array(z.strictObject({ label: snapshotLabel, commit, direct_result: z.enum(["transport", "response"]),
      requirement_met: z.boolean(), scenarios: z.strictObject({ broken_body: scenario, http_error: scenario, successful_body: scenario }) })).length(5) }),
  limitations: z.array(z.string()).min(1),
});
const stateSchema = z.strictObject({ path: z.literal("src/backends.ts"), kind: z.enum(["added", "modified"]),
  language: z.literal("typescript"), oldRange: range, newRange: range, patch: z.string() });

function read(name: string): string {
  const path = join(directory, name);
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_048_576, "expected a bounded regular corpus file");
  return readFileSync(path, "utf8");
}

export function loadContractCorpus() {
  const manifestText = read("manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(manifestText) as unknown);
  const fixtureText = read("fixtures.jsonl");
  const packText = read("pack.yaml");
  assert.equal(sha256(fixtureText), manifest.fixtures_sha256);
  assert.equal(sha256(packText), manifest.pack_sha256);
  const fixtures = fixtureText.trimEnd().split("\n").map(line => benchmarkFixtureSchema.parse(JSON.parse(line) as unknown));
  const pack = packFileSchema.parse(Bun.YAML.parse(packText));
  const authoring = manifest.authoring;
  assert.equal(sha256(authoring.rule_json), authoring.rule_json_sha256);
  assert.equal(sha256(authoring.author_note_rendering), authoring.author_note_rendering_sha256);
  assert.equal(sha256(authoring.contract_packet), authoring.contract_packet_sha256);
  const rawPack = z.object({ rules: z.array(z.unknown()).length(1) }).parse(Bun.YAML.parse(packText));
  assert.deepEqual(rawPack.rules[0], JSON.parse(authoring.rule_json) as unknown);
  assert.equal(pack.rules[0]?.gate, false);
  assert.equal(fixtures.length, 6);
  const ids = new Set<string>();
  const hunks = new Map<string, string[]>();
  fixtures.forEach((fixture, index) => {
    const unit = manifest.units[index]!;
    assert(!ids.has(fixture.id)); ids.add(fixture.id);
    assert.equal(fixture.id, unit.id);
    assert.equal(fixture.rule, pack.rules[0]?.id);
    assert.equal(fixture.label, unit.label);
    assert.equal(sha256(fixture.state), unit.state_sha256);
    const state = stateSchema.parse(JSON.parse(fixture.state) as unknown);
    assert.equal(state.path, fixture.path);
    assert.equal(state.language, fixture.language);
    assert.equal(state.kind, unit.role === "introduction" ? "added" : "modified");
    assert.deepEqual(state.oldRange, unit.old_range);
    assert.deepEqual(state.newRange, unit.new_range);
    const starts = [...state.patch.matchAll(/^@@ /gm)];
    assert.equal(starts.length, 1, "each fixture must contain one complete hunk");
    const hunk = state.patch.slice(starts[0]!.index);
    const members = hunks.get(unit.role) ?? [];
    assert.equal(unit.hunk_index, members.length + 1);
    members.push(hunk); hunks.set(unit.role, members);
  });
  for (const diff of manifest.diffs) {
    const members = hunks.get(diff.role)!;
    assert.equal(members.length, diff.hunks);
    assert.equal(sha256(diff.git_header + members.join("")), diff.sha256, "all authentic file-diff hunks must be present");
    assert(manifest.units.filter(unit => unit.role === diff.role).every(unit => unit.commit === diff.commit && unit.parent === diff.parent));
  }
  assert.deepEqual(manifest.snapshots.map(item => item.label), ["introduction", "repair_parent", "repair", "clean_parent", "clean"]);
  return { manifest, fixtures, pack, manifest_sha256: sha256(manifestText) };
}

if (import.meta.main) {
  const corpus = loadContractCorpus();
  console.log(JSON.stringify({ fixtures: corpus.fixtures.length, rules: corpus.pack.rules.length,
    manifest_sha256: corpus.manifest_sha256, requests: 0 }));
}
