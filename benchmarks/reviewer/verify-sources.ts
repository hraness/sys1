import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { loadReviewerCorpus, sha256 } from "./corpus.ts";

const [sys1, ghostget, designKit] = process.argv.slice(2);
if (process.argv.length !== 5 || sys1 === undefined || ghostget === undefined || designKit === undefined) {
  throw new Error("Usage: bun benchmarks/reviewer/verify-sources.ts SYS1_CHECKOUT GHOSTGET_CHECKOUT DESIGN_KIT_CHECKOUT");
}
const checkouts = { "hraness/sys1": resolve(sys1), "hraness/ghostget": resolve(ghostget), "hraness/design-kit": resolve(designKit) };
const corpus = await loadReviewerCorpus();
for (let index = 0; index < corpus.manifest.units.length; index++) {
  const unit = corpus.manifest.units[index]!;
  const git = (...args: string[]) => execFileSync("git", ["-C", checkouts[unit.repository], ...args], { encoding: "utf8", maxBuffer: 4_194_304 });
  if (git("rev-parse", `${unit.commit}^`).trim() !== unit.parent) throw new Error(`${unit.id}: parent changed`);
  let state = "";
  if (unit.representation === "actual-diff") {
    state = git("diff", "--no-ext-diff", "--no-textconv", "--unified=12", unit.parent, unit.commit, "--", unit.sections[0]!.path);
  } else {
    for (const section of unit.sections) {
      const blob = git("show", `${unit.commit}:${section.path}`);
      const lines = blob.split("\n").slice(section.start! - 1, section.end!);
      const excerpt = `${lines.join("\n")}\n`;
      if (sha256(blob) !== section.blob_sha256 || sha256(excerpt) !== section.excerpt_sha256) throw new Error(`${unit.id}: source bytes changed`);
      state += `diff --git a/${section.path} b/${section.path}\n--- /dev/null\n+++ b/${section.path}\n@@ -0,0 +${section.start},${lines.length} @@\n${lines.map(line => `+${line}\n`).join("")}`;
    }
  }
  if (sha256(state) !== unit.state_sha256 || state !== corpus.fixtures[index]!.state) throw new Error(`${unit.id}: reproduced state differs`);
}
console.log(JSON.stringify({ verified_units: corpus.manifest.units.length, manifest_sha256: corpus.manifest_sha256, fixtures_sha256: corpus.manifest.fixtures_sha256 }));
