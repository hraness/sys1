import { writeProjectFile, ProjectFileError } from "../review/project-files.ts";

/** Embedded so the packaged CLI installs instructions for its own behavior. */
export const VERIFY_SKILL = `---
name: sys1-verify
description: Check a coding agent's completion message against Git state, linked pull requests, and reachable live pages with Sys1. Use when verification is requested or the repository has adopted a final-message checkpoint. Results are experimental and advisory.
---

# Sys1 verify

Use this before reporting completed work, after running the repository's
required checks. Read \`sys1 verify --help\` for the installed version.
Installation creates only this project skill; it does not enable a model,
configure hooks, or authorize sending private content to a service.

Select the intended completion message explicitly in any agent, including
Codex, Claude Code, and Devin. Save it in a temporary file outside the Git
worktree, so it does not appear as unfinished work, and preview:

\`\`\`sh
sys1 verify --message <final-message-file> --model <backend/model> --dry-run --json
\`\`\`

Alternatively pipe the message to
\`sys1 verify --message - --model <backend/model> --dry-run --json\`.
Dry-run reads the message and local Git state; it makes no model calls,
fetches no pages or pull requests, and does not persist the message.
Inspect which message and repository you selected before evaluating.

Keep the same message and exact route when removing \`--dry-run\`. Hosted
Jev requires explicit activation and receives message text and fetched page
excerpts; confirm that transmission is authorized. Local models are
experimental and need a running gateway plus \`--gateway\`.

\`\`\`sh
sys1 verify --message <final-message-file> --model <backend/model> --timeout-ms 30000 --json
\`\`\`

Add \`--url <live-url>\` for the page a deployment claim concerns. Use only
task-relevant URLs. Each evaluation makes one claim request and at most four
page judgments; \`--timeout-ms\` limits each model call, not the whole command.
Message input is capped at 64 KiB; the model sees its final 8,192 characters. Put the
completion claims there. Sys1 does not retain the message or page text.

Without \`--message\`, Sys1 reads the newest Devin session whose working
directory is this directory or an ancestor. That can select another task and
does not identify the current session. It uses that session's last assistant
message and available check-command results. Prefer explicit input when
multiple sessions share a directory or when checking a draft message.
Files and stdin provide no command transcript, so \`checks_passed\` is
unverifiable with these inputs. Compare check results independently; do not
interpret message text as execution evidence.

Read each verdict and its evidence. Git state may include other work, and a
clean tree alone does not establish task completion. A fetched page may not
expose client-rendered or signed-in content. Scores are model judgments, not
calibrated confidence. Investigate contradictions and correct the work or
the message, then rerun only when the evidence or claim changed.

Exit 7 reports a contradiction; exit 8 reports an incomplete evaluation.
Exit 0 includes unverifiable and unclaimed results and is not proof that the
work is correct. Keep required tests, deployment checks, and independent
review in place. Report missing evidence precisely rather than weakening the
claim to make a check pass.
`;

export async function installVerifySkill(options: { repoRoot: string; target: string; dryRun?: boolean }) {
  const roots: Record<string, string> = { codex: ".agents", "claude-code": ".claude", devin: ".devin" };
  const directory = Object.hasOwn(roots, options.target) ? roots[options.target] : undefined;
  if (directory === undefined) throw new ProjectFileError("Choose setup codex, claude-code, or devin");
  const path = `${directory}/skills/sys1-verify/SKILL.md`;
  const status = await writeProjectFile(options.repoRoot, path, VERIFY_SKILL, options.dryRun ?? false);
  return { version: 1 as const, advisory: true as const, command: "setup" as const, target: options.target, path, status };
}
