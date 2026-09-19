# sysone design

One bounded loopback endpoint for System One decisions, whichever qualified
backend answers.

## Components

- **Protocol** (`src/protocol.ts`) validates the System One request envelope and
  bounds bodies, state, question counts, options, levels, and strings.
- **Gateway** (`src/gateway.ts`) serves `POST /v1/systemone`, `GET /v1/models`,
  and `GET /healthz` with Bun.
- **Router** (`src/router.ts`) is a pure policy and model-selection function over
  probed candidates, their capability limits, and specialist flags.
- **Backends** (`src/backends.ts`) adapts hosted Jev, operator-registered HTTP
  services, and installed builtin models into router candidates, and merges
  advisory `GET /v1/limits` responses into routing capabilities.
- **Decision adapter** (`src/local/decide.ts`) renders bounded prompts and maps a
  full first-token vocabulary distribution into noul, choice, and score answers.
- **Engine** (`src/local/engine.ts`) lazily owns one node-llama-cpp model/context,
  serializes evaluations, enforces evaluation timeouts, and releases native
  resources.
- **Torch checkpoint reader** (`src/local/torchckpt.ts`) parses `torch.save`
  archives in-process: a bounded ZIP reader, a restricted pickle interpreter
  (no arbitrary globals), and Float32 tensor materialization.
- **Option scorer** (`src/local/scorer.ts`) is a pure-TypeScript port of the
  CUA-S1 tiny/tinyx architecture — byte-level context plus per-option attention
  in a single forward pass — verified to float32 parity against PyTorch.
- **Needle engine** (`src/local/needle.ts`) spawns one bounded Cactus Needle
  process per request with telemetry disabled, bounded stdout, validated JSON
  turn shapes, and cleanup of its temporary tools file.
- **Engine adapters** (`src/local/adapt.ts`) map System One questions onto the
  scorer's (context, options) contract and the needle `evaluate` tool schema,
  and map their outputs back to official answer shapes.
- **Model store** (`src/local/store.ts`) owns the curated registry, streamed
  Hugging Face downloads, SHA-256 and per-kind structural admission (GGUF
  header, restricted torch checkpoint, `.cact` geometry), platform engine
  companions, safe manifest filenames, verification, and the 8 GiB
  per-download limit.
- **Doctor** (`src/doctor.ts`) reports a stable versioned readiness surface over
  runtime, config, native llama.cpp, store, routing, and daemon boundaries.
- **Local runner** (`src/local/runner.ts`) joins installed models to their
  per-kind runtime, caps resident engines and scorers, and produces the wire
  response with an adapter identity.
- **Daemon** (`src/daemon.ts`) owns detached process, pid file, health check,
  log, and stop lifecycle.

## Request flow

1. Bound and parse the body, then validate it as a System One request.
2. Re-read config and enumerate credential-backed hosted, configured HTTP, and
   installed builtin candidates.
3. Probe HTTP candidates in parallel; merge any `/v1/limits` capabilities.
   Builtin candidates are available when their admitted artifact (and engine
   companion, for needle) exists.
4. Compute request needs (largest option count, question count) and select with
   `chooseBackend` using policy, model id, or exact backend/model pinning.
   Specialists are skipped unless pinned; over-capability candidates are
   skipped, and a request no backend can serve fails as `request_unsupported`.
5. Forward hosted/HTTP calls unchanged except for resolved model id. Any HTTP
   response is definitive; only transport failure can retry once.
6. For a builtin candidate, dispatch on model kind:
   - `gguf`: lazily load llama.cpp and evaluate each question at its answer
     position with full-vocabulary probabilities;
   - `scorer`: load the checkpoint once into the resident pure-TypeScript
     scorer and evaluate (context, options) per question;
   - `needle`: spawn one bounded engine process per request, feed the
     `evaluate` tool schema, and parse the validated JSON turn.
7. Map the adapter output to the exact Jev answer shape. Adapter identity and
   diagnostics remain in `x-sysone-local-*` response headers.

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
coverage and concentration are exposed as `x-sysone-local-*` headers so the Jev
answer objects stay schema-compatible. Neither metric is a calibration guarantee.

The runner is node-llama-cpp rather than a wasm runner. It exposes the complete
vocabulary distribution needed for label-mass aggregation, lets llama.cpp
select the available platform backend, and runs under Bun. Weights are loaded
only after an explicit `sysone pull`; CI substitutes the engine boundary and
never downloads a model.

## Option-scorer semantics

`scorer` checkpoints (CUA-S1 tiny/tinyx) run a native option-attention contract:
a byte-level context string plus up to 26 option strings, one forward pass,
per-option probabilities — a real distribution, not label-mass approximation.
Questions map to options as: noul → `[true-label, false-label]`, choice →
criterion keys with descriptions, score → indexed level descriptions. The
checkpoint is a form-action specialist (`fill`/`check`/`click`/`skip` actions
trained on web-form states), so it is pin-only and never a fallback. The port
is pure TypeScript over a restricted `torch.save` reader — no Python, no
native runtime — verified against PyTorch to ~2e-8 absolute difference.

## Needle semantics

`needle` models pair a `.cact` weights blob with a platform-specific engine
binary from the same registry pin. Each request writes a bounded temporary
tools file (one `evaluate` tool whose arguments are the request's questions),
spawns the engine with `NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`, and
`HF_HUB_OFFLINE=1`, bounds stdout, parses only validated JSON, kills on
timeout/abort, and removes the temp file. Needle's grounding gate can withhold
calls, and it emits a calibrated turn confidence rather than per-option
distributions — so extracted values are reported with a disclosed
approximation (`confidence` on the pick, remainder uniform) under the
`needle-extract` adapter id, and suppressed/malformed turns fail closed.
Like scorers, needle models are specialists.

## Model admission and lifecycle

The curated registry records model id, kind, source repository/file, byte
count, parameter count, context limit, and SHA-256 — plus, for needle,
per-platform engine binary pins. Pull writes `*.download` temporaries, hashes
each chunk, checks size and digest, validates kind-specific structure (GGUF
magic/version/counts, restricted torch checkpoint schema, `.cact` tag and
directory geometry), atomically renames, then atomically updates
`manifest.json`. Needle pulls download and verify the matching engine binary
the same way; `model remove` and `model verify` handle both artifacts.
Manifest filenames are store-local and regular files only. A failed or
interrupted pull is never listed as installed.

The daemon defaults to one resident model. Evaluations are serialized across
the whole runner. Loading another engine or scorer evicts and disposes the
least recently used resident. Needle spawns per request and holds no
residency. Shutdown disposes every model/context. The store and inference
queues are local only; request state and answers are never written there.

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
