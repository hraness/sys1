import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchBeats, resolvedBeats } from "../scripts/launch/beats.ts";
import { launchFacts, launchRelease } from "../scripts/launch/facts.ts";

// Pins the launch facts to the files they cite. Prose is free to change;
// a number in the beats, the social kit, or the mockups may not drift from its source.
const root = resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("launch facts", () => {
  test("compact-output figures match the skills evidence", () => {
    const skills = read("site/skills.html");
    expect(skills).toContain(launchFacts.runs.value);
    expect(skills).toContain("1,163,594");
    expect(skills).toContain("754,006");
    expect(Math.round((1 - 754_006 / 1_163_594) * 100)).toBe(Number.parseInt(launchFacts.reduction.value, 10));
  });

  test("whole-task results match the proof roadmap", () => {
    const roadmap = read("docs/proof-roadmap-2026-09.md");
    expect(roadmap).toContain(`| \`system-one-verify\` (compact noisy output) | ${launchFacts.compactPairs.value} whole-task pairs`);
    expect(roadmap).toContain(`| \`sys1 review checkpoint\`, adopted | ${launchFacts.pairs.value} whole-task pairs`);
    expect(roadmap).toContain(
      `${launchFacts.reviewCorrectRequired.value}/${launchFacts.pairs.value} correct vs ${launchFacts.reviewCorrectWithout.value}/${launchFacts.pairs.value}`,
    );
  });

  test("status comes from the package version", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(launchFacts.version.value).toBe(pkg.version);
    expect(launchRelease.status as string).toBe(`Latest release: v${pkg.version}`);
  });

  test("every beat resolves, and the status beat carries the release status", () => {
    expect(resolvedBeats).toHaveLength(launchBeats.length);
    const status = resolvedBeats.find((beat) => beat.part === "status");
    expect(status?.post).toContain(launchRelease.status);
  });
});
