---
version: 1
slug: "site-index-html"
primary_target: "site/index.html"
related_targets: ["site/style.css","site/site.js"]
---

# Sys1 homepage

Current Clef migration: use Cloudflare Clef in the product description and
model examples. Hosted inference remains disabled and explicitly opt-in;
local Qwen remains experimental. The dated design records below are historical.

Mode: Persuade. Primary audience: developers building agents and apps; secondary audience: people running agents locally. Confirmed by the user on 2026-09-19. Primary action: install Sys1; secondary: read module documentation. Product truth is in PRODUCT.md. No runtime product changes are in scope.

## Direction contract

THESIS: Make the shared decision interface understandable through a small, labelled request-and-answer example and clear ownership of the model ecosystem.

OWN-WORLD: Adopt the user's named Peopleblade reference through the actual Hraness Paper palette and editorial marketing preset, self-hosted Nebula Sans and Instrument Serif, restrained controls, quiet rules, and the shared Hraness footer. Keep existing system light/dark behavior.

STORY: Understand the decision forms; see why routing and validation belong in one package; distinguish Sys1 from upstream models and servers; choose client, embedded runtime, or daemon; install locally.

FIRST VIEWPORT: A compact shared-style header, centered serif statement and short explanation, install/docs actions, and a wide interactive request/answer specimen. Changing the question form updates a labelled illustrative example without making a model call. No invented benchmark or latency badge.

FORM: User-pinned Hraness/Peopleblade visual system, adapted to a developer product. No random concept seed: the visual authority is explicit. Use the existing reference and reusable code assets, with responsive desktop and mobile verification.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance


## Benefit clarity refinement — 2026-09-19

The lead line chosen in this refinement was retired on 2026-09-23; see “Copy:
2026-09-23” below. The supporting copy connects that interface to yes/no decisions, choices, scores, response validation, and
local model loading, with hosted Jev explicitly opt-in. Feature headings name
request control, usable answers, and model lifecycle management. Existing
schema-versus-quality and adapter limitations remain nearby.

The System One Skills link names its separate practical benefit: keeping known
noisy check logs out of agent context while executing the original command once
and retaining a full local log. It does not attribute the skills replay result
to Sys1 routing or promise better diagnosis, billed savings, or faster tasks.
The evidence-owner task reviewed the exact claims. This is a text and metadata
refinement: structure, design tokens, demo behavior, links, installation and
footer are preserved.

## September 20 supported routes

The headline chosen here was retired on 2026-09-23. Lead with the reusable
client, model selection you control, validated answers, and local model setup.
All Qwen decisions are experimental; say so beside the hero and local
quickstart. Enabling Jev selects hosted-only. Keep a hosted module pilot
distinct from automatic local migration. CUA and Needle are historical
evidence rather than supported runtime routes in 0.9.


Final September 20 source and visual disposition: **ship**, no material fixes.
The same four desktop-light/mobile-dark captures named in the comparison
surface were independently reviewed. Integration checks confirmed the
illustrative decision controls, appearance selector, migration disclosure and
responsive layout. The module proof uses actual packaged Node and Bun entry
points with real local inference, while explicitly separating integration
validity from decision quality. Laya is an unbundled measured candidate.
The Paper system and existing design assets remain unchanged.

## Evergreen homepage refocus — 2026-09-20

The homepage now answers three questions in order: what Sys1 is, how it enters an application, and where to read evidence. The H1 is “One typed API for every small decision.” The summary under it says what the agent asks, what comes back, and which models can answer. The request-and-answer specimen remains illustrative and makes no model call.

Implementation and research details now point to `/docs`: getting started, integration modes, backend semantics, module proof, and dated evaluation reports live there. The homepage names Jev, local Qwen, compatible HTTP services, and the surrounding runtime without placing benchmark snapshots or release-specific install commands in the primary story. The local quickstart uses the evergreen source build path; exact release artifacts stay in the docs.

The design remains the Hraness Paper system used by Peopleblade: warm paper surfaces, Instrument Serif display type, Nebula Sans body text, quiet rules, shared footer, and light/dark appearance control. Review target: desktop 1280px, mobile 390px, and intermediate widths with no horizontal overflow.

## Shared controls — 2026-09-20

Adopts the canonical design-kit appearance icon/menu with the existing saved
preference key, sticky shared marketing header, and pinned sticky Hraness
footer. See DESIGN.md and the vendor provenance for the common contract.
Page content and evidence claims are unchanged by this adoption.

## Copy: 2026-09-23

Public copy on this page follows `STYLE.md` and `WRITING.md` (synced from
hraness/.github) and the “Public copy” section of `PRODUCT.md`. This section supersedes the lead lines quoted in the earlier sections;
do not restore them.

- Title and social title: “Sys1 · Yes/no, choice, and score decisions for
  agents”. The description and social description are the same one or two
  sentences, 110 to 160 characters.
- Hero: keep the H1. The summary names the three question types, the validated
  answer with probabilities, and who answers, and introduces Jev as TypeSafe's
  hosted decision model. The hero note carries the status once.
- Section headings name the section's topic or the reader's task. No two-part
  slogans, no maxim closer, and no sentences about where evidence belongs or
  how the site is organized.
- The 0.9.0 module test is labelled with its date and version and links
  `site/data/sys1-0.9-module-proof.json`. No script regenerates it, so do not
  call it reproducible or current. Rerun it for the current release, or remove
  the paragraph.
- The quickstart heading matches what its commands do: install and set up a
  local model. The FAQ answer about replacing a Jev client links the README's
  adoption section, which is the guide it describes.
- One primary nav on every page: How it works, Docs, Compare, Skills, GitHub.

## Copy: 2026-09-24

The canonical Hraness product-messaging record now owns the public identity
lines. This section supersedes the title, description, and hero lines quoted
above; do not restore them.

- Title and social title: “Sys1 · Give your agent a System 1.”, the record's
  name and tagline joined with the site's separator. The description and social
  description are the record's meta line verbatim, 152 characters.
- Hero: the eyebrow is the record's category, “Agent decision router”. The H1
  is the tagline “Give your agent a System 1.”, the summary is the record's
  hero summary, and the actions are its labels: “Install Sys1” to `#install`
  and “Read the evaluations” to `/docs/evaluations`.
- The hero note carries the status once, from the release record: “Latest
  release: v0.10.0 · MIT · Hosted Jev is opt-in · Local models are
  experimental”. Render the version from the release record; never retype it
  without updating the release.
- Jev is introduced at its first explanatory mention, in the ecosystem
  section: “Jev, TypeSafe's hosted decision model”.
- The one-line description rule lives in PRODUCT.md: the meta line is the
  standalone description (package, README, `llms.txt`), and the short line
  follows the product name in the CLI.

## Release metadata: 2026-09-27

The release label follows package.json at 0.13.0. Homepage layout, product
messaging, and dated measurement records are unchanged. Agent review commands
and their limits are documented at `/docs#audit`.

## Agent workflows and discovery — 2026-09-28

This direction supersedes earlier hero and metadata snapshots. Preserve the
current September 27 visual implementation. The page is Persuade: help a
coding-agent user decide whether to install Sys1. The title is “Sys1 · Agent
code review with Jev”, while the description keeps the portfolio registry text
verbatim. Lead with repository review, then show the independent `sys1-verify`
skill and separate System One Skills noisy-output workflow. The decision API
and recorded Qwen example remain useful for application developers below that
entry point. Keep the ordinary tests/review requirement beside candidate scores.

The release example is drawn from package.json; the integration owner updates
it for the joined release. The `sys1 verify setup` examples depend on the
standalone project-skill implementation being integrated before publication.
JSON-LD identifies an MIT developer application and the shipped version, with
no review-accuracy, adoption, or ranking claims. Twitter and Open Graph copy
match the page metadata. Jev is TypeSafe’s hosted System One decision model;
no separate framework capability is asserted.

Editorial admission: revise this existing homepage. Reader job: understand
what the skills add and choose installation or the relevant workflow. The
non-obvious answer is that a project skill can guide model-assisted review
while ordinary tests and investigation remain necessary. Original contribution:
product behavior tied to `src/review/`, `src/verify/`, package metadata, and the
checked TypeSafe docs. Neighbors: /skills chooses instructions, /docs gives
commands, /compare reports model evidence; the homepage supplies the product
and adoption decision. Scores: utility 2, original evidence 2, factual
confidence 1 pending joined `verify setup` source, host fit 2, voice 2,
maintenance 2 (11/12). Owner: Sys1 maintainer. Draft/source pass: Codex agent
/root/site_value on 2026-09-28. Human review: none. Independent source review
and desktop/mobile visual review: pending integration owner. Reassess on the
next skill or release change, or 2026-10-26. No new assets or CSS.

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

## Tokens and time — 2026-09-28

Supersedes the “Agent workflows and discovery” hero and metadata at the user's
request: the copy read as too technical and hid the key benefit. The title is
“Sys1 · Save your coding agent tokens and time”; the description is the new
PRODUCT.md one-liner verbatim. The H1 is “Stop spending big-model tokens on
small decisions.” and the summary names three concrete small questions.
A new “Three parts, one system.” section before “How it works” reuses the
existing ecosystem-table layout for the agent, Jev, and ALGAL, and states that
Sys1 and ALGAL are separate projects sharing the Jev decision API and that
whole-task token savings are not yet measured. Cost figures cite TypeSafe's
published workflow numbers; the 35% figure is the System One Skills replay.
One CSS change: `.ecosystem-row strong` matches the linked part names. Visual
structure, tokens, demo behavior, and footer are unchanged. Draft: Claude Code
on 2026-09-28. Human review: pending the user.

## Install example — 2026-09-28

The install frame adds decorative window lights and static shell highlighting
for commands, flags, and the release URL. It keeps the existing terminal
palette, copy action, exact command text, and release-version binding. The
scrollable block is keyboard-focusable and has a descriptive accessible name.
No client dependency, product behavior, or model/approval claim changes. Source
review and browser validation belong to the marketing integration owner.

## Product readiness refinement — 2026-09-29

The user requested a finished, useful installation experience and authorized
revising the descriptions. Preserve the current Hraness Tokyo Night palette,
shared controls, fonts, icon, footer, and responsive behavior. This refines the
existing visual identity. The prior lead and navigation snapshots above are
historical and superseded for this delivery.

The homepage is Persuade. Its first task is to install the independent compact
check skill; it needs Node 20+, macOS/Linux, and no model account. Show that
workflow in the first viewport. Then explain the optional Sys1 review and
completion-check tools, keeping their advisory status beside them. Put the typed
decision API below those workflows, with a working offline illustration and a
link to its reference. Keep one shared navigation: Skills, Docs, Evidence,
GitHub. The primary action is Install skills. Model comparison and the launch
story remain reachable from relevant sections and documentation.

Retire the homepage's unfinished-comparison pitch, synthetic-screening chart,
repeated backend/integration reference, speculative system narrative, and
repeated FAQ. The research documents remain available; these blocks compete
with installation and duplicate the documentation. A dated replay result may
support a narrowly worded output-size claim. Whole-task savings remain unproven.

Editorial admission: revise the existing `/` and `/skills` URLs. The homepage
helps a coding-agent user choose a working check; `/skills` owns installation and
first use. `/docs` owns the optional runtime reference, `/introducing-sys1` owns
the explanatory guide, and `/compare` owns model comparison. Product source,
released packages and the published studies supply first-party evidence; no
personal endorsement or new customer claim is introduced. Scores for homepage:
reader utility 2, original evidence 2, factual confidence 2, host fit 2, voice
integrity 2, maintenance value 2. Scores for skills page: reader utility 2,
original evidence 2, factual confidence 2, host fit 2, voice integrity 2,
maintenance value 2. Evidence owner: Sys1 maintainers. Drafted by Codex. Independent AI editorial/source and rendered review by
Codex agent `/root/launch_finish` found no remaining blockers; its five-question
assessments and screenshot evidence are recorded in `docs/launch-editorial.md`.
Root also inspected the desktop/mobile layouts and share image. The converged
local browser sweep passed all 80 combinations and interactions on September
30, 2026, with verified owned-browser cleanup. Reassess on
2026-11-10 or with the next release, whichever comes first.

## Unified Sys1 workflows — September 30, 2026

The user asked to incorporate ALGAL into Sys1 underneath ready-made workflows.
Retain the current Tokyo Night design, components, illustrations and interactions.
The homepage now answers whether to install Sys1 to save a repository check and
continue a scoped review; the primary action installs Sys1 itself. The separate
System One Skills package remains an optional compact-output tool, with its own
dated measurement. Do not transfer that measurement to the new workflow.

The original contribution is the checked installation and execution path owned
by this repository. /docs owns the procedure, /skills owns agent installation,
and /introducing-sys1 remains the launch explanation; no new route is needed.
Reader utility 2, original evidence 2, factual confidence 2, host fit 2, voice
integrity 2, maintenance value 2: 12/12. Claims are
bounded to saved results and guarded continuation, not improved review quality.
Drafter and owner: Codex /root. Independent source/voice reviewer: Codex
/root/install_experience; the reviewer confirmed the commands and measurement
boundaries. No human review claimed. Root inspected mobile and desktop captures
and the share cards; all 80 local browser combinations and interactions passed
with the pinned Chromium 145.0.7632.6. The exact packed CLI also passed its
model-free saved-check and cross-process inspection checks. The homepage's
metadata retains the canonical product description while its hero introduces
the saved workflow. Source-check date: 2026-09-30. State: admit. Release and
production verification remain part of delivery. Reassess on
2026-11-10 or the next feature release.

## Evidence and caption refinement, September 30, 2026

This refinement supplements the saved-workflow onboarding above. Retire
promotional panels for the synthetic source-profile trial and blanket
illustration captions. Keep the shipped saved-check and review experience,
the measured 563-output replay, and external JevBench links. Research plans
and small screening results remain in their existing reports. Demonstration
context and accessible descriptions identify sample content; visible captions
add useful information for interpreting the result.

Draft/source pass: Codex agent /root/portfolio_audit. Independent source review
and converged browser acceptance remain with the integration owner.
