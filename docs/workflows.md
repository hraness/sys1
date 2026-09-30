# Save checks and continue reviews

Sys1 can run a repository check, save its result, and optionally review the
changes after it passes. A saved run lets you inspect what finished and continue
a paused review without repeating its check.

Install [Sys1](../README.md#install) and run these commands from a Git worktree
on macOS or Linux. Check-only workflows need no model, account, or API key.

## Save a check result

Use the check command required by your repository. For a Bun project:

```sh
sys1 workflow check -- bun test
```

Everything after `--` is the command and its arguments. Sys1 runs it once,
reports its exit status, and saves its output in a private local log. Shell
syntax such as pipes requires an explicit shell command. Keep any scheduler
or wrapper required by the repository in the command you pass.

The result includes a run ID. List saved runs with:

```sh
sys1 workflow list
```

Use a printed ID with `sys1 workflow show <id>` to inspect that run. Add
`--json` before the command separator for structured output. Child output goes
to the log, so it cannot corrupt the JSON result.

Checks have a five-minute default timeout. Set `--timeout-ms` before `--` to
allow up to fifteen minutes. A check failure prevents the optional review.

## Check, then review

First [configure a backend](../README.md#add-hosted-jev). Review remains
experimental and advisory: investigate candidates and keep the repository’s
normal tests and review.

Preview a staged-change workflow:

```sh
sys1 workflow review --staged --model typesafe/jev-1.13.0 \
  --max-requests 10 --dry-run -- bun test
```

The preview reports the selected repository, route, and limits without running
the command, saving a run, or calling a model. Inspect the selected changes with
Git and use `sys1 review checkpoint --dry-run` for the detailed review preview.
Remove `--dry-run` to run the workflow. Selected source and diff context go to
the configured backend; hosted usage is billed by its provider.

Choose `--worktree` for working changes or `--since` with a Git revision for a
committed comparison. Use repeated `--path` options to restrict the review;
a workflow accepts up to 100 path selectors. The model route and request limit
are required. `--review-timeout-ms` controls the model-call timeout separately
from the check timeout.

Sys1 collects the exact selected changes and uses the same rules, candidate
history, and feedback as [`sys1 review checkpoint`](review.md). Complete,
unchanged review batches can reuse the existing review result. The workflow
reports the model calls it made and links candidates to their files and rules.

## Continue a paused review

Add `--pause-after-check` to a review workflow to inspect the check before
allowing its review:

```sh
sys1 workflow review --staged --model typesafe/jev-1.13.0 \
  --max-requests 10 --pause-after-check -- bun test
```

Continue with `sys1 workflow resume <id> -- bun test`, using the printed run ID
and the same command. Sys1 checks the saved inputs before continuing. Changed
project files, execution environment, executable, rules, or configuration require
a new run. A paused run can be resumed for up to one hour. A command that changes
tracked or unignored project files also requires a fresh run after those changes
are ready.

The input check covers tracked and unignored files, including file contents
reached through links inside the repository. Links outside the repository,
submodules, and special files are unsupported. Sys1 also compares executable
contents, permissions, and runtime versions, and normalizes session-specific
environment values. It does not capture external dependencies or every input
that an arbitrary command might read.

If a command or model call was interrupted with an unknown outcome, inspect
its effects before starting a new run. Sys1 will not silently repeat that step.
Command arguments stay out of the execution record; supply the original command
again when resuming. The selected review and its limits come from the saved run.

A saved check is historical evidence. Run fresh required checks before merging,
releasing, or deploying, even when the saved run still matches your files.

## Inspect saved data

`sys1 workflow show <id>` displays the check, review status, and log location.
`sys1 workflow verify <id>` checks the consistency of the stored execution
record. This record is useful when an agent hands a task to another session.

State lives under the Sys1 home directory (`~/.sys1` by default, or
`SYS1_HOME`). Workflow records store identities, limits, statuses, and candidate
references. Model request and response bodies, rule prose, scores, credentials,
and command arguments stay out of those records.

Command logs contain what the command prints, including any source, arguments,
or credentials it prints. They are separate private files with a four-MiB limit.
Inspect a log before sharing it. Logs become eligible for deletion after seven
days and are removed when you next start a workflow. Inspection and resume do
not delete them. The result reports truncated output and the retention date.

The workflow engine is [ALGAL](https://github.com/hraness/algal), included in the
Sys1 installation. Sys1 supplies the check and review steps, input checks, and
model routing; ALGAL keeps their execution order and journal. Workflow commands
are currently available on macOS and Linux. Other Sys1 commands retain their
documented platform support.
