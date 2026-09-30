import type { LaunchFacts, LaunchRelease } from "@hraness/design-kit/launch";
import published from "../../site/published-release.json" with { type: "json" };

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
    value: published.version,
    source: "site/published-release.json version, the verified public release",
  },
} as const satisfies LaunchFacts;

export type LaunchFactKey = keyof typeof launchFacts;

// Public status follows the verified release record independently of source
// versions that have not completed publication.
export const launchRelease = {
  status: `Latest release: v${published.version}` as `Latest release: v${number}.${number}.${number}`,
  tags: ["Developer Tools", "Artificial Intelligence", "Open Source"],
} as const satisfies LaunchRelease;

export const launchMessaging = {
  names: { name: "Sys1" },
  tagline: "Shorten test logs and add checks for your coding agent",
  meta: "Sys1 helps coding agents read compact check output and add advisory code review and completion checks. Install skills for Codex, Claude Code, or Devin.",
} as const;

export const CANONICAL_URL = "https://sys1.io/introducing-sys1";
