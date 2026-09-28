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
src/runtime.ts, src/protocol.ts, src/cli-help.ts, src/review/, src/audit/,
and package.json release metadata. Local Qwen
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

## Agent review: 2026-09-27

The existing `#audit` destination introduces the advisory agent workflow and
links the new `docs/review.md` guide alongside stateless audit documentation.
Show the setup command, a scoped preview with request cap, and the issues
command. Explain source transmission, 24-hour reuse, local metadata, and recheck
limits without accuracy claims. The native setup targets are Codex and Claude
Code. Preserve the existing layout and primary navigation. Release labels and
archive URLs follow package.json at 0.13.0. No Markdown twin exists for this page.

## Review and verify setup — 2026-09-28

The docs remain Read in the current implemented Paper design. Prioritize the
reader’s first steps: install the CLI, select hosted Jev or local Qwen, install
the project instructions, then preview a check. Keep #audit for compatibility
and add #verify for completion claims. `sys1-review` and `sys1-verify` each
support Codex, Claude Code, and Devin. The latter installation examples must
join with their runtime implementation before publication. Agent-independent
message files are the default example; automatic Devin transcript selection
and unavailable evidence are explained explicitly. API, profiles, model
selection, and research retain their own sections.

Editorial admission: revise the existing documentation hub. Reader job: set up
one workflow and follow the correct detailed reference. Non-obvious answer:
installation, backend activation, source preview, and model evaluation are
separate actions; an unverifiable completion claim does not pass as evidence.
Original contribution: executable setup sequences tied to the CLI and project
skills. Neighbors: / explains adoption, /skills chooses workflows, repository
review/verify guides cover full command behavior. The hub supplies the concise
installation path without duplicating those references. Scores: utility 2,
original evidence 2, factual confidence 1 pending joined `verify setup` source,
host fit 2, voice 2, maintenance 2 (11/12). Owner: Sys1 maintainer. Sources:
package.json, src/review/, src/verify/, docs/review.md, docs/verify.md, and
TypeSafe’s models documentation, checked 2026-09-28. Drafter/source pass:
Codex agent /root/site_value. Human review: none. Independent source and
rendered desktop/mobile review: pending integration owner. Reassess on the
next release or 2026-10-26. No CSS or assets changed.

Independent source/copy review: Codex agent /root/readme_docs on 2026-09-28.
One finding repaired: disclose the two bundled JavaScript/TypeScript rules
beside generic review-workflow guidance, so portability does not imply broad
built-in language coverage. Other checked claims, Jev terminology, metadata,
and advisory/privacy boundaries aligned source. Runtime setup convergence and
rendered review remain with the integration owner.

Integration-owner visual review: Codex /root reported a passing 48-combination
browser check and inspected desktop/mobile homepage, docs, and skills captures
on 2026-09-28, with no blocker. Evidence:
`/private/tmp/sys1-portable-skills-browser/results.json`. The owner also checked
150 internal links and all seven sitemap canonical URLs, then collected the
browser and server. No additional visual iteration was requested. The
independent source/copy reviewer reported no remaining public-copy blockers.
Runtime-source fixes and release validation remain owned by the integration
owner; the prior pending visual-review note is now resolved.

Joined runtime source review: Codex /root/site_value inspected the standalone
verify installer, CLI dispatch, embedded skills, and corrected per-PR merge
checks on 2026-09-28. The setup commands described above now exist in source;
the worker's focused suite reported 30 passing tests and no failures. No
remaining source/copy blocker was found. Factual confidence is now 2 and the
revised page's admission total is 12/12. This records editorial/source
admission; aggregate validation, publication, and production evidence remain
with the integration owner's ordinary delivery workflow.
