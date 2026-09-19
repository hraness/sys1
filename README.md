# sysone

sysone is a local System One gateway for coding agents. It runs a small
daemon on your machine that exposes a Jev-compatible decisions endpoint
(`POST /v1/systemone`) and routes each request across the System One models
you can actually reach: hosted Jev when you have a key, or a local Jev-like
model — OpenJev, NanoJev, Mini-Jev and friends — when you do not, or when you
ask for one.

[Project site](https://sysone.dev) · [Protocol](#the-endpoint) · [Routing](#routing)

System One models take a `state` and a set of typed questions — `noul`
(yes/no probability), `choice` (one option from a set), `score` (a position
on an ordered scale) — and return calibrated answers instead of generated
text. They are cheap and fast, which makes them good routing, guardrail, and
triage primitives inside agent loops. sysone gives every agent on your
machine one loopback endpoint for those calls, independent of which backend
answers.

## Install

Requires Bun ≥ 1.3.14.

```sh
git clone https://github.com/hraness/sysone.git
cd sysone
bun install
bun run build:dist
```

Then put `dist/cli.js` on your PATH (or run `bun src/cli.ts …` directly):

```sh
ln -sf "$PWD/dist/cli.js" ~/.local/bin/sysone
```

## Quickstart

```sh
export TYPESAFE_API_KEY=…        # enables the hosted Jev backend
sysone up                        # starts the daemon on 127.0.0.1:13900
sysone status                    # daemon state + backend reachability
```

Point any Jev client at `http://127.0.0.1:13900` — the wire shape is
TypeSafe's System One API. Or send one from the CLI:

```sh
sysone eval <<'EOF'
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "urgent": { "type": "noul", "instructions": "Does this convey urgency?" }
  }
}
EOF
```

## The endpoint

| Route | Purpose |
| --- | --- |
| `POST /v1/systemone` | Evaluate `{model?, state, questions}`; answers pass through from the chosen backend |
| `GET /v1/models` | Aggregate model list across backends, with reachability |
| `GET /healthz` | Liveness for the daemon itself |

Responses carry `x-sysone-backend` naming the backend that answered and
`x-sysone-attempts` counting transport-failure retries. A backend that
returned any HTTP response — including 4xx/5xx — is definitive and is never
retried elsewhere; a request is only re-dispatched when no response arrived
at all, at most once, and only for unpinned models.

## Routing

`routing.policy` in `~/.sysone/config.json`:

| Policy | Order tried |
| --- | --- |
| `auto` (default) | hosted Jev, then local backends cheapest-and-smallest first |
| `prefer-local` | local backends cheapest-and-smallest first, then hosted Jev |
| `prefer-hosted` | hosted Jev, then local |
| `local-only` | local backends only |
| `hosted-only` | hosted Jev only |

"Cheapest smallest" orders local backends by `size_b` then `cost_rank`, both
set at `sysone backend add` time. A request may pin a model two ways:

- `"model": "openjev-4b"` — any backend serving that id, in policy order
- `"model": "openjev/openjev-4b"` — exactly that backend; never rerouted

## Local backends

A local backend is any HTTP service on your machine that answers the same
two routes — `POST /v1/systemone` and `GET /v1/models`. Register one per
running model:

```sh
sysone backend add --name openjev --url http://127.0.0.1:8080 --model openjev-4b --size-b 4
sysone backend add --name nanojev --url http://127.0.0.1:8081 --model nanojev-0.6b --size-b 0.6
```

sysone probes each backend's `GET /v1/models` before routing, caches nothing
between requests, and treats a failed probe as unavailable. The daemon does
not install, download, or run model weights in this release — local runners
are separate processes you own.

## Commands

```text
sysone up|down|serve|status|models|eval
sysone backend list|add|remove
sysone config path|get|set|unset
sysone --version|--help
```

`status`, `models`, `backend list`, `up`, and `down` accept `--json` for
machine-readable output. Data goes to stdout, diagnostics to stderr.

## Configuration

`~/.sysone/config.json` (`SYSONE_HOME` overrides the directory; `config path`
prints it). Keys settable via `sysone config set`:

- `routing.policy` — table above
- `gateway.host`, `gateway.port` — bind address (loopback by default; keep it there)
- `gateway.request_timeout_ms`, `gateway.probe_timeout_ms`
- `hosted.enabled`, `hosted.base_url`, `hosted.model`, `hosted.api_key_env`

The hosted credential is read from the environment (`TYPESAFE_API_KEY` by
default) — never from the config file.

## Status

Early. Implemented: the daemon, the gateway endpoint, request validation,
the routing policies above, reachability probing, one bounded retry on
transport failure, and the CLI surface. Not implemented: installing or
running local model weights, non-loopback binding, request authentication,
and streaming. Hosted Jev is a pass-through to TypeSafe's API; sysone does
not qualify or modify those answers.

## Development

```sh
bun install
bun run check   # typecheck + tests + dist build + package smoke check
```

See `AGENTS.md` for repository rules and `CONTRIBUTING.md` for the house
conventions.
