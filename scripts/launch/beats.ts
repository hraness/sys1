import { resolveLaunchBeats, type LaunchBeat } from "@hraness/design-kit/launch";
import { launchFacts, launchRelease } from "./facts.ts";

// "Introducing Sys1" as bite-size beats. Each post stands alone, so the
// social kit is cut straight from this list. Numbers only through {facts}.
export const launchBeats: readonly LaunchBeat[] = [
  {
    id: "context",
    part: "what",
    headline: "Sys1 hands your agent's small decisions to a fast model",
    post: "Sys1 hands your coding agent's small decisions to a fast model, saving tokens and time. Did the test fail, does the diff break a rule, was it pushed: quick calls that leave your agent free for the code.",
    visual: { kind: "mockup", id: "agent-review", state: {} },
    alt: "Illustration: a coding agent runs a Sys1 review on its own change, gets one advisory finding, and fixes it.",
  },
  {
    id: "short-logs",
    part: "does",
    headline: "Noisy test logs come back as a short result",
    post: "Long test and build logs eat an agent's context. The companion system-one-verify skill runs the check once, returns a short excerpt, and keeps the full log on disk. Replayed through it, {runs} recorded check outputs came back {reduction} smaller in total.",
    visual: { kind: "mockup", id: "compact", state: {} },
    alt: "Illustration: a failing check comes back as an exit status and a short excerpt, with the full log saved on disk.",
    facts: ["runs", "reduction"],
    detailHref: "/skills#evidence",
  },
  {
    id: "done-check",
    part: "does",
    headline: "Catch \"done\" when it isn't done",
    post: "Agents sometimes say they pushed when they didn't. sys1 verify compares the agent's final message with Git, pull requests and live pages. A claimed push with nothing pushed shows up as a contradiction.",
    visual: { kind: "mockup", id: "verify", state: {} },
    alt: "Illustration: the sys1 verify command flags a claimed push as contradicted because commits are still local.",
    detailHref: "/docs#verify",
  },
  {
    id: "rules",
    part: "does",
    headline: "Review changes against your own rules",
    post: "sys1 review checks a batch of changes against your repository's rules. When it catches a real mistake, turn that into a new rule and every later review looks for it. Findings are advisory, and unchanged code isn't paid for twice.",
    visual: { kind: "mockup", id: "pr-comment", state: {} },
    alt: "Illustration: an advisory review comment on a made-up pull request lists one finding from a repository rule.",
    detailHref: "/docs#audit",
  },
  {
    id: "probabilities",
    part: "how",
    headline: "Small questions get probabilities, not paragraphs",
    post: "Each small question goes to Jev, TypeSafe's hosted decision model, or a local model you pick. You get back a yes/no, a choice or a score with probabilities. TypeSafe's published figures put a decision at about {cost} and {latency}.",
    visual: { kind: "mockup", id: "decision", state: {} },
    alt: "Illustration: an app asks one choice question and gets back a named answer with its probability.",
    facts: ["cost", "latency"],
    detailHref: "/docs",
  },
  {
    id: "who",
    part: "who",
    headline: "For people who let agents work on real repositories",
    post: "Sys1 is for developers who run Codex, Claude Code or Devin on real repositories. Verify reads the final message from any agent. Review ships rules for JavaScript and TypeScript; other languages need rules of your own.",
    socialPost: "Sys1 is for developers who run Codex, Claude Code or Devin on real repositories. Verify reads the final message from any agent. Review ships rules for JavaScript and TypeScript, and you can add rules of your own.",
    visual: { kind: "mockup", id: "agent-verify", state: {} },
    alt: "Illustration: asked whether it pushed, an agent checks its own claim, finds local commits, and corrects itself.",
  },
  {
    id: "reuse",
    part: "vision",
    headline: "Decisions you can reuse",
    post: "A Sys1 profile freezes a set of questions so a decision runs the same way next time. ALGAL, a sibling language for agent programs, keeps whole procedures once they prove themselves. Both call the same Jev decision API.",
    visual: { kind: "clip", scene: "profiles" },
    alt: "A frame from the launch film listing reusable decision profiles: failure triage, excerpt relevance and claim support.",
    detailHref: "https://algal.computer",
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
    headline: "Open source, with the risky parts off by default",
    post: "Sys1 is open source under MIT. Install it from GitHub with Bun and add a skill with one setup command. Hosted Jev stays off until you turn it on, and review and verify are experimental. {status}.",
    socialPost: "Sys1 is open source under MIT. Install it from GitHub with Bun and add a skill with one setup command. Hosted Jev stays off until you turn it on. {status}.",
    visual: { kind: "mockup", id: "install", state: {} },
    alt: "Illustration: two setup commands write the review and verify skills into a project without calling a model.",
    facts: ["status"],
    detailHref: "/docs#getting-started",
  },
];

export const launchFactsWithStatus = { ...launchFacts, status: { value: launchRelease.status, source: "package.json version via the release workflow" } };

export const resolvedBeats = resolveLaunchBeats(launchBeats, launchFactsWithStatus, { allowNumerals: ["Sys1", "sys1"] });
