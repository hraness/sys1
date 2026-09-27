import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarkFixtureSchema } from "../../../src/audit/benchmark.ts";

export const directory = import.meta.dir;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function read(name: string) {
  const path = join(directory, name);
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4_194_304);
  return readFileSync(path, "utf8");
}
export function loadControls() {
  const manifestText = read("manifest.json");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.status, "independently-reviewed");
  assert.equal(manifest.purpose, "fresh-clean-controls-with-separate-contract-diagnostic");
  const primaryText = read("fixtures.jsonl"), diagnosticText = read("diagnostics.jsonl");
  assert.equal(sha256(primaryText), manifest.fixtures_sha256);
  assert.equal(sha256(diagnosticText), manifest.diagnostics_sha256);
  const fixtures = primaryText.trim().split("\n").map(line => benchmarkFixtureSchema.parse(JSON.parse(line)));
  const diagnostics = diagnosticText.trim().split("\n").map(line => benchmarkFixtureSchema.parse(JSON.parse(line)));
  const ids = new Set<string>();
  for (const [examples, units, diagnostic] of [[fixtures, manifest.units, false], [diagnostics, manifest.diagnostics, true]] as const) {
    assert.equal(examples.length, units.length);
    examples.forEach((fixture, index) => {
      const unit = units[index];
      assert(!ids.has(fixture.id)); ids.add(fixture.id);
      assert.equal(fixture.id, unit.id); assert.equal(fixture.rule, unit.rule);
      assert.equal(fixture.label, unit.label); assert.equal(fixture.path, unit.sections[0].path);
      assert.equal(sha256(fixture.state), unit.state_sha256);
      assert.equal(unit.label_confidence, diagnostic ? "diagnostic-only" : "supported");
      if (!diagnostic) assert.equal(fixture.label, "clean");
      assert.match(unit.commit, /^[0-9a-f]{40}$/); assert.match(unit.parent, /^[0-9a-f]{40}$/);
    });
  }
  assert.equal(fixtures.length, 10); assert.equal(diagnostics.length, 2);
  return { manifest, fixtures, diagnostics, manifest_sha256: sha256(manifestText) };
}

if (import.meta.main) {
  const corpus = loadControls();
  console.log(JSON.stringify({ primary: corpus.fixtures.length, diagnostic_only: corpus.diagnostics.length,
    manifest_sha256: corpus.manifest_sha256, requests: 0 }));
}
