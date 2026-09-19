# Contents

- `src/protocol.ts` owns the System One wire format: request/response schemas,
  body and field bounds, and the shared error envelope.
- `src/config.ts` owns the `~/.sysone/config.json` schema, defaults, load/save,
  and the settable-key registry. `SYSONE_HOME` overrides the state directory.
- `src/router.ts` owns backend selection as a pure function over probed
  candidates — policy order, model pinning, cheapest-smallest local order.
- `src/backends.ts` owns runtime backends: the hosted Jev backend (credential
  from the environment only), configured local backends, bounded probing, and
  request forwarding.
- `src/gateway.ts` owns the loopback HTTP surface (`POST /v1/systemone`,
  `GET /v1/models`, `GET /healthz`), request validation, and the bounded
  retry loop.
- `src/daemon.ts` owns the pid file, detached spawn, health checks, and
  stop/status lifecycle.
- `src/cli.ts` owns the `sysone` command surface and exit codes.
- `src/index.ts` is the package's complete public surface.
- `test/` contains schema, routing-policy, config, and gateway tests against
  stubbed backends; no test touches the network or a real credential.
- `scripts/` holds the dist build and the packed-package smoke check.
- `site/` is the static sysone.dev landing page; it has no product-runtime
  connection.
- `.github/workflows/` holds the read-only CI check.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` are the public
  contract.

# Guidelines

- Use Bun 1.3.14. Run `bun run check` before handoff: strict typecheck,
  tests, dist build, and packed-package smoke check.
- Keep the gateway loopback-only by default. Do not add non-loopback binding,
  request authentication, or remote state without an explicit design change.
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
- sysone routes and forwards; it does not install, download, or execute
  model weights, and it does not modify backend answers. Local runners stay
  separate processes the operator owns.
- Keep the public repository independently buildable. No sibling checkouts,
  private packages, internal project names, or unpublished provenance.
