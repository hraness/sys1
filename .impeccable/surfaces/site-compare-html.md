---
version: 1
slug: "site-compare-html"
primary_target: "site/compare.html"
related_targets: ["site/comparison.css", "site/comparison.js", "site/data/forms-v1-m5-max-2026-09-19.json", "docs/model-comparison.md"]
---

# Model comparison

Mode: Read. Developers choosing the local or hosted model behind Sys1.
User requested detailed Cactus/Needle/Jev/Qwen results, speed, token use,
and performance. Extend the existing Hraness Paper/Peopleblade design.

## Direction contract

THESIS: Tie every number to its workload, runtime, hardware, and evidence class.
OWN-WORLD: Existing shared Paper palette, editorial serif, Nebula Sans, quiet
rules, small controls and shared footer. Preserve DESIGN.md and its sidecar.
STORY: Choose by task, inspect local results, compare upstream context, understand
token accounting, estimate API cost, reproduce an evaluation.
FIRST VIEWPORT: Plain introduction, in-page navigation, and the start of the
capability table. Detailed numbers have captions, units, and nearby conditions.
FORM: Reading surface with semantic tables and keyboard-scrollable wide data;
stack contextual evidence on small screens. No universal speed leaderboard.
FINISH: One desktop/mobile inspection batch, independent finish review,
corrections as required, and documentation of the preserved system.

## Implemented surface

The page inherits the pinned Paper palette, Instrument Serif, Nebula Sans,
shared header and appearance selection, and Hraness footer. Its local
stylesheet adds captioned semantic tables with tabular numeric figures,
two-column evidence rows, token-accounting descriptions, and the estimator.
Tables remain horizontally scrollable inside labelled focusable regions;
the small-screen hint explains this behavior. Evidence, accounting, and
calculator columns stack at the incumbent compact breakpoint. No new system
tokens or visual assets are introduced; DESIGN.md frontmatter and the design
sidecar remain unchanged.

Native disclosures reveal startup/token detail and related output-path
research without JavaScript. The cost calculator uses labelled number fields,
field limits, and a polite live output. It updates an arithmetic Jev estimate
from the published input-token rate, with a static default and an explanation
when JavaScript is unavailable. It neither calls a model nor bills a service.

## Evidence contract

The local table reports the actual `forms-v1-local-adapter` benchmark in
`site/data/forms-v1-m5-max-2026-09-19.json`: 20 authored synthetic cases,
100 repeated timing calls per adapter, concurrency one, Apple M5 Max with
36 GiB system memory, and Bun 1.3.14. Source and harness revision `83ca299`
is linked along with the fixture and complete raw results. Keep correctness,
valid response counts, adapter latency, and throughput separately labelled.
Repeated timing observations are not additional independent quality cases.

CUA's narrative task transfer and Needle's extraction-to-choice adaptation
must remain explicit. Qwen's reported input tokens, CUA's byte scoring, and
Needle's unreported token usage have distinct meanings. Fresh-runner timing
does not imply cold-machine timing; the Metal capability probe does not
measure per-inference GPU activity. Memory capacity is not peak model memory.

Publisher measurements stay in separate evidence rows with source links,
hardware, runtime, workload, units, and disclosed limits. Hosted Jev and
OpenJev were not measured in the local run. Shared response schemas do not
establish interchangeable quality, calibration, speed, or cost. Detailed
source notes live in `docs/model-comparison.md`.

## Finish evidence

Independent finish-review disposition: **ship**. The reviewer inspected the
desktop light/dark, mobile, 603px, and expanded-startup captures under
`.impeccable/review/compare-final-*.png`, together with the HTML, CSS, and script.
Persistence, fidelity, and ceiling matched the direction; no material fixes
were required. This was a visual/source review. Numerical revalidation and
live browser checks remained the integration owner's separate validation.
