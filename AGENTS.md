# Contents

- `src/protocol.ts` owns the System One wire format: request/response schemas,
  body and field bounds, and the shared error envelope.
- `src/config.ts` owns the `~/.sysone/config.json` schema, defaults, load/save,
  and the settable-key registry. `SYSONE_HOME` overrides the state directory.
- `src/router.ts` owns backend selection as a pure function over probed
  candidates — policy order, model pinning, cheapest-smallest local order,
  capability limits, and specialist exclusion from unpinned fallback.
- `src/backends.ts` owns runtime backends: hosted Jev (credential from the
  environment only), configured HTTP services, installed builtin candidates,
  bounded probing (including advisory `GET /v1/limits`), and request
  forwarding.
- `src/defaults.ts` owns qualified platform targets and deterministic compact
  versus quality local-model recommendations.
- `src/qualification.ts` owns bounded conformance checks for operator-configured
  System One HTTP backends.
- `src/local/decide.ts` owns bounded generic-GGUF prompts and the pure mapping
  from vocabulary probability mass to System One answers.
- `src/local/engine.ts` owns the lazy node-llama-cpp lifecycle and serialized
  first-token distribution evaluation.
- `src/local/torchckpt.ts` owns the bounded ZIP reader, restricted pickle
  interpreter, and tensor materialization for `torch.save` checkpoints.
- `src/local/scorer.ts` owns the pure-TypeScript CUA-S1 tiny/tinyx option
  scorer: checkpoint config validation and the forward pass.
- `src/local/needle.ts` owns the bounded per-request Cactus Needle engine
  process: tools/prompt bounds, telemetry disabled, validated JSON turns.
- `src/local/adapt.ts` owns the System One ↔ scorer/Needle contract mappings
  and the disclosed needle-extract probability approximation.
- `src/local/store.ts` owns the curated model registry, the SHA-256-admitted
  multi-kind store (`gguf`, `scorer`, `needle` + engine companion), manifest,
  download limits, structural validation, verification, and removal.
- `src/local/runner.ts` owns builtin candidate enumeration, engine/scorer
  residency, per-kind dispatch, and local response assembly.
- `src/gateway.ts` owns the loopback HTTP surface (`POST /v1/systemone`,
  `GET /v1/models`, `GET /healthz`), request validation, and the bounded
  retry loop.
- `src/daemon.ts` owns the pid file, detached spawn, health checks, and
  stop/status lifecycle.
- `src/doctor.ts` owns the stable versioned readiness report. Keep checks
  bounded, read-only, credential-free, and additive by id.
- `src/cli.ts` owns the `sysone` command surface and exit codes.
- `src/index.ts` is the package's complete public surface.
- `test/` contains protocol, routing, config, gateway, model-store, decision,
  and fake-engine tests; no ordinary test downloads weights, touches the
  network, or uses a real credential.
- `scripts/` holds the dist build, isolated exact-tarball package smoke, and
  cross-platform release install verification.
- `site/` is the static sysone.dev landing page; it has no product-runtime
  connection.
- `.github/workflows/check.yml` is read-only CI. `release.yml` is the annotated
  stable-tag channel for exact cross-platform artifacts and immutable GitHub
  Releases; it does not publish npm.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` are the public
  contract.

# Guidelines

- Use Bun 1.3.14. Run `bun run check` before handoff: strict typecheck,
  tests, dist build, and packed-package smoke check.
- Keep the gateway loopback-only. Config must reject non-loopback binding. Do
  not add remote state without an explicit authenticated design change.
- Read the hosted credential from the environment only. Never persist keys,
  log them, or put them in the config file, `--json` output, or error bodies.
- Never log or persist request `state`, `questions`, or answer bodies; log
  routing metadata only.
- Parse every foreign value from `unknown` through the protocol schemas.
  Bound every input: body bytes, state bytes, question counts, options,
  timeouts, probes, and retry count.
- A backend that returned any HTTP response is definitive; only transport
  failures (no response) may re-dispatch, at most once, and never for a
  `backend/model` pinned request. Surface retries via `x-sysone-attempts`.
- Keep `--json` stable and machine-readable; additive fields only. Data to
  stdout, diagnostics to stderr, closed exit codes.
- Download weights only from explicit `sysone setup` or `sysone pull`; cap
  size, require a trusted SHA-256, stream to a temporary file, and admit only
  after digest, size, per-kind bounded structure (GGUF header, restricted
  torch checkpoint, `.cact` header/directory), safe filename, and regular-file
  checks. Needle entries also verify their platform engine companion the same
  way. Never put weights in git, release artifacts, or ordinary CI.
- Treat generic-GGUF answers as an approximation, not calibrated Jev output.
  Scorer and needle adapters disclose their contracts via `x-sysone-local-*`
  adapter headers; needle probabilities are a confidence-derived
  approximation, not per-option distributions. Keep Noul/Choice/Score answer
  objects exactly Jev-compatible. Do not make stronger model-quality claims
  without checkpoint-specific qualification.
- Keep local inference lazy, per-model serialized, cancellation-bounded, and
  residency-capped. Needle runs one bounded process per request with
  telemetry disabled. Dispose native contexts on eviction and shutdown.
- Specialist models (scorer, needle) never receive unpinned fallback traffic;
  honor published backend capability limits (`/v1/limits`) as advisory, and
  fail over-capability requests closed as `request_unsupported`.
- Keep operator-registered HTTP runners separately owned; never mutate their
  weights, credentials, or process lifecycle. Qualify discovery, limits, and
  response conformance without exposing request or response bodies.
- Fresh config is local-first: hosted Jev stays disabled even when its
  environment credential exists. Only `sysone jev enable` activates it; the
  credential remains environment-only.
- Releases use one annotated `v<version>` tag at exact current `main`. Preserve
  exact tarball/checksum identity, Ubuntu/macOS/Windows artifact execution,
  repository release immutability, and the no-npm-publication boundary.
- Keep the public repository independently buildable. No sibling checkouts,
  private packages, internal project names, or unpublished provenance.
