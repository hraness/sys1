---
version: 1
slug: "site-docs-html"
primary_target: "site/docs.html"
related_targets: ["site/docs.css", "site/docs/evaluations.html", "site/docs/evaluations-history.html", "site/style.css"]
---

# Sys1 documentation hub

Mode: Read. Developers deciding how to install Sys1, embed the router, or
connect a compatible System One service. The docs hub is the evergreen route;
dated model studies remain under `/docs/evaluations` and `/docs/evaluations-history`.

## Direction contract

THESIS: Give a developer one clear next step and enough route detail to choose
without turning the homepage into an implementation manual.
OWN-WORLD: Preserve the implemented Hraness Paper/Peopleblade system: warm
paired surfaces, Instrument Serif headings, Nebula Sans body text, quiet rules,
terminal code frames, appearance control, and shared footer. Add only local
docs layout rules; no new design tokens or assets.
STORY: Start local or hosted; choose portable client, embedded Bun router, or
loopback HTTP; understand model and adapter boundaries; then inspect dated
evidence and the separate Skills guide.
FIRST VIEWPORT: One direct value statement, release/version context, and a
route-level documentation index visible before implementation detail.
FORM: Reading surface with a compact sticky section index, unboxed route rows,
semantic definition rows, and code specimens. No dashboard cards or benchmark
hero metrics. Technical implementation stays below the route choice.
FINISH: Static source/link validation only for this bounded documentation pass;
root owns homepage/navigation redirects and any browser review.

## Source contract

Product truth comes from PRODUCT.md, README.md, src/cli.ts, src/client.ts,
src/runtime.ts, src/protocol.ts, and the 0.10.0 release metadata. Local Qwen
remains experimental; hosted Jev activation is explicit and hosted-only. The
client is portable to Node 24 and Bun; the embedded router requires Bun; the
daemon exposes loopback HTTP. Compatible HTTP services require explicit
registration and selection. Evaluation pages are copied complete from the
existing comparison surfaces, preserving dated numbers, raw-report links,
and caveats while using `/docs/evaluations*` canonicals. The current
evaluations page may link to a pinned external benchmark such as JevBench, but
it must label that evidence as external cross-model context and keep it
separate from Sys1 adapter results; never turn a provider or self-hosted row
into a Sys1 quality claim.

## Shared controls — 2026-09-20

Adopts the canonical design-kit appearance icon/menu with the existing saved
preference key, sticky shared marketing header, and pinned sticky Hraness
footer. See DESIGN.md and the vendor provenance for the common contract.
Page content and evidence claims are unchanged by this adoption.

## Kev and profiles — 2026-09-21

Add the explicit Kev adapter to backend choices and a Profiles & tuning section
with a reusable SDK example and the detailed setup/training guide. Profiles
freeze task questions and an exact route; they do not attest checkpoint bytes
or start training. Keep Kev unscored in the comparison until matching evidence
exists. Desktop and mobile browser review covered code wrapping, navigation,
appearance, and the Kev calculator's operator-supplied cost inputs.

## Copy: 2026-09-23

Public copy on this page follows `STYLE.md` and `WRITING.md` (synced from
hraness/.github) and the “Public copy” section of `PRODUCT.md`.

- Title “Docs · Sys1”, matching the nav label. H1 “Sys1 documentation”.
- The lead names the three question types and the ways to start. Section
  intros state facts about the reader's choice, not how the docs are organized.
- The backend list includes every bundled Qwen model (0.6B, 1.7B, and 3.5 4B)
  and introduces Jev and Kev in plain words at first mention.
