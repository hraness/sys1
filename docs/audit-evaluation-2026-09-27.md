# Advisory audit evaluation, September 27, 2026

The removed-assertion rule caught all 10 violations in its authored held-out
examples. The empty-catch rule caught two of 10. Both produced zero false
alarms in their 10 clean held-out examples. These small samples support manual
experimentation with the assertion rule. Use a deterministic linter for empty
catches; the model missed most of them at the selected cutoff.

The [machine-readable results](../benchmarks/results/audit-2026-09-27.json)
include every case's label and predicted tier, confusion counts, uncertainty
intervals, fixture hashes, rule revisions, latency, and token usage. They
contain no source state, questions, raw answers, or credentials.

## Method

The route was `typesafe/jev-1.13.0`, using question format 2 and the `core`
pack. A separate AI worker authored 40 calibration and 40 held-out examples
before model execution. Each split contained 10 clean and 10 violating
examples per rule, with JavaScript and TypeScript cases. Cases covered removed
lines, incomplete bodies, replacement assertions, moved code, and comments
that tried to redirect the model.

Calibration selected the lowest measured medium cutoff with zero false
positives: 0.8 for empty catches and 0.7 for removed assertions. The high
cutoff stayed at 0.85. Wording and fixtures stayed fixed, and the held-out
set ran once after cutoff selection. There were no retries. Each request
included every applicable rule, matching the audit command's batching.

| Rule and split | Medium cutoff | Caught | Missed | False alarms | Correct clean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Empty catch, calibration | 0.8 | 3 | 7 | 0 | 10 |
| Empty catch, held-out | 0.8 | 2 | 8 | 0 | 10 |
| Removed assertion, calibration | 0.7 | 10 | 0 | 0 | 10 |
| Removed assertion, held-out | 0.7 | 10 | 0 | 0 | 10 |

The empty-catch rule's held-out recall was 20%. Its two predictions provide
little precision evidence: the 95% Wilson interval spans 34.2% to 100%.
The assertion rule's held-out precision and recall were both 10/10, with
intervals spanning 72.2% to 100%. These intervals assume independent cases;
related authored examples can make them optimistic. Scores and tiers are
not calibrated defect probabilities.

## Replay on public changes

A different AI reviewer labeled the selected diffs before seeing model
predictions. Labels used the same visible hunk evidence and rule definitions.
The frozen revisions were:

| Repository | Base | Head | Selected paths | Units |
| --- | --- | --- | --- | ---: |
| [Sys1](https://github.com/hraness/sys1/commit/a1faf3f351f81f07cda09fd798a8167f980c5bcc) | `b9e423dbb425e8dc5f09cafa44294cd0b72058c6` | `a1faf3f351f81f07cda09fd798a8167f980c5bcc` | `src/cli.ts`, `test/cli.test.ts` | 4 |
| [Ghostget](https://github.com/hraness/ghostget/commit/f3dcb911dd70d57fa6b732af0f7440d8ac5b2a97) | `79b08398d94ccfa9d50ac122e38b2916c1f21b0d` | `f3dcb911dd70d57fa6b732af0f7440d8ac5b2a97` | `src/browser.ts`, `src/browser.test.ts`, `src/web-session-cleanup-admission.ts`, `src/web-session-cleanup-admission.test.ts` | 10 |

All 19 applicable unit/rule pairs were labeled clean, and the model reported
zero findings. Coverage was complete with no skipped inputs. This measures
false alarms on two selected commits; natural recall cannot be measured
because the sample contains no labeled violations. Even treating the pairs
as independent, the upper end of the 95% Wilson interval for their
false-positive rate is 16.8%.

To reproduce a replay, use a clean detached checkout of its recorded head
and run the installed audit command with the recorded base and paths:

```sh
sys1 audit --since <base-sha> --model typesafe/jev-1.13.0 \
  --max-requests 20 --timeout-ms 120000 --json -- <selected-paths>
```

The [audit guide](audit.md#evaluate-a-rule) describes fixture evaluation.
Provider behavior can change even when the requested route is unchanged.

## Runtime and use

The 40 held-out requests completed in 21.215 seconds, with a median of
496.6 ms and a 95th percentile of 690.9 ms per request. The Sys1 replay took
2.084 seconds for four requests; Ghostget took 5.611 seconds for 10.
All 94 calibration, held-out, and replay requests reported usage, totaling
106,866 input tokens and 3,246 output tokens. Dollar cost was not measured.

The bundled rules are experimental reference checks. They do not establish
an advantage over linting or ordinary code review. Broader use needs natural
examples with confirmed defects, independent labels, a comparison against
existing linters, and evidence that accepted findings justify the review
time and model cost. Automatic hooks and blocking decisions remain outside
this release.
