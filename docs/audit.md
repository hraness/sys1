# Review changes with reusable rules

`sys1 audit` gives a second opinion on a Git diff. It is experimental: each
reported item is a candidate to inspect, and its model score is not a calibrated
probability of a defect. Run your normal tests and review alongside it.

## Preview and run

Choose an explicit backend and model. For hosted Jev, provide
`TYPESAFE_API_KEY` in the environment and run `sys1 jev enable`. Enabling hosted
Jev selects the hosted-only routing policy. The audit command sends changed
source and nearby context to that configured backend.

First preview the files, rules, skipped evidence, and number of requests:

```sh
sys1 audit --staged --model typesafe/jev-1.13.0 --dry-run --json
```

Then run the same review with a request cap:

```sh
sys1 audit --staged --model typesafe/jev-1.13.0 --max-requests 20 --json
```

Use `--worktree` for tracked and nonignored untracked changes against `HEAD`.
Use `--since <ref>` for committed changes between the resolved ref and `HEAD`;
it does not include local edits. Staged review reads the index even when the
working file contains different changes. Removed lines and deleted files are
included. To select exact files or directory prefixes, put them after `--`:

```sh
sys1 audit --worktree --model typesafe/jev-1.13.0 -- src test
```

For an already installed local model, start `sys1 up` and add `--gateway` with
its exact `local-<id>/<id>` route. HTTP backends registered with
`sys1 backend add` also accept explicit routes. The configured routing policy
still applies. Audit never starts a daemon or downloads or loads weights itself.

## Read the report

JSON includes `status`, `complete`, `targets`, `rules`, `requests`, `usage`,
`findings`, and `skipped`. Findings contain a rule revision, path, line, before
or after side, score, and stable identifier. A before-side location refers to
removed text. Inspect the whole diff hunk; the location marks its start, not a
model-selected defect span.

Token totals cover validated responses. `usage.unknown_requests` counts attempts
whose usage could not be confirmed, so an incomplete run may have additional
provider charges.

`complete` means all selected evidence was evaluated by the applicable rules.
It does not mean the changes are correct. `qualification: "unqualified"` means
the rules have no production-quality guarantee for that route. The high and
medium tiers are score cutoffs, not severity or measured precision.

Exit 0 means the audit completed or a preview was produced, including when
there are advisory findings. Exit 8 means coverage was incomplete. Check
`skipped` for excluded paths, unsupported inputs, missing rules, limits, or a
backend error. Existing usage and configuration errors keep their exit codes.

Each invocation allows at most 20 model requests by default (`--max-requests`,
1–200) and 30 seconds of model-call time (`--timeout-ms`, 1–120000). There are no
model retries. A failure stops subsequent requests. A unit that exceeds the
remaining budget is reported as skipped.

## Add repository rules

Put a pack in `.sys1/rules/<name>/pack.yaml` and commit it with the repository:

```yaml
version: 1
pack: request-errors
revision: 1
description: Keep changed request errors observable.
rules:
  - id: request-errors-observable
    applies:
      paths: ["src/**/*.ts"]
    ensure: Added request error handlers report or rethrow the error.
    breaks: An added request error handler silently discards the error.
```

Rules load from bundled packs, then `$SYS1_HOME/rules`, then the repository.
A later definition replaces the same rule id. Pack parsing is strict; invalid
fields fail before model calls. `ensure` requires a `breaks` sentence explaining
the violation. Choice and score rules can name violating options or levels.
At most 256 distinct rules can remain after overrides.
Conditional rules and whole-file review are not part of this first audit flow.

Keep each rule answerable from the changed lines and nearby context. Put the
whole condition in one question. Use a deterministic linter when one already
checks the behavior reliably.

## Privacy and limits

Audit does not save source, answers, findings, or a persistent cache. The
provider receives each selected diff, including before text and surrounding
context. Sensitive filenames, generated outputs, binaries, symlinks, and
oversized evidence are skipped. Filename exclusions are not a secret scanner;
inspect the source and preview before using a hosted model.

The command does not install hooks, change files, or gate edits. It evaluates
only visible diff evidence. Architecture, external callers, and authorization
rules may need context outside a hunk. Source comments and strings are treated
as data in the questions, but adversarial text can still affect model answers.

## Evaluate a rule

The source repository includes an opt-in benchmark script. It reads a pack's
calibration or held-out fixtures, enforces a request cap, and reports confusion
counts, uncertainty intervals, latency, and token usage. It never promotes a
rule automatically.

```sh
bun scripts/audit-benchmark.ts --pack packs/core --route typesafe/jev-1.13.0 \
  --split calibration --max-requests 100 --timeout-ms 120000
```

Tune on calibration examples, freeze the rule wording and cutoffs, then run a
separate held-out set once. Report precision together with prediction support,
recall, false positives, and misses. Balanced authored fixtures do not establish
precision on everyday changes where defects are rare. Test natural changes
from the repositories where you intend to use the rules before automating them.

The [September 2026 evaluation](audit-evaluation-2026-09-27.md) reports the
bundled rules' held-out results and replay on two public repository changes,
including the empty-catch rule's low recall.
