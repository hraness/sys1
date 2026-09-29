import type { LaunchFacts, LaunchRelease } from "@hraness/design-kit/launch";
import pkg from "../../package.json" with { type: "json" };

// The one typed place for every number in the launch beats, the social kit,
// and the launch mockups. Each value names the file that backs it; tests pin
// the values to those files, not to the prose around them.
export const launchFacts = {
  runs: {
    value: "563",
    source: "site/skills.html#evidence (September 20, 2026 System One Skills compact-output study)",
  },
  reduction: {
    value: "35%",
    source: "site/skills.html#evidence: 1,163,594 to 754,006 UTF-8 bytes, 35.20%",
  },
  cost: {
    value: "$0.0004",
    source: "README.md and docs/model-comparison.md, TypeSafe's published workflow figures",
  },
  latency: {
    value: "0.4 seconds",
    source: "README.md and docs/model-comparison.md, TypeSafe's published workflow figures",
  },
  pairs: {
    value: "32",
    source: "docs/proof-roadmap-2026-09.md, sys1 review checkpoint whole-task pairs",
  },
  compactPairs: {
    value: "26",
    source: "docs/proof-roadmap-2026-09.md, system-one-verify whole-task pairs",
  },
  reviewCorrectRequired: {
    value: "22",
    source: "docs/proof-roadmap-2026-09.md, directed sys1 review checkpoint: 22/32 correct",
  },
  reviewCorrectWithout: {
    value: "29",
    source: "docs/proof-roadmap-2026-09.md, directed sys1 review checkpoint baseline: 29/32 correct",
  },
  version: {
    value: pkg.version,
    source: "package.json version, the release at publication",
  },
} as const satisfies LaunchFacts;

export type LaunchFactKey = keyof typeof launchFacts;

// Status comes from the release record: the package version the release
// workflow publishes to GitHub Releases. Sys1 has a public install from there.
export const launchRelease = {
  status: `Latest release: v${pkg.version}` as `Latest release: v${number}.${number}.${number}`,
  tags: ["Developer Tools", "Artificial Intelligence", "Open Source"],
} as const satisfies LaunchRelease;

export const launchMessaging = {
  names: { name: "Sys1" },
  tagline: "Hands your agent's small decisions to a fast model",
  meta: "Project skills for Codex, Claude Code and Devin: completion-claim checks and rule-based review, with small questions answered by Jev or a local model. Open source, MIT.",
} as const;

export const CANONICAL_URL = "https://sys1.io/introducing-sys1";
