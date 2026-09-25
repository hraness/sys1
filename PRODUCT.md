# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The homepage addresses developers building agents and applications first, while
also serving people running agents locally with a simple local quickstart.
This audience order was confirmed by the user on 2026-09-19.

## Product Purpose

Sys1 gives applications one interface for bounded typed decisions across local
models, hosted Jev, and operator-configured compatible HTTP services. The
application supplies state and questions; Sys1 returns validated yes/no,
choice, or score answers with routing metadata.

## Capabilities and Constraints

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

README.md, source, docs/DESIGN.md (runtime architecture), release workflows,
and deterministic/native-install checks document implemented capabilities.
The comparison page charts external JevBench results for the supported routes
and has a workload cost calculator. `/docs/evaluations` holds Sys1's own adapter
studies, and `/docs/evaluations-history` keeps the September 19–20 form-action
run. The homepage links a dated 0.9.0 module integration record
(`site/data/sys1-0.9-module-proof.json`); no script regenerates it.
The broader frozen fixtures show poor Qwen quality; a direct Laya MLX
candidate study reached 30/72 and remains outside the shipped runtime; local inference remains
experimental. Jev has a completed 20-case result; a broader attempt failed
authentication and is not quality evidence. No customer adoption count or testimonial is supplied. Illustrative page
examples must be labelled as such.

## Public copy

Public copy follows `STYLE.md` and `WRITING.md` in this repository, synced from
hraness/.github. Design briefs in `.impeccable/surfaces/` follow the same
guides; update a brief in the same change as its page.

- The one-line description is the canonical portfolio messaging record:
  “Sys1 lets agents ask yes/no, choice, and score questions and get validated
  answers with probabilities from hosted Jev, a local model, or your own
  server.” After the product name (“Sys1: …”, “sys1: …”), use the short form:
  “lets agents ask yes/no, choice, and score questions and get answers”.
  Shorten by cutting words, not by substituting internal ones.
- Write the name as Sys1 in prose. Use `sys1` only for the command, the package
  scope, and the sys1.io domain. The registry's all-caps display (SYS1) is not a
  prose spelling.
- Introduce Jev at its first mention on a page as TypeSafe's hosted decision
  model.
- State status once near the top of a page: local Qwen is experimental and
  hosted Jev is opt-in. Put any other limit beside the feature it limits.
- The vocabulary of `AGENTS.md` and these briefs (boundary, contract,
  qualification, admission, surface, pilot, lifecycle, owns) is internal. On a
  public page, say what the reader gets instead.
- Headings name the section's topic or the reader's task. Do not write two-part
  slogan headings, maxim closers, or copy that explains how the site is
  organized.
- Every HTML file under `site/` carries its own copy of the primary nav. Keep
  one nav on every page: How it works, Docs, Compare, Skills, GitHub.
- Label a historical measurement with its date and version, and link its
  record. Do not call a record reproducible unless a script in this repository
  regenerates it.
