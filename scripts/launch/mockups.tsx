import { AgentSession, BrowserFrame, TerminalFrame, type AgentTurn, type TerminalLine } from "@hraness/design-kit/mockups";
import type { ReactElement } from "react";
import { launchFacts } from "./facts.ts";

// Code-built illustrations of Sys1's real surfaces. Every command is one the
// release ships; every output line follows the formats in src/verify/cli.ts,
// docs/verify.md and docs/review.md. Accounts, repositories and paths are
// made up. Agent and code-host chrome is neutral and unbranded.

const MODEL = "typesafe/jev-1.13.0";

export const compactLines: readonly TerminalLine[] = [
  { kind: "comment", text: "The agent runs a noisy check through the system-one-verify skill" },
  { kind: "input", text: "bun run check" },
  { kind: "output", text: "exit 1 · failed", tone: "error", beat: "result" },
  { kind: "output", text: "test/cart.test.ts › applies the member discount", tone: "error" },
  { kind: "output", text: "  expected 18.00, received 20.00" },
  { kind: "output", text: "118,402 bytes left out · full log saved on disk", tone: "muted", beat: "log" },
];

export const verifyLines: readonly TerminalLine[] = [
  { kind: "input", text: `sys1 verify --message /tmp/final-message.txt --model ${MODEL}` },
  { kind: "output", text: "Verify complete: 1 contradiction, 2 requests.", beat: "summary" },
  { kind: "output", text: "[contradicted] merged_or_pushed p=0.97", tone: "error", beat: "contradiction" },
  { kind: "output", text: "    2 commits are ahead of origin/main", tone: "muted" },
  { kind: "output", text: "[confirmed] committed p=0.95", tone: "ok" },
  { kind: "output", text: "[unverifiable] checks_passed p=0.88", tone: "warn" },
  { kind: "output", text: "    no check-like command ran in the final turn", tone: "muted" },
];

export const decisionLines: readonly TerminalLine[] = [
  { kind: "comment", text: "One small question, answered with probabilities" },
  { kind: "input", text: "bun run triage.ts" },
  { kind: "output", text: 'state     "The build failed after a dependency upgrade."' },
  { kind: "output", text: 'question  action: choice of "repair" or "continue"' },
  { kind: "output", text: 'answer    "choice": "repair"  p=0.91', tone: "ok", beat: "answer" },
  { kind: "output", text: `backend   ${MODEL}`, tone: "muted" },
];

export const installLines: readonly TerminalLine[] = [
  { kind: "comment", text: "Add the skills to a project for your agent" },
  { kind: "input", text: "sys1 review setup codex" },
  { kind: "output", text: "Review skill created: .agents/skills/sys1-review/SKILL.md", tone: "ok" },
  { kind: "input", text: "sys1 verify setup claude-code" },
  { kind: "output", text: "Verify skill created: .claude/skills/sys1-verify/SKILL.md", tone: "ok" },
  { kind: "comment", text: "Setup writes instructions only: no hooks, no model calls" },
];

export const reviewTurns: readonly AgentTurn[] = [
  { role: "user", text: "Add input validation to the orders endpoint, then tell me when it's done." },
  { role: "agent", text: "Done with the change. Before I report back, I'll run a review checkpoint on the files I touched." },
  {
    role: "tool",
    tool: "Run sys1-review",
    text: `sys1 review checkpoint --worktree --model ${MODEL} --max-requests 10 -- src`,
    status: "ok",
    beat: "checkpoint",
  },
  {
    role: "tool",
    tool: "Finding · advisory",
    text: "core-new-empty-catch · src/orders/parse.ts:42 · a new catch block swallows the error",
    status: "warn",
    beat: "finding",
  },
  { role: "agent", text: "That one is real: the catch hid a parse failure. I fixed it, reran the tests, and marked the finding useful." },
];

export const verifyTurns: readonly AgentTurn[] = [
  { role: "user", text: "Did you push the fix?" },
  { role: "agent", text: "Let me check my own message against the repository before I answer." },
  { role: "tool", tool: "Run sys1-verify", text: "[contradicted] merged_or_pushed · 2 commits are ahead of origin/main", status: "error", beat: "contradiction" },
  { role: "agent", text: "Not yet. My summary said pushed, but two commits are still local. Pushing now." },
];

function PrComment(): ReactElement {
  return (
    <div className="launch-mock-pr">
      <p className="launch-mock-pr-head"><strong>fix(orders): validate the request body</strong> <span>#128 · jmoreno wants to merge 3 commits</span></p>
      <div className="launch-mock-pr-comment">
        <p className="launch-mock-pr-author"><strong>review-bot</strong> <span>commented · advisory</span></p>
        <p>Sys1 review checked 4 changed files against 2 repository rules.</p>
        <ul>
          <li><code>core-new-empty-catch</code> <span>src/orders/parse.ts:42</span> A new catch block swallows the error.</li>
          <li><code>core-removed-test-assertions</code> <span>no findings</span></li>
        </ul>
        <p className="launch-mock-pr-note">Scores rank candidates. Investigate before acting; keep your tests and review.</p>
      </div>
    </div>
  );
}

export type LaunchMockupId = "agent-review" | "compact" | "verify" | "pr-comment" | "decision" | "agent-verify" | "install";

export function LaunchMockup({ id }: Readonly<{ id: LaunchMockupId }>): ReactElement {
  switch (id) {
    case "agent-review":
      return <AgentSession agent="generic-cli" describe="Illustration: a coding agent runs the sys1-review skill on the files it changed, gets one advisory finding, and fixes it." title="Coding agent · ~/code/orders-api" turns={reviewTurns} />;
    case "compact":
      return <TerminalFrame describe={`Illustration: a failing check returns its exit status and a short excerpt while the full log stays on disk. In the study, results were ${launchFacts.reduction.value} shorter.`} lines={compactLines} title="orders-api — check" />;
    case "verify":
      return <TerminalFrame describe="Illustration: sys1 verify reports that a message claiming a push is contradicted because two commits are still local." lines={verifyLines} title="orders-api — sys1 verify" />;
    case "pr-comment":
      return <BrowserFrame describe="Illustration: an advisory review comment on a made-up pull request lists one finding from a repository rule." url="code.example/jmoreno/orders-api/pull/128"><PrComment /></BrowserFrame>;
    case "decision":
      return <TerminalFrame describe="Illustration: an application asks one choice question and gets back a named answer with its probability." lines={decisionLines} title="triage.ts" />;
    case "agent-verify":
      return <AgentSession agent="generic-chat" describe="Illustration: asked whether it pushed, an agent checks its own claim, finds two local commits, and corrects itself." title="Assistant" turns={verifyTurns} />;
    case "install":
      return <TerminalFrame describe="Illustration: two setup commands write the review and verify skills into a project; setup makes no model calls." lines={installLines} title="orders-api — setup" />;
  }
}
