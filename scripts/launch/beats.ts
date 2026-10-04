import { resolveLaunchBeats, type LaunchBeat } from "@hraness/design-kit/launch";
import { launchFacts, launchRelease } from "./facts.ts";

// Shared product facts for the illustrated workflows and the repository's
// social kit. The article renders the practical workflows without the kit.
export const launchBeats: readonly LaunchBeat[] = [
  {
    id: "context",
    part: "what",
    headline: "Give your coding agent a repeatable check",
    post: "A coding agent's \"done\" can claim more than it did. Sys1 checks completion claims against Git, pull requests and live pages, and reviews code against your rules. You decide what needs attention.",
    visual: { kind: "mockup", id: "agent-review", state: {} },
    alt: "Illustration: a coding agent runs a Sys1 review on its own change, gets one advisory finding, and fixes it.",
  },
  {
    id: "short-logs",
    part: "does",
    headline: "Noisy test logs come back as a short result",
    post: "The separate system-one-verify skill returns a check's exit status and a short excerpt, keeping the full log on disk. Across {runs} recorded outputs, replay returned {reduction} less text. It needs no model.",
    visual: { kind: "mockup", id: "compact", state: {} },
    alt: "Illustration: a failing check comes back as an exit status and a short excerpt, with the full log saved on disk.",
    facts: ["runs", "reduction"],
    detailHref: "/skills#shipped",
  },
  {
    id: "rules",
    part: "does",
    headline: "Review changes against your own rules",
    post: "Use sys1 review to check selected changes against repository rules, such as keeping test assertions or handling errors. Each advisory finding names the rule and source location for your agent to investigate.",
    visual: { kind: "mockup", id: "pr-comment", state: {} },
    alt: "Illustration: a review comment identifies a new empty catch block and the repository rule it breaks.",
    detailHref: "/skills#review",
  },
  {
    id: "done-check",
    part: "does",
    headline: "Check the agent's completion message",
    post: "Use sys1 verify to compare a proposed completion message with Git, linked pull requests, and live pages. It reports agreement, contradictions, and unavailable evidence. Inspect the advisory result before relying on the claim.",
    visual: { kind: "mockup", id: "verify", state: {} },
    alt: "Illustration: sys1 verify flags a claimed push because commits are local and leaves test results unverifiable.",
    detailHref: "/skills#verify",
  },
  {
    id: "probabilities",
    part: "how",
    headline: "Use structured answers in your own application",
    post: "Sys1's API returns yes/no, choice, and score answers with probabilities. Use TypeSafe's hosted Jev, an experimental local model, or a compatible server you configure. Sys1 checks each answer against the question asked.",
    visual: { kind: "mockup", id: "decision", state: {} },
    alt: "Illustration: an app asks one choice question and gets back a named answer with its probability.",
    detailHref: "/docs#integration",
  },
  {
    id: "who",
    part: "who",
    headline: "Add instructions to the agent you use",
    post: "Sys1 installs project skills for Codex, Claude Code, and Devin. Other agents can use the CLI. The bundled review rules cover JavaScript and TypeScript; add repository rules for other languages and conventions.",
    visual: { kind: "mockup", id: "agent-verify", state: {} },
    alt: "Illustration: asked whether it pushed, an agent checks its own claim, finds local commits, and corrects itself.",
  },
  {
    id: "reuse",
    part: "vision",
    headline: "Keep useful feedback with the repository",
    post: "Record each review finding as useful, incorrect, or unverifiable. Sys1 keeps that feedback locally, suppresses repeated findings, and reuses a recent unchanged review without another model call.",
    visual: { kind: "mockup", id: "feedback", state: {} },
    alt: "Illustration: an agent records feedback after investigating a review finding.",
    detailHref: "/docs#audit",
  },
  {
    id: "limits",
    part: "limits",
    headline: "Investigate findings and missing evidence",
    post: "Review findings are advisory. Check them against your source and tests. Verification distinguishes confirmed claims, contradictions and missing evidence, so the agent can fix a mismatch or collect what it needs before reporting back.",
    visual: { kind: "diagram", src: "#measured" },
    alt: "Verification results distinguish confirmed claims, contradictions and missing evidence.",
    detailHref: "/docs#verify",
  },
  {
    id: "status",
    part: "status",
    headline: "Install the skill for your next change",
    post: "Sys1 is open source under MIT. Ask your agent to install Sys1 from sys1.io, then add a project skill. Setup writes instructions without calling a model. Hosted Jev requires your key and explicit activation. {status}.",
    visual: { kind: "mockup", id: "install", state: {} },
    alt: "Illustration: two setup commands write the review and verify skills into a project without calling a model.",
    facts: ["status"],
    detailHref: "/docs#getting-started",
  },
];

export const launchFactsWithStatus = { ...launchFacts, status: { value: launchRelease.status, source: "package.json version via the release workflow" } };

export const resolvedBeats = resolveLaunchBeats(launchBeats, launchFactsWithStatus, { allowNumerals: ["Sys1", "sys1"] });
