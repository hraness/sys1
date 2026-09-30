# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The homepage addresses developers using coding agents to review repository
changes and check completion claims. It also serves application developers
who need the underlying typed decision API. The user requested clearer skill
value, portable workflows, and search discovery on 2026-09-28.

## Product Purpose

The website helps coding-agent users install compact test and build output
through the independent System One Skills package. It requires Node.js 20+ on
macOS or Linux and no model account. Sys1 adds optional repository review and
completion-message checks using a model, plus an API for typed yes/no, choice,
and score decisions. Review and completion checks are experimental and
advisory. Neither package has demonstrated whole-task token or time savings.

## Capabilities and Constraints

- Sys1 includes ALGAL for saved check-then-review workflows on macOS and Linux.
  Check-only runs need no model. Review requires an explicit route and request
  limit; resume checks input identity and refuses uncertain effects. Historical
  check results never replace fresh required delivery checks.
- Project-local review and verification skills install instructions only;
  they do not add hooks, activate backends, or call models during setup.
- Review accepts staged, working-tree, or committed Git changes and explicit
  rules and paths. The bundled rules target JavaScript/TypeScript; other
  languages need suitable repository rules. Findings remain advisory.
- Verification accepts a message file or stdin from any agent. Optional Devin
  discovery selects the newest matching-directory session, not necessarily the
  current agent session. Plain-message input has no check-command transcript.
- A portable Node 24/Bun client, embedded Bun router, and loopback HTTP daemon
  expose the same decision contract.
- Explicitly installed local GGUF models run through node-llama-cpp.
  All local Qwen paths are experimental. Setup selects Qwen3 1.7B;
  Qwen3 0.6B and Qwen3.5 4B require explicit selection.
- Local inference is enabled and hosted Jev is disabled in fresh config.
  Hosted activation and model downloads require explicit setup. Enabling Jev
  selects hosted-only routing; a provider outage never implicitly substitutes Qwen.
- Routing policy, capability checks, cancellation, request-matched response
  validation, and local model lifecycle belong to Sys1. Application policy,
  permissions, quality thresholds, and deterministic fallback stay in the app.
- A compatible response schema does not establish equal calibration, model
  quality, speed, or cost. Comparisons must identify exact artifacts, datasets,
  runtimes, hardware, and whether evidence is measured locally or upstream.
- MIT source and npm-format immutable GitHub Release artifacts are available.

## Brand Commitments

The name is Sys1 and the domain is sys1.io. The user explicitly requested the
general Hraness design system, using peopleblade.com as the visual reference.
Explain the value and features plainly, and accurately distinguish Sys1's
role from Jev, OpenJev, Laya, and its underlying model runtimes. Historical
CUA-S1/Needle measurements remain available; those adapters were removed in 0.9.

## Evidence on Hand

Released packages and their checksums, source, README.md, docs/runtime.md,
and deterministic/native-install checks document the current behavior.
The System One Skills replay of 563 validation outputs measured 35.20% fewer
UTF-8 text bytes at the first tool result, from one developer’s sessions. It
excludes instruction and follow-up costs. Later task trials have not established
whole-task savings. The 60-run completion baseline did not cross its registered
threshold for testing an automatic hook; no intervention trial followed.

The comparison page owns external JevBench scores and cost estimates.
`/docs/evaluations` owns dated local adapter and workflow experiments;
`/docs/evaluations-history` preserves the original form-action study. Local Qwen
quality remains experimental. Synthetic examples and recorded figures do not
establish production accuracy or calibrated probabilities. There are no supplied
customer testimonials or adoption counts. Authored illustrations are labelled.

## Public copy

Public copy follows `STYLE.md` and `WRITING.md` in this repository, synced from
hraness/.github. Design briefs in `.impeccable/surfaces/` follow the same
guides; update a brief in the same change as its page.

- The canonical Sys1 description is: “Sys1 gives coding agents tools to review
  code, check completion claims, and get structured answers from Jev or a local
  model.” The portfolio registry owns the shared product messaging. Keep the
  independent System One Skills package distinct in homepage and install copy.
- The homepage leads with Sys1's saved check and review workflow. The independent
  System One Skills package remains a compact-output option.
  It does not promise whole-task token, time, or cost savings. Give the scope
  and date beside a numerical measurement.
- Write the name as Sys1 in prose. Use `sys1` only for the command, the package
  scope, and the sys1.io domain. The registry's all-caps display (SYS1) is not a
  prose spelling.
- Introduce Jev at its first mention on a page as TypeSafe's hosted decision
  model.
- Put each limit beside the feature it limits: model-assisted review is
  advisory, local Qwen is experimental, and hosted Jev is opt-in.
- The vocabulary of `AGENTS.md` and these briefs (boundary, contract,
  qualification, admission, surface, pilot, lifecycle, owns) is internal. On a
  public page, say what the reader gets instead.
- Headings name the section's topic or the reader's task. Do not write two-part
  slogan headings, maxim closers, or copy that explains how the site is
  organized.
- Every HTML file under `site/` carries its own copy of the primary nav. Keep
  one nav on every page: Skills, Docs, Evidence, GitHub.
- Label a historical measurement with its date and version, and link its
  record. Do not call a record reproducible unless a script in this repository
  regenerates it.
