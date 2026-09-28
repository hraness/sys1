# A rule written from an existing contract, September 27, 2026

A rule written from an existing Sys1 requirement missed a reproduced defect
and flagged two of five control hunks at the preset 0.8 threshold. This
experiment did not qualify the rule for routine review. It remains an inactive
source example.

The [previous experiment](reviewer-followup-2026-09-27.md) found two known
defects after their questions were made more specific. Here, a separate author
received only the requirement and API description before freezing the question.
The curator selected the requirement with the historical defect in view; the
question author saw neither the defective code nor its repair until authoring
was complete.

## The defect and its reproduction

Sys1's existing contract makes any received HTTP response definitive. A failure
before receiving a response can allow another backend attempt; a failure while
reading an already received response body must not.

The initial implementation caught both failures in the same handler. An
unreadable response body therefore produced a `transport` result and a second
POST. The repair returned a definitive HTTP 502 response and made one POST.
An offline reproducer checks this behavior in complete historical source trees,
with 63 assertions across five revisions. Successful HTTP 200 and definitive
HTTP 503 responses also receive counterexample checks. Provider functions are
injected; the reproduction makes no network or model requests.

The [benchmark directory](../benchmarks/reviewer-contract/README.md) contains
the reproduction commands, immutable source identities, license notice,
frozen question, fixtures, and results.

## Frozen question and results

The question requires forwarding to return the `response` variant whenever an
HTTP response was received, reserving `transport` for failures with no response.
It applies to `src/backends.ts`. Its wording, thresholds, and all six requests
were frozen before inference. Each request used the production diff collector's
state format and request compiler, the pinned `typesafe/jev-1.13.0` route, and
one question. There were no retries.

| Hunk | Expected new violation | Violation score | Flag at 0.8 |
| --- | --- | ---: | --- |
| Initial implementation | Yes | 0.03 | No |
| Repair, hunk one | No | 0.72 | No |
| Repair, hunk two | No | 0.84 | Yes |
| Repair, hunk three | No | 0.07 | No |
| Ordinary control, hunk one | No | 0.78 | No |
| Ordinary control, hunk two | No | 0.83 | Yes |

The 0.9 threshold produced no flags, including on the defect. Both thresholds
were preset and remain unchanged. Scores are uncalibrated. The two false alarms
concern changes to backend configuration, including a type rename, URL trimming,
and an optional adapter field. Neither introduces the forwarding failure.

All six requests completed in 1.56 seconds, using 9,690 input tokens and 156
output tokens. Billing was not retrieved. The public results preserve numeric
scores and request identities. An offline verifier reconstructs the exact
payload hashes and checks result accounting; it does not rerun the model or
recover discarded raw answers.

## What this changes

Specific wording derived from a repository contract was insufficient in this
case. File selection also admitted hunks that did not change the behavior named
by the rule. The [review guide](review.md#draft-a-repository-rule) now calls for
checking that the selected code is responsible for the requirement.

The deterministic reproduction is useful regression evidence. The model result
does not justify adding this rule to the active packs, making it a required
check, or enabling automatic repairs. Further reviewer development needs
evidence that candidates help on new defects and are worth investigating.

## Scope and excluded cases

This is one initial-implementation defect from a root commit, three selected
file diffs, and six hunks. The repair also contains unrelated changes.
The ordinary control changes adapter configuration
and provides a weak negative for response-body handling. The sources are public,
so prior model familiarity cannot be ruled out. These observations do not
estimate general accuracy or review time saved.

Two other proposed families were excluded before inference. A Ghostget
producer/consumer mismatch reproduced, but the independently authored rule
targeted the consumer and a different condition; the authentic introduction
also exceeded the default hunk size limit. A Wordcell candidate already failed
before its proposed introduction, so it could not support that regression label.
No source from either candidate was sent in this experiment, and no question
was rewritten after seeing these predictions.
