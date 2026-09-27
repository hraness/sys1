# Context and question experiment

Narrow questions caught two of three previously missed defects. Adding complete
files to the original rules caught none and used 2.14 times the input tokens.
These are known discovery cases whose defects informed the questions. The result
supports trying focused requirements in an advisory workflow; it does not
establish accuracy on new defects.

## Recorded run

The experiment used `typesafe/jev-1.13.0` on 2026-09-27, with 24 requests and no
retries. All 24 completed. The route, request identities, question wording, source
hashes, and thresholds were frozen before inference. The medium threshold stayed
at 0.8 and the high threshold at 0.9.

Each variant reviewed the same three defective snapshots and their three repaired
controls from the [public discovery corpus](../../reviewer/README.md). No held-out
examples were read. Each pair represents one defect family, so the observations
are correlated.

| Variant | Target defects found | Alerts on repaired controls | Questions per request | Input tokens | Output tokens | Median request time | Maximum request time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Original rules, original window | 0/3 | 0/3 | 4 | 14,164 | 504 | 211.5 ms | 451 ms |
| Specific requirement, original window | 2/3 | 0/3 | 1 | 7,362 | 120 | 212.5 ms | 237 ms |
| Original rules, complete supporting files | 0/3 | 0/3 | 4 | 30,342 | 504 | 220 ms | 248 ms |
| Proposed claim, original window | 1/3 | 0/3 | 1 | 7,406 | 261 | 217 ms | 247 ms |

Totals: 59,274 input tokens, 1,389 output tokens, 24 upstream inference dispatches,
and 5.5 seconds for the run. These are token counts, not a dollar-cost estimate.
Request times include the embedded router and live provider request. Variants ran
in the table's order, so this is not a controlled latency comparison.

## Individual scores

For the first three columns, the score is `1 - noul`: the model's reported support
for a rule violation. The claim column is the reported support for the proposed
failure claim. These are different questions and uncalibrated scores, not measured
probabilities of defects. An alert requires a score of at least 0.8.

| Discovery case | Original window | Specific requirement | Complete supporting files | Proposed claim |
| --- | ---: | ---: | ---: | ---: |
| Ghostget login before repair | 0.54 | **0.96** | 0.47 | 0.37 |
| Ghostget login after repair | 0.06 | 0.03 | 0.06 | 0.00 |
| Design-kit forced theme before repair | 0.73 | **0.94** | 0.59 | **0.99** |
| Design-kit forced theme after repair | 0.14 | 0.05 | 0.12 | 0.00 |
| Design-kit label activation before repair | 0.60 | 0.72 | 0.62 | 0.16 |
| Design-kit label activation after repair | 0.16 | 0.34 | 0.15 | 0.13 |

The specific requirements name the relevant operation or component and state its
expected behavior. For example, the forced-theme requirement follows
`PortalThemeBridge` with `forcedTheme=dark` and `resolvedTheme=light`. Its expected
result is `dark`. The login requirement asks whether refresh-token storage
finishes before sign-in success is reported. The label requirement spells out
the pointer, temporary focus, and native activation sequence.

The claim variant asks the model to classify a proposed failure as `supported`,
`refuted`, or `insufficient`. On the defective login case it assigned 0.42 to
insufficient evidence; on the defective label case it assigned 0.44. An explicit
hypothesis did not make these checks reliable. The recorded claim distributions
are in [results.json](results.json).

## What changed between variants

The original requests exactly reproduce the six corresponding request identities
in the [previous report](../../reviewer/natural-results.json), including all four
candidate rules. The specific and claim variants each ask one question. Their
comparison changes both wording and batch size; this experiment does not isolate
an effect from selecting a single rule alone.

The context variant retains the original replayed diff and supplies complete
files from that same selected commit. It changes the instruction prefix to make
those files supporting evidence and to restrict findings to the selected change.
For the repaired forced-theme case, it includes the visible helper file as well.
The largest serialized state was 15,833 bytes. No caller graph was collected.

The corpus represents selected historical source windows as added code. These are
not the original bug-introducing diffs. Complete target-side files were available,
but authentic original before-file context was not supplied. This experiment
does not test a real two-sided repair diff, coherent cross-file caller context,
or an enclosing-function collector in the product.

Only the target rule's score was retained from the four-question batches.
Consequently, the zero-alert counts concern the target checks only: non-target
false alerts and total reviewer workload cannot be reconstructed. Repairs can
also contain explanatory comments that make them easier to classify. Three
repaired controls do not establish a useful false-positive rate.

## Reproduce the requests without inference

Use Bun 1.3.14, Git with `--no-lazy-fetch` support, and local public checkouts
containing the exact commits and blobs listed in [freeze.json](freeze.json):

```sh
bun benchmarks/reviewer-next/context/reproduce.ts /path/to/ghostget /path/to/design-kit
```

The script makes no network or model calls and writes no files. It verifies seven
complete Git blobs, reconstructs all 24 requests, checks their state, question,
and request hashes, and reconciles the result identities. It uses the existing
versioned discovery corpus and rule pack; it does not select current worktree
contents. Question definitions are visible in [reproduce.ts](reproduce.ts).

[Public provenance](public-provenance.json) records unauthenticated retrieval of
all seven immutable GitHub source blobs and the original rule pack. All six
replayed diffs were reconstructed byte for byte from the public downloads.
Source licenses are preserved in the discovery corpus's
[third-party notices](../../reviewer/THIRD_PARTY_NOTICES.md). This directory adds
no copies of those source files.

The original execution used an isolated embedded router with hosted mode enabled
for this run, no local backend, an exact route, a 24-dispatch transport cap, a
24-request runner cap, a one-shot run marker, 20-second request deadlines, and a
10-minute overall deadline. Model-list metadata was supplied locally for the
pinned route; all inference requests went to the live provider. Each response
had to identify `jev-1.13.0`, the `typesafe` backend, and one attempt. Credentials
were provided only through the child process environment.

The unchanged frozen and numerical records retain the original execution
harness's hash. The portable validator omits machine-specific paths, credentials,
and live execution, so its source bytes have a different hash. It verifies exact
request content, not equivalence of execution environments or fresh model
predictions.

## Next useful step

Let an implementing agent select one relevant, narrowly written requirement for
a coherent edit batch. Keep the result advisory and have the agent inspect the
shown evidence. Measure independently labeled new changes before promoting the
requirement or claiming an accuracy improvement. A rule selector is useful for
choosing relevant checks and controlling spend; its standalone accuracy effect
was not measured here.

These cases do not justify adding a call graph, sending entire repositories, or
enabling automatic whole-file context. The label-activation miss still calls for
browser behavior tests and stronger review. Choosing the right evidence and
question for an actual failure remains part of the work.
