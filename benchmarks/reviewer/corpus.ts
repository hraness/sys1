import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { benchmarkFixtureSchema, benchmarkPack, type AuditBenchmarkOptions, type BenchmarkFixture } from "../../src/audit/benchmark.ts";
import { canonicalJson } from "../../src/audit/schema.ts";
import { loadPack } from "../../src/audit/pack.ts";

export const CORPUS_DIRECTORY = import.meta.dir;
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const sourcePath = benchmarkFixtureSchema.shape.path;
const sectionSchema = z.strictObject({
  path: sourcePath,
  start: z.number().int().positive().optional(), end: z.number().int().positive().optional(),
  blob_sha256: sha.optional(), excerpt_sha256: sha.optional(),
});
export const reviewerManifestSchema = z.strictObject({
  version: z.literal(1), corpus: z.string().min(1).max(128),
  status: z.enum(["frozen-for-independent-label-review", "independently-reviewed"]),
  purpose: z.literal("discovery-not-heldout"), public_visibility_verified: z.string().min(1).max(256),
  fixtures_sha256: sha,
  units: z.array(z.strictObject({
    id: benchmarkFixtureSchema.shape.id,
    repository: z.enum(["hraness/sys1", "hraness/ghostget", "hraness/design-kit"]),
    commit, parent: commit,
    representation: z.enum(["snapshot-as-additions", "actual-diff"]),
    pair: z.string().min(1).max(128), sections: z.array(sectionSchema).min(1).max(8),
    rule: benchmarkFixtureSchema.shape.rule, label: benchmarkFixtureSchema.shape.label,
    evidence: z.string().min(1).max(2_048),
    label_confidence: z.enum(["supported", "needs-independent-decision", "rejected"]),
    state_sha256: sha,
  })).min(1).max(100),
});
export type ReviewerManifest = z.infer<typeof reviewerManifestSchema>;

async function boundedRead(path: string, limit: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("corpus file must be bounded and regular");
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > limit) throw new Error("corpus file exceeds its bound");
  return text;
}

export function parseReviewerCorpus(manifestText: string, fixturesText: string) {
  const manifest = reviewerManifestSchema.parse(JSON.parse(manifestText) as unknown);
  if (sha256(fixturesText) !== manifest.fixtures_sha256) throw new Error("corpus fixture file hash mismatch");
  const fixtures = fixturesText.trim().split("\n").map(line => benchmarkFixtureSchema.parse(JSON.parse(line) as unknown));
  if (fixtures.length !== manifest.units.length) throw new Error("corpus unit count mismatch");
  const ids = new Set<string>();
  fixtures.forEach((fixture, index) => {
    const unit = manifest.units[index]!;
    if (ids.has(fixture.id) || fixture.id !== unit.id || fixture.rule !== unit.rule || fixture.label !== unit.label ||
        sha256(fixture.state) !== unit.state_sha256 || fixture.path !== unit.sections[0]!.path) {
      throw new Error("corpus fixture identity mismatch");
    }
    ids.add(fixture.id);
    if (unit.representation === "snapshot-as-additions") {
      for (const section of unit.sections) {
        if (section.start === undefined || section.end === undefined || section.end < section.start ||
            section.blob_sha256 === undefined || section.excerpt_sha256 === undefined) throw new Error("snapshot needs a complete source window");
      }
    } else if (unit.sections.length !== 1) throw new Error("actual diff requires one source path");
  });
  // Related repairs never escape exclusion of an unresolved/contested family.
  const excludedPairs = new Set(manifest.units.filter(unit => unit.label_confidence !== "supported").map(unit => unit.pair));
  const selected: BenchmarkFixture[] = [];
  const excluded: string[] = [];
  fixtures.forEach((fixture, index) => {
    if (excludedPairs.has(manifest.units[index]!.pair)) excluded.push(fixture.id);
    else selected.push(fixture);
  });
  return { manifest, fixtures, selected, excluded, manifest_sha256: sha256(manifestText) };
}

export async function loadReviewerCorpus(directory = CORPUS_DIRECTORY) {
  const [manifest, fixtures] = await Promise.all([
    boundedRead(join(directory, "manifest.json"), 1_048_576),
    boundedRead(join(directory, "fixtures.jsonl"), 4_194_304),
  ]);
  return parseReviewerCorpus(manifest, fixtures);
}

export async function evaluateReviewerCorpus(options: Omit<AuditBenchmarkOptions, "pack" | "fixtures"> & { directory?: string }) {
  const directory = options.directory ?? CORPUS_DIRECTORY;
  const corpus = await loadReviewerCorpus(directory);
  if (!options.validateOnly && corpus.manifest.status !== "independently-reviewed") throw new Error("live corpus evaluation requires independent label review");
  const pack = await loadPack(join(directory, "reviewer-candidates"), "repo");
  const packText = await boundedRead(join(directory, "reviewer-candidates", "pack.yaml"), 1_048_576);
  // Reuse the fixed-threshold benchmark engine, but never publish its internal
  // heldout label: these cases were selected while writing the rule wording.
  const result = await benchmarkPack({ ...options, pack, fixtures: {
    split: "heldout", fixtures: corpus.selected,
    file_sha256: { calibration: corpus.manifest.fixtures_sha256, heldout: corpus.manifest.fixtures_sha256 },
    content_sha256: sha256(canonicalJson(corpus.selected)),
  } });
  const { fixture_sha256: _legacyFiles, ...report } = result;
  return {
    ...report, split: "natural-discovery" as const,
    corpus: corpus.manifest.corpus,
    manifest_sha256: corpus.manifest_sha256,
    fixtures_sha256: corpus.manifest.fixtures_sha256,
    pack_sha256: sha256(packText),
    excluded_fixtures: corpus.excluded,
    families: new Set(corpus.manifest.units.filter(unit => !corpus.excluded.includes(unit.id)).map(unit => unit.pair)).size,
    warnings: ["Discovery cases were selected while writing these rules; this is not held-out accuracy.",
      "Source-window replay is not the original bug-introducing diff or a whole-repository review.",
      "Before/after controls share families and repair comments; intervals assume more independence than this set provides.",
      "Clean means no visible target-rule violation, not absence of all defects.",
      "Model scores and rule qualification remain uncalibrated and unqualified."],
  };
}
