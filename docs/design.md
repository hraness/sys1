# sysone design

One bounded loopback endpoint for System One decisions, whichever qualified
backend answers.

## Components

- **Protocol** (`src/protocol.ts`) validates the System One request envelope and
  bounds bodies, state, question counts, options, levels, and strings.
- **Gateway** (`src/gateway.ts`) serves `POST /v1/systemone`, `GET /v1/models`,
  and `GET /healthz` with Bun.
- **Router** (`src/router.ts`) is a pure policy and model-selection function over
  probed candidates.
- **Backends** (`src/backends.ts`) adapts hosted Jev, operator-registered HTTP
  services, and installed builtin GGUF models into router candidates.
- **Decision adapter** (`src/local/decide.ts`) renders bounded prompts and maps a
  full first-token vocabulary distribution into noul, choice, and score answers.
- **Engine** (`src/local/engine.ts`) lazily owns one node-llama-cpp model/context,
  serializes evaluations, enforces evaluation timeouts, and releases native
  resources.
- **Model store** (`src/local/store.ts`) owns the curated registry, streamed
  Hugging Face downloads, SHA-256 and structural GGUF admission, safe manifest
  filenames, verification, and the 8 GiB per-download limit.
- **Doctor** (`src/doctor.ts`) reports a stable versioned readiness surface over
  runtime, config, native llama.cpp, store, routing, and daemon boundaries.
- **Local runner** (`src/local/runner.ts`) joins installed models to engines,
  caps resident models, and produces the wire response.
- **Daemon** (`src/daemon.ts`) owns detached process, pid file, health check,
  log, and stop lifecycle.

## Request flow

1. Bound and parse the body, then validate it as a System One request.
2. Re-read config and enumerate credential-backed hosted, configured HTTP, and
   installed builtin candidates.
3. Probe HTTP candidates in parallel. Builtin candidates are available when
   their admitted GGUF file exists.
4. Select with `chooseBackend` using policy, model id, or exact backend/model
   pinning.
5. Forward hosted/HTTP calls unchanged except for resolved model id. Any HTTP
   response is definitive; only transport failure can retry once.
6. For a builtin candidate, lazily load llama.cpp and evaluate each question at
   its answer position with full-vocabulary probabilities.
7. Aggregate allowed-label probability mass, return a Jev-style answer, and add
   `confidence` plus `coverage` diagnostics.

## Generic GGUF semantics

Builtin inference is an adapter for general GGUF language models, not a claim
that those weights are trained System One models. Each question is independent:

- noul constrains the first answer token to YES/NO mass;
- choice presents unique one-character labels and supports up to 35 options;
- score presents ordered levels with unique one-character labels.

Mass is renormalized across allowed labels for the answer distribution.
`coverage` preserves how much total vocabulary mass the model assigned to any
allowed label, so instruction-following failure remains visible. `confidence`
measures concentration above a uniform choice. Neither value is a calibration
guarantee.

The runner is node-llama-cpp rather than a wasm runner. It exposes the complete
vocabulary distribution needed for label-mass aggregation, lets llama.cpp
select the available platform backend, and runs under Bun. Weights are loaded
only after an explicit `sysone pull`; CI substitutes the engine boundary and
never downloads a model.

## Model admission and lifecycle

The curated registry records model id, source repository/file, byte count,
parameter count, context limit, and SHA-256. Pull writes `<id>.gguf.download`,
hashes each chunk, checks size and digest, validates GGUF magic, version, tensor
count, and metadata count, atomically renames it to `<id>.gguf`, then atomically
updates `manifest.json`. Manifest filenames are store-local and regular files
only. A failed or interrupted pull is never listed as installed.

The daemon defaults to one resident model. Evaluations are serialized per
engine. Loading another model evicts and disposes the least recently used
engine. Shutdown disposes every model/context. The store and inference queues
are local only; request state and answers are never written there.

## Distribution

The build preserves exactly one Bun shebang and emits an npm-format ESM package.
The package smoke check unpacks the real tarball into an isolated consumer,
links only the exact pinned dependencies from the frozen install, imports the
public API, and executes version, help, and JSON CLI surfaces. Stable annotated
tags trigger a release only at the exact current `main` head. Exact tarball
bytes and `SHA256SUMS` must pass Ubuntu and macOS installation before an
immutable GitHub Release can be published.

## Boundaries

- Gateway binds are restricted to loopback; there is no request authentication.
- Hosted credentials are environment-only.
- Request states, questions, prompts, distributions, and answers are absent from
  logs, pid files, config, and model manifests.
- Downloads occur only from an explicit CLI command, are capped, and require a
  registry pin, publisher LFS digest, or user-supplied SHA-256.
- No ordinary test or package artifact includes model weights.
- External backend processes remain operator-owned.
