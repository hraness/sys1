/**
 * Sys1's launch film: an agent's completion message can claim more than it
 * did, the reveal, checking the claim against evidence with the real verdict
 * names, a saved check with no model, the compact-output result with its
 * scope, the advisory boundary, and the agent-install end card. Numbers come
 * from scripts/launch/facts.ts; verdict and claim names from src/verify/verify.ts.
 */
import { join } from "node:path";

import { launchFacts } from "../../scripts/launch/facts.ts";
import { defineStory } from "./story.ts";
import palette from "./palette.json" with { type: "json" };

const repo = join(import.meta.dir, "../..");

export default () => defineStory({
  id: "sys1",
  brand: {
    wordmark: "sys1",
    mark: join(repo, "site/marks/sys1.svg"),
    markAspect: 1,
    // Read with site-palette.ts from https://sys1.io in dark mode; see palette.json.
    palette: { values: palette.palette },
    designKit: join(repo, "node_modules/@hraness/design-kit"),
  },
  acts: [
    { kind: "chat", headline: "Your coding agent says it's done.", accents: ["done."], sample: true, exchanges: [
      { you: "Is the fix live?", agent: "Yes. The fix is merged, deployed, and all checks passed." },
    ] },
    {
      kind: "scatter", headline: "Checking that claim means reading Git, the pull request and the live page.", accents: ["Git,"], sample: true,
      cards: [
        { app: "Git", glyph: "G", color: "#f7768e", lines: ["Was it committed", "and pushed?"] },
        { app: "Pull request", glyph: "PR", color: "#7aa2f7", lines: ["Did it merge?", "Did checks pass?"] },
        { app: "Live page", glyph: "W", color: "#9ece6a", lines: ["Is the change", "actually there?"] },
      ],
    },
    { kind: "reveal", tagline: "Saved checks and code review for coding agents." },
    {
      kind: "terminal", headline: "Sys1 checks each claim in the message against that evidence.", accents: ["each", "claim"], sample: true,
      title: "sys1 verify",
      lines: [
        { cmd: "sys1 verify --message final-message.txt --model typesafe/jev-1.13.0" },
        { out: "merged_or_pushed   confirmed     linked pull request merged", tone: "ok" },
        { out: "checks_passed      confirmed     CI run passed", tone: "ok" },
        { out: "deployed_or_live   contradicted  live page shows the old version", tone: "accent" },
        { out: "complete           unverifiable  no evidence either way", tone: "muted" },
      ],
    },
    {
      kind: "stats", headline: "The free System One Skills pack keeps test output short.", accents: ["short."],
      items: [
        { value: launchFacts.reduction.value, label: "fewer text bytes across replayed validation outputs" },
        { value: launchFacts.runs.value, label: "outputs in the replay, with every full log saved" },
      ],
      note: "Measured on output text. Whole-task token savings have not been shown.",
    },
    {
      kind: "cards", headline: "It advises. You decide.", accents: ["advises."],
      items: [
        { tag: "No model", title: "Saved checks need no model or API key" },
        { tag: "Advisory", title: "Review and completion checks are experimental" },
        { tag: "Setup", title: "Setup installs instructions only, with no hooks" },
      ],
    },
  ],
  end: {
    lead: "Ask your agent:", prompt: "Install Sys1 from sys1.io",
    terms: `MIT licensed · Latest release v${launchFacts.version.value}`, url: "sys1.io",
    finePrint: "Sample messages and results.",
  },
  formats: ["wide", "square", "portrait"],
});
