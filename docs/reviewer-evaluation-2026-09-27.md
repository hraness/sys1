# Review workflow evaluation, September 27, 2026

Sys1's review workflow completed a live pilot on public historical code from
Sys1, Ghostget, and design-kit. The candidate rules detected one of four labeled
defects and raised no findings on nine clean controls. They remain opt-in
experiments; these measurements do not support automatic intervention.

## Inputs and method

The [corpus](../benchmarks/reviewer/README.md) records public commits, original
source hashes, excerpt windows, rule wording, and repair evidence. An independent
AI reviewer checked the labels before predictions and excluded an ambiguous
Sys1 inference pair. The final set contains 13 units from seven related families:
four violations and nine controls. Most inputs represent historical source
windows as newly added code; three controls are actual unrelated diffs.

These are discovery examples. Rule authors had seen the repairs when writing
the rules. Before/after pairs share context, and some repairs include explanatory
comments. Results therefore describe these selected examples, not expected
accuracy on unseen changes. The report scores only each example's nominated
rule; all four questions were sent together, so it does not measure false alarms
from every rule on every example.

The route was `typesafe/jev-1.13.0`, with question format 2, no retries, and a
13-request cap enforced by both the runner and an isolated gateway. Rules and
cutoffs were frozen before prediction. The medium cutoff was 0.8 and the high
cutoff 0.9. Scores are uncalibrated rankings.

## Results

| Candidate rule | Defects detected at medium or higher | False alarms / clean controls |
| --- | ---: | ---: |
| Required work before success | 0 / 1 | 0 / 4 |
| Validate path components | 1 / 1 | 0 / 1 |
| Explicit override precedence | 0 / 1 | 0 / 2 |
| Preserve native activation | 0 / 1 | 0 / 2 |

No defect reached the high cutoff. The detected case accepted a manifest
filename containing traversal and joined it into a model directory. The model
missed success reported before token persistence, a forced appearance overridden
by the resolved default, and dismissal that interrupts native label activation.
Cutoffs were not lowered after observing those misses.

The 13 requests contained 52 questions and used 34,665 input tokens and 1,092
output tokens. Median request latency was 550 ms; p95 was 701 ms. Total benchmark
time was 7.24 seconds. These are one-run measurements with the hosted route, not
throughput or local-model results. Provider billing was not retrieved; token
usage is recorded instead of inventing a dollar cost.

Machine-readable results: [natural-results.json](../benchmarks/reviewer/natural-results.json).
Frozen fixture SHA-256:
`62f521eba51b83c71e18a7f60471aeaf9d7c9bfc231bbc373da5b5fe96b884f8`.
Frozen pack SHA-256:
`de0a1e0b83c277611c78fac6ee20001ddd0f6a252f6fa141ee2a8fac81992ea8`.

## Deterministic comparisons

The [behavioral reproducer](../benchmarks/reviewer/reproduce.ts) executes original
source excerpts with specified mocks. It demonstrates that the old Sys1 schema
accepts traversal while the repair rejects it, that Ghostget reports success
before a pending or failed save while its repair waits and reports errors, and
that design-kit's repaired computation respects a forced appearance.

Pinned ESLint ran on eight complete historical files, before and after the four
repairs, with zero diagnostics. This uses design-kit's repository configuration;
for Sys1 and Ghostget it is a supplemental comparator because those repositories
had no general ESLint check. It does not establish superiority over type-aware
promise rules, CodeQL, application tests, or human review. The original complete
repository regression suites were not executed. Native activation has reviewed
repair/browser-test evidence but no new browser reproduction in this run.

Commands, source identities, mocks, and limitations are in
[baseline.json](../benchmarks/reviewer/baseline.json).

## CLI workflow pilot

Three disposable Git projects held frozen historical windows from the source
repositories. These were source-window pilots, not installations into active
development repositories. Each used the actual CLI, its matching installed Codex
skill, an isolated metadata directory, and a gateway with a 40-request cap. Only
the family's candidate rule was installed, alongside the bundled core rules.

| Source project | First checkpoint | Unchanged repeat | Repaired checkpoint | Injected backend failure |
| --- | --- | --- | --- | --- |
| Ghostget login | No candidate | Zero requests | No candidate | Incomplete, exit 8 |
| Sys1 model manifest | One candidate | Zero requests | No candidate | Incomplete, exit 8 |
| design-kit label activation | No candidate | Zero requests | No candidate | Incomplete, exit 8 |

The Sys1 finding matched the independently established traversal defect. Its
feedback was recorded as useful, and a live recheck reported it again. After
substituting the repaired source, rechecking the old finding returned superseded
without inference. A fresh checkpoint on that repaired source produced no
candidate. The other two projects produced no findings, so no feedback was
fabricated for them.

The pilot made seven hosted requests and three deliberately failed gateway
requests. First checkpoints took 975–1,178 ms including CLI startup and local
work; unchanged repeats took 462–484 ms. The model still missed two of the three
pilot defects. No agent repair time or long-term review-effort saving was
measured. See [workflow-results.json](../benchmarks/reviewer/workflow-results.json)
for per-step results and usage.

## Approach after the experiment

Ship the explicit checkpoint, investigation, feedback, and recheck workflow.
Keep the four candidate rules outside default and packaged rule directories.
Prefer deterministic checks when they can express a requirement. Add unseen
defect families and ordinary clean changes before changing rule cutoffs or
claiming everyday usefulness.

The [Perch experiment](perch.md) verified wire compatibility and richer context
through the real CLI with a fake backend. Its mixed source snapshots and retry
behavior need controls before adoption. Compare context strategies on documented
misses before building a new call-graph engine. Automatic hooks remain future
work, contingent on better detection and measured review effort.
