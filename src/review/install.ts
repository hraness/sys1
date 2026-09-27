import { writeProjectFile, ProjectFileError } from "./project-files.ts";

/** Embedded so the exact packaged CLI always installs its matching instructions. */
export const REVIEW_SKILL = `---
name: sys1-review
description: Review a coherent batch of Git changes with Sys1's advisory rules, investigate candidates, record feedback, and recheck. Use when Sys1 review is requested or this repository has adopted it as a checkpoint. It supplements the repository's tests and human or agent review.
---

# Sys1 review

Use the repository's configured rule packs and exact backend/model route.
Read \`sys1 review --help\` and \`sys1 rules --help\` for the installed version.
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
never automatically fixed. After a repair, run the relevant tests and a fresh
checkpoint on the repaired batch. Inspect incomplete coverage and exit 8;
zero new candidates or suppressed repeats do not prove correctness.

State in SYS1_HOME stores only review metadata and explicit feedback. It does
not store source, raw answers, rule prose, model scores, or freeform notes.
The ordinary \`sys1 audit\` command remains stateless.

To turn a repository convention into a rule, first find a concrete violation
and a clean counterexample. Use \`sys1 rules draft\` with a narrow path,
explicit ensure/breaks sentences, and the guide's source path. Drafts live
outside the active rules directory. Validate with \`sys1 rules check\`, review
the prose and examples, then explicitly move the reviewed pack into
\`.sys1/rules/<name>/\`. Prefer an existing deterministic check when it covers
the mistake. Do not treat a single successful example as qualification.
`;

export async function installReviewSkill(options: { repoRoot: string; target: string; dryRun?: boolean }) {
  const roots: Record<string, string> = { codex: ".agents", "claude-code": ".claude" };
  const directory = Object.hasOwn(roots, options.target) ? roots[options.target] : undefined;
  if (directory === undefined) throw new ProjectFileError("Choose setup codex or claude-code");
  const path = `${directory}/skills/sys1-review/SKILL.md`;
  const status = await writeProjectFile(options.repoRoot, path, REVIEW_SKILL, options.dryRun ?? false);
  return { version: 1 as const, advisory: true as const, command: "setup" as const, target: options.target, path, status };
}
