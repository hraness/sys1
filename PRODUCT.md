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
- Explicitly installed local GGUF models run through node-llama-cpp. Optional
  CUA-S1 form-action scoring and Cactus Needle extraction are pinned specialists.
- Local inference is enabled and hosted Jev is disabled in fresh config.
  Hosted activation and model downloads require explicit setup.
- Routing policy, capability checks, cancellation, request-matched response
  validation, and local model lifecycle belong to Sys1. Application policy,
  permissions, quality thresholds, and deterministic fallback stay in the app.
- A compatible response schema does not establish equal calibration, model
  quality, speed, or cost. No comparative model benchmark is claimed.
- MIT source and npm-format immutable GitHub Release artifacts are available.

## Brand Commitments

The name is Sys1 and the domain is sys1.io. The user explicitly requested the
general Hraness design system, using peopleblade.com as the visual reference.
Explain the value and features plainly, and accurately distinguish Sys1's
role from Jev, OpenJev, CUA-S1, and its underlying model runtimes.

## Evidence on Hand

README.md, source, docs/DESIGN.md (runtime architecture), release workflows,
and deterministic/native-install checks document implemented capabilities.
No comparative inference benchmark, customer adoption count, or testimonial
is supplied. Illustrative page examples must be labelled as such.
