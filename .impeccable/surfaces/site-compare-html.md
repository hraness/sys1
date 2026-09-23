---
version: 1
slug: "site-compare-html"
primary_target: "site/compare.html"
related_targets: ["site/comparison.css", "site/compare.js", "site/compare-math.js", "docs/model-comparison.md"]
---

# Model comparison

Mode: Read, with an inline cost tool. Developers choose a decision route using
external evidence, setup constraints, and their workload. Preserve Hraness
Paper/Peopleblade: Instrument Serif, Nebula Sans, paired colors, quiet rules,
shared header, appearance control, and footer.

## Direction contract

THESIS: Lead with JevBench quality for available Sys1 routes; make cost easy to
explore; put the original project studies in documentation.
STORY: Hard-tier accuracy → available routes → workload cost → evidence sources.
FIRST VIEWPORT: The purpose and benchmark are visible without the legacy
forms-v1/Qwen/Laya research tables. This is a model comparison, not a study log.
FORM: Horizontal bars with textual values and explicit unscored routes, simple
route rows, labelled calculator fields and one estimate panel. No new assets.
FINISH: Batched desktop/mobile light/dark and interaction checks, independent
source/logic review, one correction round, repository gate, live readback.

## Evidence contract

JevBench v1.2.6 is pinned to commit
`275763201a29d6083d4ee1431d709c296ef81281`. Hard-tier accuracy is 163/220 (74.1%)
for Jev and 144/220 (65.5%) for razorback16 OpenJev DiffusionGemma NVFP4.
Intelligence, calibration, and the overall geometric composite are separate
scores out of 100, never labelled accuracy percentages. All chart axes start
at zero. The source is external and the GPU result does not qualify Apple MLX
or a Sys1 deployment.

Filter by route identity, not shared weights. Jev is built-in hosted; OpenJev
is operator-run via the documented HTTP interface. Bundled Qwen3 0.6B/1.7B and
Qwen3.5 4B have no matching JevBench score and remain visible as unscored.
SemIf's different Qwen adapter cannot supply their score. Other JevBench rows
remain in the evidence appendix. Preserve old raw reports and studies in
`/docs/evaluations` and `/docs/evaluations-history`.

## Calculator contract

Model selection covers Jev, all three bundled Qwen options, an OpenJev server,
and custom compatible service pricing. Jev uses $0.042/M input tokens with
output free (TypeSafe source checked 2026-09-20). Monthly volume presets and
input fields retain user control. Custom service rates include input/output.
Local machine estimates use user-provided hourly cost and allocated hours;
blank values never mean free, and capacity is not inferred. Unit costs are
per 1,000 requests, not questions or correct decisions. Keep retries, taxation,
price changes, and idle/allocated machine time clear beside the estimate.

Progressive enhancement: the accuracy chart, sources, route guidance, and
static Jev example remain readable without JavaScript. Chart controls and
volume presets appear with JS. The archival pages retain comparison.js;
compare.js and compare-math.js serve only the redesigned comparison route.

## Verification — 2026-09-20

Independent source and calculator review passed; 16 focused tests cover 99
assertions. Browser verification used the actual CSP at 1280×1000 and 390×844
in light and dark. No horizontal overflow or console errors occurred. Checked
metric switching, volume presets, hosted/custom token arithmetic, machine
allocation, explicit zero costs, zero request volume, and cleared inputs.
Missing inputs correctly remove the numeric estimate. Appearance was restored
to System and the temporary viewport and preview process were closed.

One detector pass completed; inherited typography/theme findings were checked
against the required shared design. The visual pass confirmed readable bars,
labels, form controls, and estimate panels. The unrelated theme/footer upgrade
is owned by the parallel shared-controls change.

## Shared controls — 2026-09-20

Adopts the canonical design-kit appearance icon/menu with the existing saved
preference key, sticky shared marketing header, and pinned sticky Hraness
footer. See DESIGN.md and the vendor provenance for the common contract.
Page content and evidence claims are unchanged by this adoption.

## Copy: 2026-09-23

Public copy on this page follows `STYLE.md` and `WRITING.md` (synced from
hraness/.github) and the “Public copy” section of `PRODUCT.md`.

- Title “Compare models · Sys1”. The social description matches the page
  description; the old latency and footprint text no longer describes the page.
- Headings name the section's content (“How the models score on JevBench”,
  “Sources and studies”). No two-part slogans.
- `test/compare.test.js` pins facts on this page (the two hard-tier counts,
  the unscored-Qwen sentence, the external-measurement scope, the MLX limit,
  and the $4.20 example). Reword those sentences only together with the test.
