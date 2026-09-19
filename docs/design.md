# sysone design

One loopback endpoint for System One decisions, whichever backend answers.

## Pieces

- **Gateway** (`src/gateway.ts`) — `Bun.serve` on the configured host/port.
  Routes: `POST /v1/systemone`, `GET /v1/models`, `GET /healthz`. Everything
  else is 404.
- **Router** (`src/router.ts`) — pure function from `(policy, requested model,
  probed candidates)` to one backend or a typed failure. Probing happens in
  the gateway, never inside the router.
- **Backends** (`src/backends.ts`) — `typesafe` (hosted Jev; exists only when
  enabled *and* the configured env var holds a key) plus operator-registered
  local backends. A local backend is any HTTP service answering the same two
  routes.
- **Daemon** (`src/daemon.ts`) — a detached `sysone serve` child, a pid file
  at `$SYSONE_HOME/daemon.json`, and a log at `daemon.log`. `up` polls the
  pid file + `/healthz`; `down` signals the recorded pid only.

## Request flow

1. Bound the body (1 MiB) and parse JSON.
2. Validate against `systemOneRequestSchema` (question types, option and
   level counts, 256 KiB state cap).
3. Probe every configured backend's `GET /v1/models` in parallel
   (`probe_timeout_ms`).
4. `chooseBackend` picks per policy + requested model; forward with the
   backend's resolved model id (`backend/model` strips the prefix,
   absent/`auto` uses the backend's configured default).
5. Any HTTP response passes through verbatim with `x-sysone-backend` /
   `x-sysone-attempts` headers. A transport failure drops that backend and
   retries once — never for a pinned `backend/model` request.

## Boundaries

- Loopback bind by default; no auth — same-machine agents only.
- Credential lives in the environment, never the config file.
- No request/answer bodies in logs, digests, or `--json`.
- No model downloads or weight execution; local runners are separate
  operator-owned processes.
