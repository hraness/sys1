# sysone

sysone is a local System One gateway for coding agents. It runs one loopback
daemon, exposes a Jev-compatible `POST /v1/systemone` endpoint, and routes each
request across hosted Jev, builtin local GGUF models, and operator-run System
One HTTP backends.

[Project site](https://sysone.dev) · [Protocol](#the-endpoint) · [Routing](#routing)

System One calls ask typed questions about a state instead of generating prose:
`noul` for yes/no probability, `choice` for one bounded option, and `score` for
an ordered level. They fit routing, guardrail, review, and triage decisions
inside agent loops. sysone gives every local agent the same endpoint regardless
of which model answers.

## Install

Requires Bun 1.3.14 or newer. The canonical package is the SHA-256-listed
artifact on the immutable GitHub Release. The install grants postinstall only
to the exact pinned native dependency; the resulting `sysone` executable runs
with Bun.

```sh
npm install --global --allow-scripts=node-llama-cpp \
  https://github.com/hraness/sysone/releases/download/v0.5.0/hraness-sysone-0.5.0.tgz
sysone doctor
```

To build the current source instead:

```sh
git clone https://github.com/hraness/sysone.git
cd sysone
bun install
bun run build:dist
ln -sf "$PWD/dist/cli.js" ~/.local/bin/sysone
```

## Quickstart: entirely local

```sh
sysone pull       # downloads + sha256-verifies Qwen3 0.6B Q4_0 (365 MiB)
sysone up         # starts the gateway on 127.0.0.1:13900
sysone status
```

Send a decision:

```sh
sysone eval <<'EOF'
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "urgent": {
      "type": "noul",
      "instructions": "Does this need immediate attention?",
      "criteria": {
        "true": "A customer-impacting incident is ongoing",
        "false": "This can wait for normal triage"
      }
    }
  }
}
EOF
```

Or point any System One client at `http://127.0.0.1:13900`.

## Add hosted Jev

```sh
export TYPESAFE_API_KEY=…
sysone config set routing.policy auto
```

`auto` prefers hosted Jev while the credential is present and the service is
reachable, then falls back to the smallest installed or registered local model.
The credential stays in the environment; sysone never writes it to disk.

## Local models

`sysone pull` manages model artifacts under `~/.sysone/models` (or
`$SYSONE_HOME/models`). Downloads stream to a temporary file, enforce an 8 GiB
ceiling, verify SHA-256, run a per-kind structural validation, and only then
atomically enter the model store. Manifest filenames cannot escape the store,
symbolic-link weights are not admitted, and the daemon never downloads weights
implicitly.

```sh
sysone pull --list
sysone pull qwen3-0.6b
sysone pull cua-s1-forms
sysone pull needle3
sysone model list
sysone model verify qwen3-0.6b
```

The curated registry contains three artifact kinds:

| Model | Kind | Download | Role |
| --- | --- | ---: | --- |
| `qwen3-0.6b` | `gguf` | 365 MiB | smallest default fallback |
| `qwen3-1.7b` | `gguf` | 1.03 GiB | stronger laptop-local tier |
| `cua-s1-forms` | `scorer` | 2.8 MiB | CUA-S1 form-action option scorer (specialist) |
| `needle3` | `needle` | 34 MiB + engine | Cactus Needle extraction model (specialist) |

All entries are pinned to the publisher's Hugging Face LFS SHA-256. Weight
licenses and terms remain those of their publishers; weights are not included
in the sysone package.

### Specialists

`scorer` and `needle` models are **specialists**: they never absorb unpinned
fallback traffic. Only `gguf` models serve `auto`/`prefer-local` requests.
To use a specialist, pin it explicitly:

```json
{ "model": "local-cua-s1-forms/cua-s1-forms", "state": "...", "questions": { ... } }
```

Each kind runs through a different adapter, disclosed in the
`x-sysone-local-adapter` response header:

- `generic-gguf` — llama.cpp first-token scoring (below);
- `option-scorer` — the 706K-parameter CUA-S1 checkpoint, ported to pure
  TypeScript. A byte-level option-attention transformer scores up to 26
  options per question in a single forward pass — real per-option
  distributions, ~3 MB resident, no native runtime. Its training domain is
  web-form actions (`fill`/`check`/`click`/`skip`), so pin it for
  form-shaped state→action decisions;
- `needle-extract` — the Cactus Needle `.cact` blob plus a platform engine
  binary, spawned as one bounded process per request with telemetry
  disabled. Questions become arguments of one `evaluate` tool call. Needle
  returns values plus a calibrated turn confidence rather than per-option
  probabilities, so `probabilities` are a disclosed approximation
  (confidence on the pick, the remainder split uniformly).

### Generic GGUF adapter

For builtin GGUF models, sysone renders a bounded question prompt, evaluates
the full first-token vocabulary distribution with llama.cpp, and sums
probability mass over constrained answer labels. Choice and score use unique
one-character labels to avoid ambiguous multi-token option names. Builtin
inference supports up to 35 options per question; hosted and external
backends retain the protocol's 255-option limit. Builtin answers use the
official Jev wire shapes:

- Noul returns only `type` and probability-of-yes `noul`;
- Choice returns `choice`, keyed `probabilities`, and `confidence`;
- Score returns a zero-based probability-weighted fractional `score`, keyed
  `legend`, keyed `probabilities`, and `confidence`.

Adapter quality signals stay outside those answer objects:
`x-sysone-local-min-coverage` is the least total probability mass assigned to
allowed labels, and `x-sysone-local-min-concentration` is the least
distribution concentration in the batch. Low coverage means the model did not
cleanly follow the decision instruction. These are useful local signals, not
a calibration guarantee. Use hosted Jev or a qualified System One-specific
backend where calibrated semantics are required.

An unlisted public Hugging Face GGUF can be installed explicitly:

```sh
sysone pull 'hf:owner/repository:path/model.gguf' --sha256 <64-hex-digest>
```

## The endpoint

| Route | Purpose |
| --- | --- |
| `POST /v1/systemone` | Evaluate `{model?, state, questions}` through the selected backend |
| `GET /v1/models` | List model ids, backend names, kinds, and reachability |
| `GET /healthz` | Report daemon liveness and version |

Responses carry `x-sysone-backend` and `x-sysone-attempts`; builtin responses
also carry the local adapter and diagnostic headers above. Any HTTP response
from a remote backend, including 4xx or 5xx, is definitive. Only a transport
failure may re-dispatch, at most once, and never for a pinned `backend/model`.

`state`, `instructions`, and criterion descriptions accept text, JSON objects,
JSON arrays, or `null` where the official Jev contract permits it. The public
package exports request and response schemas for boundary validation.

### Request example

```json
{
  "model": "auto",
  "state": { "tests": "failing", "branch": "main" },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "What should the agent do next?",
      "criteria": {
        "fix": "Repair the failure before continuing",
        "continue": "The failure is unrelated and safe to defer",
        "escalate": "Human judgment is required"
      }
    },
    "risk": {
      "type": "score",
      "instructions": "Rate merge risk",
      "criteria": ["low", "moderate", "high"]
    }
  }
}
```

## Routing

`routing.policy` controls candidate order:

| Policy | Order |
| --- | --- |
| `auto` (default) | hosted Jev, then local smallest-first |
| `prefer-local` | local smallest-first, then hosted Jev |
| `prefer-hosted` | hosted Jev, then local |
| `local-only` | local only |
| `hosted-only` | hosted Jev only |

Local candidates sort by parameter count, then operator `cost_rank`, then
backend name. Requests can pin either a model id or an exact backend/model:

- `"model": "qwen3-0.6b"` selects any backend serving that id;
- `"model": "local-qwen3-0.6b/qwen3-0.6b"` pins the builtin runner;
- `"model": "openjev/openjev-4b"` pins a registered HTTP backend.

Selection is capability-aware. Each request's needs — its largest option
count and total question count — are compared against the backend's published
limits. A backend the request exceeds is skipped; when no configured backend
can serve the request at all the gateway answers `422 request_unsupported`
rather than dispatching a request that would fail downstream. Builtin
backends publish their adapter limits (`generic-gguf` 35 options,
`option-scorer` 26 options, `needle-extract` 64 questions); remote backends
are probed at `GET /v1/limits` (openjev-style `max_answers_per_question` and
`max_questions`). A backend that publishes nothing is treated as unbounded —
missing limits never mean zero capability.

## External System One backends

Any service implementing `POST /v1/systemone` and `GET /v1/models` can join the
same router:

```sh
sysone backend add \
  --name openjev \
  --url http://127.0.0.1:8080 \
  --model openjev-4b \
  --size-b 4
```

[Bespoke Nimble](https://github.com/bespokelabsai/nimble) is a drop-in example:
its public deployment speaks the same wire protocol and publishes its limits
(2–26 options, ≤64 questions), which sysone picks up automatically:

```sh
sysone backend add \
  --name nimble \
  --url https://bespokelabs--nimble-sglang-nimble.us-west.modal.direct \
  --model nimble-latest \
  --size-b 9
```

These processes remain operator-owned. sysone bounds probes and forwarding but
does not manage their credentials, weights, or lifecycle.

## Diagnostics

`sysone doctor` is a bounded, machine-readable readiness check. It verifies the
Bun floor, state-directory access, config, native llama.cpp runtime/backend,
manifest, every admitted artifact (GGUF header, scorer checkpoint structure,
`.cact` header, engine companion presence/byte count), stale/orphan store
files, routing candidates, and daemon ownership. It does not hash entire model
files; use `sysone model verify MODEL` for exact SHA-256 verification.

```sh
sysone doctor
sysone doctor --json
```

Warnings do not fail readiness. Failed checks return exit code 6. JSON is
versioned (`version: 1`) and check identifiers are stable and additive.

## Commands

```text
sysone up|down|serve|status|doctor
sysone pull [MODEL]|pull --list
sysone model list|verify|remove
sysone models
sysone eval
sysone backend list|add|remove
sysone config path|get|set|unset
sysone --version|--help
```

Supporting commands accept `--json`. Machine data goes to stdout; diagnostics
and download progress go to stderr.

## Configuration

`~/.sysone/config.json` is created on the first write. `SYSONE_HOME` overrides
the state directory. Settable keys:

- `routing.policy`;
- `gateway.host` (loopback addresses only), `gateway.port`,
  `gateway.request_timeout_ms`, `gateway.probe_timeout_ms`;
- `hosted.enabled`, `hosted.base_url`, `hosted.model`, `hosted.api_key_env`;
- `local.enabled`, `local.context_tokens`, `local.eval_timeout_ms`,
  `local.max_loaded_models`.

The daemon reads config per request, so routing and backend changes do not need
a restart. Already loaded GGUFs stay resident up to `local.max_loaded_models`
(default one) and are released on eviction or daemon shutdown. Local inference
is serialized per model to keep context state isolated and memory bounded.

The gateway has no authentication and accepts loopback binds only.

## Releases

An annotated `v<version>` tag at the exact current `main` head requests a
release. The tag must match `package.json`. The release workflow reruns the
complete gate, creates one npm-format tarball and `SHA256SUMS`, installs and
executes those exact bytes with the native dependency and `doctor` on Ubuntu
and macOS, then publishes them to a repository-enforced immutable GitHub
Release. No npm registry package is claimed or required.

## Development

```sh
bun install
bun run check
```

The check runs strict TypeScript, deterministic tests with fake inference,
distribution builds, and an isolated packed-artifact import/CLI smoke test.
Large weights, live model downloads, and native inference are excluded from
ordinary CI.
