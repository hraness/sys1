# Contract-authored response-finality benchmark

This source experiment contains one historical Sys1 defect and a review rule
written from its pre-repair requirement. The rule was frozen before predictions.
It is an inactive benchmark pack, with no default installation or product gate.

The requirement says that receiving any HTTP response ends the opportunity to
retry another backend. The initial implementation also caught response-body
read failures as transport failures. A deterministic broken response stream
therefore caused two POSTs. The repair returned a definitive 502 response and
made one POST.

## Reproduce offline

Use Bun 1.3.14, Git, this source checkout with its dependencies already installed,
a local Sys1 Git repository containing the five commits in
[manifest.json](manifest.json), and an installed zod 4.6.2 package directory.
No command below installs packages or fetches missing Git objects.

```sh
bun --no-env-file --no-install benchmarks/reviewer-contract/corpus.ts
bun --no-env-file --no-install benchmarks/reviewer-contract/reproduce.ts \
  --repo /path/to/sys1-git \
  --zod /path/to/installed/zod
```

The reproducer copies complete historical `src/` trees into a temporary
directory, checks their Git identities and selected file hashes, and supplies a
private copy of the installed zod package. It checks the package version and
rejects nested symlinks or non-regular package files. It does not run an installer
or package scripts. A partial clone is rejected because it could fetch missing
objects.

Historical code runs in a child process with a temporary home, a restricted
environment, automatic package installation disabled, and native addons disabled.
Every gateway also receives its own temporary home. Provider calls use injected
functions; global Fetch throws. The reproducer starts no listener and runs no
inference. Temporary files are removed when it finishes.

The expected result is 63 passing assertions across five revisions:

| Revisions | Unreadable response body | Gateway POSTs |
| --- | --- | --- |
| Initial implementation and repair parent | `transport`, final HTTP 503 | Two |
| Repair and both ordinary-control revisions | `response`, HTTP 502 `backend_response_unreadable` | One |

All five revisions also produce one POST for successful HTTP 200 and definitive
HTTP 503 responses. The assertions preserve the historical failure before the
repair; they do not assert that every revision is correct.

## Fixtures and rule

[fixtures.jsonl](fixtures.jsonl) includes all six hunks from three authentic
`src/backends.ts` diffs, with 15 lines of context: one introduction hunk, three
repair hunks, and two ordinary-control hunks. Each fixture's state uses the
production collector's JSON metadata and normalized file header. Its hunk text,
including removed lines, is unchanged. The loader reconstructs each original
file diff from the recorded Git header and all its hunks and checks its SHA-256.
The reproducer also compares those hunks with the supplied local Git objects.

The introduction has the `violation` label. The repair and ordinary-control hunks
have `clean` labels for the shown post-change code under this one requirement.
Only repair hunk three contains the forwarding repair; the other two repair
hunks provide coverage of the selected file's diff.

[pack.yaml](pack.yaml) contains the frozen `sys1-http-response-finality` rule.
The criterion asks whether any received HTTP response stays a `response` result,
while `transport` is reserved for failures with no response. Its Noul answer
represents satisfaction of that criterion; violation score is `1 - noul`.
These model scores are uncalibrated.
The experimental medium and high thresholds are 0.8 and 0.9, and `gate` is false.
The manifest records the contract packet, frozen authoring hashes, and original
rule bytes. The published author note removes its private filesystem prefix; its
rendering hash is separate from the original frozen note hash. The rule author
saw only the requirement and API packet until
independent review and freezing had finished. Later implementation work did not
change the authored rule.

## Recorded result

The six requests to `typesafe/jev-1.13.0` completed without retries. The model
missed the introduction defect, with a violation score of 0.03. It flagged repair
hunk two at 0.84 and ordinary-control hunk two at 0.83 under the frozen medium
threshold. Both hunks have a `clean` label for this requirement.

| Frozen threshold | Defect hunks detected | Clean-labeled hunks flagged |
| --- | --- | --- |
| Medium, 0.8 | 0/1 | 2/5 |
| High, 0.9 | 0/1 | 0/5 |

[results.json](results.json) preserves the recorded numeric scores without
rounding. The run reported 9,690 input tokens, 156 output tokens, and 1,558 ms
elapsed. These observations do not support promoting this rule. The rule,
thresholds, and fixtures were not tuned after seeing the result.

Verify the published inputs and result accounting offline:

```sh
bun --no-env-file --no-install benchmarks/reviewer-contract/verify-results.ts
```

The verifier requires the source-file versions recorded in `results.json` and
fails on source drift. It rebuilds the six requests using the production compiler
and checks request, wire-request, state, and question hashes, byte counts, unique
result IDs, threshold flags, and call accounting. It rejects incomplete or
mismatched evidence and makes zero network requests. It checks stored scores for
valid values and consistent flags; provider response bodies are not published,
so it does not independently recompute those scores or rerun inference.

## Sources and limits

The source is the public MIT-licensed [Sys1 repository](https://github.com/hraness/sys1).
The manifest records immutable commit URLs, source-tree identities, file hashes,
and the five anonymous GitHub archive checks that matched 122 source,
requirement, and license records. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
contains the license notice. Source snapshots remain temporary and are not
included in this directory.

The curator chose a contract matching a known historical defect. The question
author was blind to the defect and repair; case selection was not blind. This is
not a wholly independent evaluation on a new repository.

This is one initial-implementation defect from a root commit. It does not show a
regression from a previously working release. The repair commit includes
unrelated changes. Six hunks represent one defect family
and three selected file diffs, not six independent defects or whole-commit
coverage.

The ordinary control adds adapter configuration and preserves the reproduced
behavior, but does not change response classification itself. It tests whether
a review invents a new violation on that change; it is not a challenging
body-parser negative. A `clean` label addresses only the selected requirement.
The recorded predictions describe this one case and its five clean-labeled
hunks. They do not provide a general accuracy estimate.
