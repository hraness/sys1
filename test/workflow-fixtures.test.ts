import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { prepareEvaluation } from "../scripts/evaluate-profile.ts";

const root = resolve(import.meta.dir, "..");
const workflows = ["failure-triage", "evidence-relevance", "claim-support"] as const;
const partitions = ["development", "screening"] as const;
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8")) as unknown;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const manifestSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })),
  units: z.array(z.object({
    id: z.string(), workflow: z.enum(workflows), partition: z.enum(partitions), source_family: z.string().min(1),
  })),
});

describe("frozen workflow screening corpus", () => {
  test("every explicitly listed artifact matches its frozen byte size and SHA256", () => {
    const manifest = manifestSchema.parse(readJson("benchmarks/workflows/manifest.json"));
    const expectedFiles = [
      ...workflows.flatMap((workflow) => [
        `examples/workflows/${workflow}.profile.json`,
        ...partitions.map((partition) => `benchmarks/workflows/${workflow}.${partition}.json`),
      ]),
      "scripts/workflow-baselines.ts",
      "benchmarks/workflows/README.md",
    ];
    expect(manifest.files.map(({ path }) => path).sort()).toEqual(expectedFiles.sort());
    for (const artifact of manifest.files) {
      const bytes = readFileSync(join(root, artifact.path));
      expect(bytes.byteLength).toBe(artifact.bytes);
      expect(digest(bytes)).toBe(artifact.sha256);
    }
  });

  test("the three profile files preserve their original prototype bytes", () => {
    // These digests identify the original profiles, independently of edits to the manifest.
    const originalProfiles = {
      "failure-triage": "da067bf8efb546af6c1c13940f48a5ce36e67c59661c1a708b0790f37efa16bd",
      "evidence-relevance": "a4e0ccfea3cf5f4951c5ffd838f9acfaaa33135e8e6bf20a6bdc4b448120ae0d",
      "claim-support": "d63ab5b57de84c9cca1aac72da766e5bbf0a6eff42710b91f84617f487585c3b",
    };
    for (const workflow of workflows) {
      expect(digest(readFileSync(join(root, `examples/workflows/${workflow}.profile.json`)))).toBe(originalProfiles[workflow]);
    }
  });

  test("all six fixture sets validate with 48 unique IDs and documented source families", () => {
    const manifest = manifestSchema.parse(readJson("benchmarks/workflows/manifest.json"));
    const seen = new Set<string>();
    expect(manifest.units).toHaveLength(48);
    expect(new Set(manifest.units.map(({ id }) => id)).size).toBe(48);
    for (const workflow of workflows) {
      const profile = readJson(`examples/workflows/${workflow}.profile.json`);
      const families = new Map<string, Set<string>>();
      for (const partition of partitions) {
        const fixtureInput = readJson(`benchmarks/workflows/${workflow}.${partition}.json`);
        const prepared = prepareEvaluation(profile, fixtureInput);
        expect(prepared.cases).toHaveLength(8);
        const partitionFamilies = new Set<string>();
        for (const { fixture, request } of prepared.cases) {
          expect(seen.has(fixture.id)).toBe(false);
          seen.add(fixture.id);
          const unit = manifest.units.find(({ id }) => id === fixture.id);
          expect(unit).toMatchObject({ workflow, partition });
          partitionFamilies.add(unit!.source_family);
          expect(request).not.toHaveProperty("expected");
        }
        families.set(partition, partitionFamilies);
      }
      const development = families.get("development")!;
      expect([...families.get("screening")!].some((family) => development.has(family))).toBe(false);
    }
    expect(seen.size).toBe(48);
    expect([...seen].sort()).toEqual(manifest.units.map(({ id }) => id).sort());
  });

  test("baseline CLI and evaluator accept the same optional split and family identifiers", () => {
    const directory = mkdtempSync(join(tmpdir(), "sys1-workflow-fixtures-"));
    try {
      const profile = readJson("examples/workflows/failure-triage.profile.json");
      const original = {
        id: "metadata-example",
        state: { command_purpose: "Inspect a command outcome.", exit_status: 0, excerpts: [] },
        expected: { investigation: "unknown" },
      };
      const tagged = { ...original, split: "screening-1", family: "runtime.loader_v1" };
      expect(prepareEvaluation(profile, [tagged]).cases[0]!.fixture).toMatchObject({ split: tagged.split, family: tagged.family });

      const run = (name: string, fixture: unknown) => {
        const file = join(directory, `${name}.json`);
        writeFileSync(file, JSON.stringify([fixture]));
        return Bun.spawnSync([process.execPath, join(root, "scripts/workflow-baselines.ts"), "failure-triage", file], {
          cwd: root, stdout: "pipe", stderr: "pipe", timeout: 5_000,
        });
      };
      const plainResult = run("plain", original);
      const taggedResult = run("tagged", tagged);
      expect(plainResult.exitCode).toBe(0);
      expect(taggedResult.exitCode).toBe(0);
      const reportSchema = z.object({
        cases: z.number(),
        predictions: z.array(z.object({
          id: z.string(), split: z.string().nullable(), family: z.string().nullable(),
          predicted: z.record(z.string(), z.union([z.string(), z.number()])),
        })),
      });
      const plainReport = reportSchema.parse(JSON.parse(plainResult.stdout.toString()) as unknown);
      const taggedReport = reportSchema.parse(JSON.parse(taggedResult.stdout.toString()) as unknown);
      expect(taggedReport.cases).toBe(1);
      expect(taggedReport.predictions).toHaveLength(1);
      expect(taggedReport.predictions[0]).toMatchObject({ id: original.id, split: tagged.split, family: tagged.family });
      expect(taggedReport.predictions[0]!.predicted).toEqual(plainReport.predictions[0]!.predicted);

      for (const field of ["split", "family"] as const) {
        const invalid = { ...tagged, [field]: "invalid identifier" };
        expect(() => prepareEvaluation(profile, [invalid])).toThrow("invalid_input");
        const result = run(`invalid-${field}`, invalid);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
