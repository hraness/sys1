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

The measured table retains the actual `forms-v1-local-adapter` benchmark in
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
hardware, runtime, workload, units, and disclosed limits. Hosted Jev was subsequently measured on the identical fixture on September 20
at source `e770483`; its raw report is `site/data/forms-v1-jev-2026-09-20.json`.
Keep its network-inclusive latency distinct from the local adapter boundary.
Jev reached 20/20 with 100/100 valid repeated calls; output usage was reported
and output pricing was free. Its region and server cache/hardware are unknown.
OpenJev remains unmeasured. Shared response schemas do not
establish interchangeable quality, calibration, speed, or cost. Detailed
source notes live in `docs/model-comparison.md`.

## Finish evidence

Independent finish-review disposition: **ship**. The reviewer inspected the
desktop light/dark, mobile, 603px, and expanded-startup captures under
`.impeccable/review/compare-final-*.png`, together with the HTML, CSS, and script.
Persistence, fidelity, and ceiling matched the direction; no material fixes
were required. This was a visual/source review. Numerical revalidation and
live browser checks remained the integration owner's separate validation.

## Hosted result extension

Preserve the existing Paper tables, disclosures, controls, and assets. Add Jev
alongside local results with explicit timing labels, separate dated provenance,
raw usage and estimated costs. State the poor 8/20 local performance plainly;
interface validity must never imply decision quality or migration readiness.

Independent visual review found no visual fixes at desktop light or mobile dark;
page overflow was absent at 1280px and 390px, with fonts loaded and no console
errors. Expanded failure and token disclosures were checked. The reviewer’s
one source correction qualified size-first selection to eligible local routes;
`auto` can prefer an available hosted backend. Original captures precede that
small wording correction; the layout and existing design assets are unchanged.
