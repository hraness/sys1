import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadControls, sha256 } from "./corpus.ts";

const names = ["sys1", "ghostget", "design-kit", "wordcell", "slopcamera"];
const args = process.argv.slice(2);
assert.equal(args.length, names.length, "Usage: bun verify-sources.ts SYS1 GHOSTGET DESIGN_KIT WORDCELL SLOPCAMERA");
const paths = Object.fromEntries(names.map((name, index) => [`hraness/${name}`, args[index]! ]));
const corpus = loadControls();
const git = (repository: string, ...args: string[]) => execFileSync("git", ["--no-lazy-fetch", "-C", paths[repository]!, ...args], { encoding: "utf8", maxBuffer: 4_194_304 });
for (const [index, unit] of [...corpus.manifest.units, ...corpus.manifest.diagnostics].entries()) {
  assert.equal(git(unit.repository, "rev-parse", `${unit.commit}^`).trim(), unit.parent);
  let state = "";
  for (const section of unit.sections) {
    const blob = git(unit.repository, "show", `${unit.commit}:${section.path}`);
    assert.equal(sha256(blob), section.blob_sha256);
    if (unit.representation === "actual-diff") {
      assert.equal(sha256(git(unit.repository, "show", `${unit.parent}:${section.path}`)), section.parent_blob_sha256);
      state = git(unit.repository, "diff", "--no-ext-diff", "--no-textconv", `--unified=${unit.unified}`, unit.parent, unit.commit, "--", section.path);
    } else {
      const lines = blob.split("\n").slice(section.start - 1, section.end);
      assert.equal(sha256(lines.join("\n") + "\n"), section.excerpt_sha256);
      state += `diff --git a/${section.path} b/${section.path}\n--- /dev/null\n+++ b/${section.path}\n@@ -0,0 +${section.start},${lines.length} @@\n${lines.map(line => `+${line}\n`).join("")}`;
    }
  }
  assert.equal(sha256(state), unit.state_sha256);
  assert.equal(state, [...corpus.fixtures, ...corpus.diagnostics][index]!.state);
}
for (const license of corpus.manifest.license_revisions) {
  assert.equal(sha256(git(license.repository, "show", `${license.commit}:LICENSE`)), license.license_sha256);
}
console.log(JSON.stringify({ verified_units: 12, verified_license_revisions: corpus.manifest.license_revisions.length, manifest_sha256: corpus.manifest_sha256 }));
