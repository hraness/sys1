import { writeProjectFile, ProjectFileError } from "./project-files.ts";

/** Embedded so the exact packaged CLI always installs its matching instructions. */
export const REVIEW_SKILL = `---
name: sys1-review
description: Review a coherent batch of Git changes with Sys1's advisory rules, investigate candidates, record feedback, and recheck. Use when Sys1 review is requested or this repository has adopted it as a checkpoint. It supplements the repository's tests and human or agent review.
---

# Sys1 review

Use the repository's configured rule packs and exact backend/model route.
Read \`sys1 review --help\` and \`sys1 rules --help\` for the installed version.
Choose rules that match the change and the repository's languages. Bundled
rules have path scopes; inspect active rules and skipped coverage instead of
assuming every language is covered. Select actual task-owned files or
directories; repositories need not have \`src\` or \`test\` folders.
Hosted Jev (TypeSafe's hosted decision model) needs explicit activation and
receives selected source diff context. Local models are experimental.
Installing this skill configures neither a backend nor automatic hooks.

After a coherent edit and test batch, preview the intended files:

\`\`\`sh
sys1 review checkpoint --worktree --model <backend/model> --dry-run --json -- <paths>
\`\`\`

Choose \`--staged\` for index contents, \`--since <ref>\` for committed changes,
or \`--worktree\` for current files (including untracked files). Inspect the
reported paths, skipped evidence, and request count. Keep the selected paths
within the user's task. With source transmission authorized, repeat without
\`--dry-run\`, retaining an explicit request cap, for example
\`--max-requests 10 --timeout-ms 60000\`. Use \`--gateway\` for a running local
model. An unchanged complete batch can reuse a recent review without new calls.

To run chosen checks, find active IDs with \`sys1 rules list --json\` and add
\`--rule <id>\` for each one. Omitting \`--rule\` uses all active rules. Unknown
IDs fail before model calls; drafts stay inactive. Keep the same selected
rules and paths between preview and evaluation, and inspect skipped evidence.

Investigate each new candidate in the actual code and tests. Scores rank
candidates; they are not calibrated probabilities. Read the rule and the
before/after evidence. Check callers or surrounding code when needed, and
explain why the finding is supported, incorrect, or not yet verifiable.
Never change code merely to silence a candidate.

\`\`\`sh
sys1 review issues --json
sys1 review feedback <finding-id> useful --json
sys1 review feedback <finding-id> incorrect --json
sys1 review feedback <finding-id> unverifiable --json
sys1 review recheck <finding-id> --model <backend/model> --json
\`\`\`

Choose one feedback outcome after investigation. Feedback is an explicit
judgment, not proof of model accuracy. Recheck reruns the original evidence
when available; changed or missing evidence is superseded or unavailable,
never automatically fixed. Recheck uses the finding's original rule and does
not accept \`--rule\`. After a repair, run the relevant tests and a fresh
checkpoint on the repaired batch. Inspect incomplete coverage and exit 8;
zero new candidates or suppressed repeats do not prove correctness.

State in SYS1_HOME stores only review metadata and explicit feedback. It does
not store source, raw answers, rule prose, model scores, or freeform notes.
The ordinary \`sys1 audit\` command remains stateless.

Before reporting completion, check your final message against reachable
evidence (experimental). Save the message in a temporary file outside the Git
worktree so it does not appear as unfinished work:

\`\`\`sh
sys1 verify --message <final-message-file> --model <backend/model> --dry-run --json
sys1 verify --message <final-message-file> --model <backend/model> --url <live-url>
\`\`\`

Any agent can pipe the final message with
\`sys1 verify --message - --model <backend/model>\`. Plain message input
has no command transcript, so check-result claims stay unverifiable.
Without \`--message\`, Sys1 selects the newest Devin session for this
directory or an ancestor; it may select another task, not the current session.
Preview before authorizing message and page transmission to the selected
backend. Install the standalone instructions with \`sys1 verify setup\` and
your agent's target. Claims such as deployed, merged, committed, and
checks passed are compared with the worktree, linked pull requests, and fetched
pages. Exit 7 means a claim contradicted reachable evidence; unverifiable
evidence is never a contradiction. Fix the claim or the work, then rerun.

To turn a repository convention into a rule, first find a concrete violation
and a clean counterexample. Use \`sys1 rules draft\` with a narrow path,
explicit ensure/breaks sentences, and the guide's source path. Drafts live
outside the active rules directory. Validate with \`sys1 rules check\`, review
the prose and examples, then explicitly move the reviewed pack into
\`.sys1/rules/<name>/\`. Prefer an existing deterministic check when it covers
the mistake. Do not treat a single successful example as qualification.

Useful rule topics across languages include checking resource ownership before
a write, completing durable storage before reporting success, preserving the
ordering of externally visible events, and keeping error responses free of
private input. Adopt only conventions supported by this repository's guides.
For each rule, name the affected operation and choose paths that exist here;
avoid vague instructions to produce clean or secure code. Cover a real
violation and a plausible correct implementation in the repository's language.
`;

export async function installReviewSkill(options: { repoRoot: string; target: string; dryRun?: boolean }) {
  const roots: Record<string, string> = { codex: ".agents", "claude-code": ".claude", devin: ".devin" };
  const directory = Object.hasOwn(roots, options.target) ? roots[options.target] : undefined;
  if (directory === undefined) throw new ProjectFileError("Choose setup codex, claude-code, or devin");
  const path = `${directory}/skills/sys1-review/SKILL.md`;
  const status = await writeProjectFile(options.repoRoot, path, REVIEW_SKILL, options.dryRun ?? false);
  return { version: 1 as const, advisory: true as const, command: "setup" as const, target: options.target, path, status };
}
