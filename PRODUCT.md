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
The comparison page adds an opt-in public synthetic local adapter benchmark
and primary-source upstream measurements, each with its own scope and limits.
The broader frozen fixtures show poor Qwen quality; a direct Laya MLX
candidate study reached 30/72 and remains outside the shipped runtime; local inference remains
experimental. Jev has a completed 20-case result; a broader attempt failed
authentication and is not quality evidence. No customer adoption count or testimonial is supplied. Illustrative page
examples must be labelled as such.
