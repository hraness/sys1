# Focused review experiments, September 27, 2026

Sys1 0.14.0 lets an agent select active rules for a review with `--rule <id>`.
This makes it possible to check a particular concern without editing its rule
pack. Tests cover selection, repository overrides, unchanged-batch reuse, and
rechecking a finding with its original rule. The [review guide](review.md)
shows the commands.

The accompanying experiments tested why the previous review missed three
historical defects. Narrow requirements found two of those defects; providing
complete supporting files found none. The requirements were written with the
defects in view, so this is evidence for further testing rather than an estimate
of accuracy on new changes.

## Questions and supporting context

Each of four approaches reviewed the same three defective snapshots and their
repaired counterparts. All 24 requests used `typesafe/jev-1.13.0`, with no
retries and unchanged score thresholds of 0.8 and 0.9.

| Approach | Known defects detected | Alerts on repaired controls | Input tokens |
| --- | ---: | ---: | ---: |
| Original four-rule batch | 0/3 | 0/3 | 14,164 |
| One specific requirement | 2/3 | 0/3 | 7,362 |
| Original batch with complete supporting files | 0/3 | 0/3 | 30,342 |
| One proposed failure claim | 1/3 | 0/3 | 7,406 |

Specific requirements detected login success before token persistence and a
forced theme ignored in favor of the resolved theme. Every approach missed
the native label-activation defect. Complete-file input used 2.14 times the
original input tokens without detecting another target defect.

The specific variant changes both wording and question count. It does not
isolate an accuracy benefit from selecting one rule. The experiment supplied
target-side files, without a caller graph or authentic before-file context.
Only target scores were retained from multi-rule batches, so those batches'
total false alarms cannot be reconstructed. Some repairs include explanatory
comments. These six related examples do not measure accuracy on unseen changes or
time saved during review.

The [experiment record](../benchmarks/reviewer-next/context/README.md) includes
all target scores, frozen request identities, token counts, timing, public
source verification, and an offline command to reconstruct the requests.

## Independent clean controls

A separate worker assembled ten clean historical examples from five public
repositories, and an independent reviewer admitted their target-rule labels
before predictions. The original four candidate rules produced zero target-rule
alerts at either threshold. All four numeric answers were retained for each
example, but only the nominated rule had an independently reviewed label.

This control check used the original wording. It does not test the specific
requirements above. The search found no unambiguous new positive defect for
these rules, so recall remains unmeasured. A separate Wordcell pair reproduces
premature concurrent promise settlement; its fit to the success rule was
ambiguous, so both states were excluded from primary results before inference.

The ten controls and two diagnostics used 12 requests, 39,313 input tokens, and
1,008 output tokens, with no retries. The [control record](../benchmarks/reviewer-next/controls/README.md)
includes labels, numeric answers, source notices, and a deterministic reproducer
with 64 assertions. That reproducer uses browser API fakes and a temporary
filesystem; it does not rerun the originating projects' browser suites.

## Complete-repository trials

The actual CLI reviewed selected changes in complete, clean checkouts of three
public repositories. Each checkpoint explicitly selected the two bundled rules
and used a pinned hosted route. The checkouts contained 261, 1,241, and 533
tracked files respectively; the selections below define the coverage.

| Repository | Selected changed files | Reviewed units / requests | Findings | Unchanged-repeat requests |
| --- | ---: | ---: | ---: | ---: |
| Sys1 | 16 | 21 | 0 | 0 |
| Ghostget | 4 | 10 | 0 | 0 |
| design-kit | 2 | 2 | 0 | 0 |

All three checkpoints completed without skipped evidence. The 33 requests used
72,321 input tokens and 1,012 output tokens. The three concurrent trials took
8.43 seconds in total, including their unchanged repeats. Billing was not
retrieved. These were selected historical changes in complete checkouts; they
were not daily-use installations or exhaustive reviews of those repositories.
No candidates were produced, so there was no finding investigation or feedback
to measure. The absence of findings has no independent accuracy label.

The [trial record](../benchmarks/reviewer-next/adoption/README.md) preserves
exact commits, selected paths, reports, public-source checks, and request counts.

## Using the result

Choose a relevant requirement from the repository's own conventions and pair
it with a known violation and a clean counterexample. Keep the selected paths
and rules the same between preview and evaluation. Investigate candidates in
their callers and tests before changing code. A higher score does not establish
a defect, and an empty report does not replace the repository's tests.

The built-in rules and opt-in candidate rules retain their experimental status.
The evidence does not justify automatic repairs or enabling additional context
transmission by default. Further evaluation needs independently labeled new
defects and measured investigation effort in ordinary development.
