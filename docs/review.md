# Review changes with your agent

Use `sys1 review` to check a batch of changes against repository rules. It
keeps the selected paths, findings, and feedback together so your agent can
investigate candidates and reuse an unchanged review. This workflow is experimental and
advisory. Its scores rank candidates; they are not calibrated probabilities of
a defect. Keep the repository's normal tests and review.

The project skill supplies the workflow; rule packs supply the checks. You can
use the same workflow across Git repositories and coding agents, while each
repository selects rules for its own code and conventions. The bundled pack
checks newly empty catch blocks and removed test assertions in JavaScript and
TypeScript. It does not provide general review coverage for every language.

Start with [Sys1 installed](../README.md#install) and run these commands inside
a Git worktree. Skill setup and checkpoint previews need no model. For a live
review, choose an enabled backend and its exact model. For Cloudflare Clef, provide
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the environment and run `sys1 clef enable`. Selected source
and surrounding diff context go to that backend. Inspect the files and preview
before sending them. [Audit privacy and limits](audit.md#privacy-and-limits)
explain exclusions and the limits of hunk context.

## Install the project skill

Preview the destination, then install the instructions for your agent:

```sh
sys1 review setup codex --dry-run --json
sys1 review setup codex --json
```

Codex receives `.agents/skills/sys1-review/SKILL.md`. For Claude Code, run
`sys1 review setup claude-code`; its path is
`.claude/skills/sys1-review/SKILL.md`. For Devin, run
`sys1 review setup devin`; its path is `.devin/skills/sys1-review/SKILL.md`.
Repeating setup preserves an identical file and refuses to overwrite different
content, including an older Sys1 template. Update existing instructions
through the repository's normal review.
Commit the skill if the repository should share it.

Setup installs instructions only. It does not activate models, add hooks, or
change the repository's required checks. Other agents can use the CLI
directly, following this guide. Review needs a Git worktree and an enabled
model route; it does not need an agent transcript or a particular framework.

## Preview and run a checkpoint

Select the files in your current task, with a request cap and deadline:

```sh
sys1 review checkpoint --worktree --model cloudflare/clef \
  --max-requests 10 --timeout-ms 60000 --dry-run --json -- src test
```

Inspect `audit.targets`, `audit.skipped`, and `audit.planned_requests`. The
preview makes no model calls or metadata writes. Run the same selection when
the source is ready to send:

```sh
sys1 review checkpoint --worktree --model cloudflare/clef \
  --max-requests 10 --timeout-ms 60000 --json -- src test
```

Choose exactly one source mode. `--worktree` compares tracked and nonignored
untracked files with `HEAD`; `--staged` reads the index; `--since <ref>` compares
committed changes from that ref to `HEAD`. Paths after `--` are files or
directory prefixes inside the worktree. Deleted text is included.

The defaults are 20 requests and 30,000 ms of model-call time; the maximums are
200 requests and 120,000 ms. There are no model retries or fallback to a
different route. For an already installed local model, start `sys1 up`, select
its `local-<id>/<id>` route, and add `--gateway`. Local models are experimental.
Checkpoints use the [same rule packs and coverage limits](audit.md) as
`sys1 audit`.

Use `sys1 rules list --json` to find active IDs, then add `--rule` to run a
chosen check:

```sh
sys1 review checkpoint --worktree --model cloudflare/clef \
  --rule core-removed-test-assertions --max-requests 10 --timeout-ms 60000 \
  --dry-run --json -- test
```

Repeat `--rule <id>` to select several rules, up to 256 selections. Omit it to
use all active rules. Unknown or malformed IDs fail with exit 2 before model
calls or metadata writes. Selection does not activate drafts or expand a rule's
file filters. Preserve the chosen rules and paths when running the previewed
batch.

## Investigate and record feedback

Inspect each finding's rule and before/after evidence in the code. Check the
relevant callers and tests when the hunk leaves an important fact uncertain.
Fix a supported defect and run the relevant tests. A code change made in
response to a warning does not establish that the warning was correct.

List recorded candidates and choose one feedback outcome after investigation:

```sh
sys1 review issues --json
sys1 review feedback <finding-id> useful --json
```

Use the ID from the checkpoint or `issues` report. The other outcomes are
`incorrect` and `unverifiable`. Feedback records your judgment and can be
revised. `issues` lists historical observations, including candidates whose
source has since changed; it is not a list of confirmed current defects.

To evaluate a recorded candidate again, keep its original route:

```sh
sys1 review recheck <finding-id> --model cloudflare/clef \
  --max-requests 10 --timeout-ms 60000 --json
```

Recheck makes a fresh evaluation when the original rule and diff evidence are
available. It uses only the finding's original rule and does not accept
`--rule`. It preserves your feedback. After a repair changes that evidence,
run a new checkpoint on the repaired batch, alongside its tests.

| Status | Meaning |
| --- | --- |
| `planned` | Preview only. |
| `complete` | The checkpoint covered its selected evidence. |
| `unchanged` | The same complete batch was checked within 24 hours; no new requests. |
| `reported` / `not_reported` | Recheck did / did not produce a candidate on the original evidence. |
| `incomplete` | Some selected evidence could not be evaluated; inspect `audit.skipped`. |
| `stale` | Source or rules changed during the operation; run a fresh checkpoint. |
| `superseded` | The recorded rule or diff evidence changed. This does not mean fixed. |
| `unavailable` | The finding, source, or original route is unavailable; inspect `reason`. |

Exit 0 includes previews, completed checks, unchanged batches, and advisory
findings. Exit 8 covers `incomplete`, `stale`, `superseded`, and `unavailable`.
Neither an empty report nor `not_reported` proves a fix.

## Check the completion message

After finishing the work, compare the proposed final message with the current
repository and any linked pull requests or live pages. Save the draft outside
the Git worktree so the message itself does not become an uncommitted file:

```sh
sys1 verify --message /tmp/final-message.txt --model cloudflare/clef --json
```

Use a file or `--message -` with any coding agent. Automatic message discovery
and check-command evidence are available for local Devin sessions. The
[verification guide](verify.md) explains the evidence, exit codes, and limits.

## Repeated checks and local data

Complete batches can be reused for up to 24 hours. Changing the selected paths
or rules, source, a selected rule's revision, or route triggers evaluation again.
Reordering or repeating rule IDs has no effect. Changes to unselected rules do
not trigger evaluation. Previously recorded
candidates are suppressed from new checkpoint output regardless of their
feedback. `suppressed_count` reports those repeats; `issues` keeps them
available. Recheck bypasses reuse.

Under `$SYS1_HOME/review` (`~/.sys1/review` by default), each worktree has private
metadata: finding IDs, paths and lines, rule revisions, routes, evidence hashes,
selection, timestamps, and feedback. Sys1 does not persist source, raw answers,
rule prose, scores, or freeform notes there. The command's immediate report can
contain scores and findings.

Each worktree can store up to 2,000 findings and 64 completed batches, subject
to size limits. A full store rejects additional finding metadata instead of
deleting feedback. Use `sys1 audit` when you need a stateless check.

## See how often agents use Sys1

`sys1 usage` reads the local Devin, Claude Code, and Codex transcripts on your
machine and counts `sys1` subcommands, `system-one-skills check` runs, and loads
of Sys1 or System One skills, per agent and per day:

```sh
sys1 usage --days 30 --json
```

It is read-only, makes no model calls, and prints counts only: no prompt text,
command text, paths, or source. Counts come from what agents sent to their
tools, so an agent working on Sys1 itself also adds to them. Devin events are
dated by session start. Combine it with `sys1 review issues` to see whether
the checkpoints that ran produced findings worth keeping.

## Draft a repository rule

Start with a recurring mistake, an actual violation, and a clean counterexample.
Use the repository guide's wording and narrow the file selection. Match the
rule's paths to the code responsible for meeting the requirement, even when
the requirement comes from a different caller or consumer. Confirm that the
checkpoint preview includes the intended code and rule. For a guide
at `docs/auth.md` that requires token persistence before login reports success:

```sh
sys1 rules draft await-success \
  --ensure 'Login waits for required token persistence before reporting success.' \
  --breaks 'Login reports success while required token persistence is still pending or has failed.' \
  --path 'src/auth/**/*.ts' --source docs/auth.md --json
sys1 rules check .sys1/drafts/await-success --json
```

These commands make no model calls. The draft is inactive at
`.sys1/drafts/await-success/pack.yaml`; `check` validates its schema and request
compilation, not its accuracy. Review its wording and
[evaluate examples](audit.md#evaluate-a-rule) before activating it. When
`.sys1/rules/await-success` does not already exist:

```sh
mkdir -p .sys1/rules
mv .sys1/drafts/await-success .sys1/rules/await-success
sys1 rules list --json
```

`list` shows active rules, revisions, sources, and overrides. The repository's
rules load after bundled and user packs; a matching rule ID replaces the
earlier definition. Use a deterministic check when it already covers the
mistake reliably.

## Evidence and example rules

The [contract-based experiment](reviewer-contract-2026-09-27.md) missed its
reproduced defect and flagged two of five control hunks. Investigate every
candidate before treating it as a defect.

The source repository also contains
[four candidate rules and a historical corpus](../benchmarks/reviewer/README.md)
from Sys1, Ghostget, and design-kit. These rules are opt-in research examples
outside the packaged and default packs. The corpus links original commits,
independent label review, and deterministic checks. It is discovery evidence,
not a held-out accuracy estimate. The [dated evaluation](reviewer-evaluation-2026-09-27.md)
reports detections, misses, clean controls, and workflow checks.
The [focused-review follow-up](reviewer-followup-2026-09-27.md) compares specific
requirements with added source context and records the remaining limitations.
The [contract-based experiment](reviewer-contract-2026-09-27.md) tests a rule
written from an existing requirement before its author saw the defect.
