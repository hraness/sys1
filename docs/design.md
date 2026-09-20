# Sys1 design

One bounded loopback endpoint for System One decisions, whichever explicitly selected
backend answers.

## Product boundary

Applications own domain criteria, action permissions, quality thresholds, and
fallback behavior. Sys1 owns transport, routing policy, bounded schema
validation, and the lifecycle of explicitly installed local models. Wire shape
compatibility does not imply equal calibration or application quality.

The normal route is hosted Jev 1.13.0 when enabled, with local Qwen3 1.7B as
the selected local model. The configured `local.model` determines the only
installed model eligible for unpinned requests. Other installed GGUF models
and operator-registered HTTP services require explicit selection.

The portable `@hraness/sys1/client` entry exports the typed HTTP client and
protocol schemas. It runs on Node 24 and Bun without loading the optional
native runtime. The root entry supplies a Bun `createRouter` with explicit
configuration, no listening socket, and a required disposal lifecycle. The CLI
and daemon are another frontend to the same gateway handler. Rust and other
language clients use the HTTP contract directly.

## Components

- **Client** (`src/client.ts`) bounds requests and responses, propagates aborts,
  validates request-correlated answers, and returns routing metadata without
  retries or implicit credentials.
- **Embedded runtime** (`src/runtime.ts`) owns a gateway handler and local
  runner, exposing `evaluate`, `fetch`, and `dispose` without binding a port.
- **Protocol** (`src/protocol.ts`) validates the System One request envelope and
  bounds bodies, state, question counts, options, levels, and strings.
- **Gateway** (`src/gateway.ts`) serves `POST /v1/systemone`, `GET /v1/models`,
  and `GET /healthz` with Bun.
- **Router** (`src/router.ts`) is a pure policy and model-selection function over
  probed candidates, their capability limits, and explicit-selection flags.
- **Backends** (`src/backends.ts`) adapts hosted Jev, operator-registered HTTP
  services, and installed builtin models into router candidates, and merges
  advisory `GET /v1/limits` responses into routing capabilities.
- **Defaults** (`src/defaults.ts`) maps supported OS/architecture targets to
  experimental Qwen3 1.7B by default, or experimental Qwen3 0.6B when explicitly requested.
- **Qualification** (`src/qualification.ts`) checks discovery, published limits,
  and all three answer shapes for operator-owned HTTP services.
- **Decision adapter** (`src/local/decide.ts`) renders bounded prompts and maps a
  full first-token vocabulary distribution into noul, choice, and score answers.
- **Engine** (`src/local/engine.ts`) lazily owns a warm worker process with
  one node-llama-cpp model/context. Abort, timeout, and disposal terminate and
  collect that worker; native evaluation cannot strand the parent queue.
- **Model store** (`src/local/store.ts`) owns the curated registry, streamed
  Hugging Face downloads, SHA-256 and bounded GGUF structural admission,
  safe manifest filenames, verification, and the 8 GiB per-download limit.
- **Doctor** (`src/doctor.ts`) reports a stable versioned readiness surface over
  runtime, config, native llama.cpp, store, routing, and daemon boundaries.
- **Local runner** (`src/local/runner.ts`) marks the selected installed model
  for unpinned routing, caps resident GGUF engines, and produces the wire
  response with its adapter identity.
- **Daemon** (`src/daemon.ts`) owns detached process, pid file, health check,
  log, and stop lifecycle. Authenticated per-instance shutdown never signals a
  saved PID whose ownership may have changed.

## Request flow

1. Bound and parse the body, then validate it as a System One request.
2. Re-read config and enumerate credential-backed hosted, configured HTTP, and
   installed builtin candidates.
3. Probe policy-eligible HTTP candidates in parallel; merge any `/v1/limits`
   capabilities. Builtin candidates are available when their admitted GGUF
   artifact exists.
4. Compute request needs (largest option count, question count) and select with
   `chooseBackend` using policy, model id, or exact backend/model pinning.
   Other installed models and configured HTTP services are skipped unless
   explicitly selected; over-capability candidates are
   skipped, and a request no backend can serve fails as `request_unsupported`.
5. Forward hosted/HTTP calls with the resolved model id and a bounded deadline.
   Any HTTP response is definitive, including failures while reading its body;
   only failure before receiving headers can retry once. Validate successful
   answers against the original questions before returning them.
6. For a builtin candidate, lazily load llama.cpp and evaluate each question
   at its answer position with full-vocabulary probabilities.
7. Map the adapter output to the exact Jev answer shape. Adapter identity and
   diagnostics remain in `x-sys1-local-*` response headers.

## Generic GGUF semantics

Builtin inference is an adapter for general GGUF language models, not a claim
that those weights are trained System One models. Each question is independent:

- noul constrains the first answer token to YES/NO mass;
- choice presents unique one-character labels and supports up to 35 options;
- score presents ordered levels with unique one-character labels.

Mass is renormalized across allowed labels for the answer distribution. Noul is
probability of yes; Choice selects the highest-probability option; Score is the
zero-based probability-weighted expected level with an exact legend. Choice and
Score confidence uses concentration above a uniform distribution. Batch-minimum
coverage and concentration are exposed as `x-sys1-local-*` headers so the Jev
answer objects stay schema-compatible. Neither metric is a calibration guarantee.

The runner is node-llama-cpp rather than a wasm runner. It exposes the complete
vocabulary distribution needed for label-mass aggregation, lets llama.cpp
select the available platform backend, and runs under Bun. Weights are loaded
only after explicit `sys1 setup` or `sys1 pull`; CI substitutes the engine
boundary and never downloads a model.

Adapter bounds reject oversized fields instead of silently truncating evidence.
The generic adapter permits 6,000 state characters, 2,000 instruction characters,
96 characters per option name/criterion, and 16,000 rendered prompt characters.
Oversized local inputs fail without being redispatched to a hosted backend.

## Model admission and lifecycle

The curated GGUF registry records model id, source repository/file and immutable
revision, byte count, parameter count, context limit, and SHA-256. Pull writes
`*.download` temporaries, hashes each chunk, checks size and digest, validates
GGUF magic/version/counts, atomically renames, then atomically updates
`manifest.json`.
Manifest filenames are store-local and regular files only. A failed or
interrupted pull is never listed as installed.

Legacy scorer/Needle inventories fail closed without rewriting the manifest or
removing files. The diagnostic directs the operator to a new `SYS1_HOME`.

The daemon defaults to one resident model. Evaluations are serialized across
the whole runner. Loading another engine evicts and disposes the least recently
used resident. Shutdown disposes every model/context. The store and inference
queues are local only; request state and answers are never written there.

## Local-first defaults and hosted Jev

Fresh config enables local inference, sets `local.model` to `qwen3-1.7b`, uses
`auto` routing, and keeps hosted Jev disabled even when its credential variable
exists. The default hosted model is `jev-1.13.0`. `sys1 jev enable` requires
the environment credential, persists only the activation flag, and switches to
`hosted-only`; `jev disable` repairs `hosted-only` back to `auto`. Credentials never
enter config, output, pid files, or logs.

Local fallback requires an explicit policy change after application evaluation.
`setup` installs/selects a local model without changing an existing hosted-only
policy. When explicitly selected, `auto` prefers enabled hosted Jev, then the selected installed local model;
`prefer-local` reverses that order. Installing another model or registering an
HTTP service does not add an automatic fallback. Bare model IDs and exact
`backend/model` pins explicitly select those candidates, subject to the routing
policy and capability limits. A missing selected local model never promotes a
different installed model. Sys1 does not infer quality from model size or choose
a new local default based on available memory.

`sys1 setup` is an explicit download boundary. The supported target table
covers macOS, Linux, and Windows on x64/ARM64. llama.cpp auto-selects Metal,
CUDA, Vulkan, or CPU where packaged. Setup installs and selects Qwen3 1.7B by
default. `--tier compact` explicitly selects experimental Qwen3 0.6B;
`--tier quality` selects Qwen3 1.7B. Setup persists its choice in `local.model`
only after the model is available; unsupported targets fail before download.
`sys1 pull` installs an artifact without changing this selection.

`backend check` remains explicit and bounded. It requests `/v1/models` and
`/v1/limits`, then sends one fixed synthetic request containing Noul, Choice,
and Score. Every response body is capped at 4 MiB and parsed from `unknown`.
The decision response must satisfy the official schema, preserve the requested
answer types, normalize Choice/Score distributions, and keep Score equal to its
probability-weighted levels. Reports contain status and bounded diagnostics,
never the synthetic request or provider response body.

## Distribution

The build preserves exactly one Bun shebang and emits an npm-format ESM package.
The package smoke check unpacks the real tarball into an isolated consumer,
links only the exact pinned dependencies from the frozen install, imports the
public API, and executes version, help, and JSON CLI surfaces. Stable annotated
tags trigger a release only at the exact current `main` head. Exact tarball
bytes and `SHA256SUMS` must pass Ubuntu, macOS, and Windows installation before
an immutable GitHub Release can be published.

## Boundaries

- Gateway binds are restricted to loopback; there is no request authentication.
- Hosted credentials are environment-only.
- Request states, questions, prompts, distributions, and answers are absent from
  logs, pid files, config, and model manifests. The GGUF worker receives requests
  through private pipes.
- Downloads occur only from an explicit CLI command, are capped, and require a
  registry pin, publisher LFS digest, or user-supplied SHA-256.
- No ordinary test or package artifact includes model weights.
- External backend processes remain operator-owned.
