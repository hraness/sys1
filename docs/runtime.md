# Sys1 runtime reference

Configure the decision API, use the Node/Bun client, or run a local model.
For installation and an agent workflow, start with the [getting-started guide](../README.md#install).

## Use as a module

For a Node 24 or Bun application that calls a running gateway, follow the
[client installation](../README.md#use-as-a-module), which omits the optional
native runtime. Start the configured gateway with `sys1 up`, then send a request:

```ts
import { createClient } from "@hraness/sys1/client";

const sys1 = createClient(); // http://127.0.0.1:13900
const { response, metadata } = await sys1.evaluate({
  state: "The build failed after a dependency upgrade.",
  questions: {
    action: {
      type: "choice",
      criteria: { repair: "Fix the build", continue: "Continue work" },
    },
  },
}, { signal: AbortSignal.timeout(5_000) });

console.log(response.answers.action, metadata.backend);
```

The client validates inputs and correlates every returned answer with its
question. It bounds response bytes, supports cancellation, and returns stable
sanitized `Sys1ClientError` codes. It never retries, reads credentials from the
environment, starts a daemon, downloads weights, or imports native inference.
Supply `baseUrl` and `headers` explicitly for another approved endpoint.
Import schemas and request/response types from the same `/client` entry point.

For a Bun application that owns routing and model lifecycle in-process:

```ts
import { createRouter, DEFAULT_CONFIG } from "@hraness/sys1";

const router = createRouter({
  config: DEFAULT_CONFIG,
  env: process.env,
  home: "/absolute/path/to/sys1-state", // previously installed models
});
try {
  const result = await router.evaluate({
    state: "All required checks passed.",
    questions: { ready: { type: "noul", instructions: "Are the checks passing?" } },
  });
  console.log(result.response.answers.ready);
} finally {
  await router.dispose();
}
```

The embedded router opens no port. It uses the same routing and validation as
the daemon and owns its local runner until disposal. Its runtime requires Bun;
the `/client` entry point is portable to Node. Keep one router per application,
not one per request. The root package also exposes lower-level routing and
model-management APIs; applications should normally use `createClient` or
`createRouter`.

### Adopting Sys1 in an existing Jev application

Keep domain questions, deterministic fallback, action authorization, and quality
thresholds in the application. Put endpoint configuration, transport, routing,
response validation, and local engine lifecycle behind Sys1. Existing HTTP
clients in other languages can use the same daemon without a JavaScript module.

Use `model: "auto"` or omit `model` to use the configured routing policy and
selected local model. A hardcoded `jev-1.13.0` remains a model pin and cannot
select an unrelated local model.
Local calls need no hosted API key; hosted activation stays explicit. A remote
server's loopback address points to that server. A browser running on the user's
machine can address local services, so Sys1's network listener rejects browser
origins and Fetch Metadata site headers, requires a loopback request authority,
and accepts decision POSTs only as `application/json`.

Start with an opt-in, non-authoritative pilot. Compare decisions on the
application's representative fixtures and record backend/adapter identity,
latency, errors, abstentions, and disagreement with the current decision path.
Do not reuse Jev probability thresholds for generic GGUF output
without model-specific evidence. A local-only policy also constrains explicit
pins; a pin never bypasses the policy. Broad production adoption requires the
consumer's own quality and operational acceptance, not just wire compatibility.

## Experimental local decisions

```sh
sys1 setup      # verifies the native runtime, installs and selects Qwen3 1.7B
sys1 up         # starts the gateway on 127.0.0.1:13900
sys1 status
```

Local Qwen is experimental. Do not treat it as a drop-in replacement for Jev.
The broader tests found 32/72 correct decisions for Qwen3 1.7B and 44/72 for
Qwen3.5 4B on a different fresh fixture. [Read the evidence](https://sys1.io/docs/evaluations)
before using local decisions to drive actions.

`setup` is the explicit weight-download boundary. It installs Qwen3 1.7B and
persists that choice as `local.model`, regardless of system memory. Inspect
without changing anything:

```sh
sys1 setup --dry-run --json
```

`sys1 setup --tier compact` explicitly installs and selects the experimental
Qwen3 0.6B diagnostic model. It is not an automatic low-memory fallback.
`sys1 setup --tier quality` returns the selection to Qwen3 1.7B.

The pinned llama.cpp runtime selects the best available backend automatically:

| Package target | Runtime preference |
| --- | --- |
| macOS ARM64 | Metal (the pinned runtime's only automatic selection) |
| macOS x64 | CPU |
| Linux x64 | CUDA, Vulkan, then CPU |
| Linux ARM64 | CPU |
| Windows x64 | CUDA, Vulkan, then CPU |
| Windows ARM64 | CPU |

Other platform/architecture pairs fail closed before downloading a model. The
release artifact and package smoke are exercised on Ubuntu, macOS, and Windows.
This matrix does not prove every OS/architecture pair above; run
`sys1 doctor` on the actual host before use.

Send a decision:

```sh
sys1 eval <<'EOF'
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

Hosted Jev is disabled by default, even if `TYPESAFE_API_KEY` is already set in
the environment. Obtain a key from [TypeSafe](https://console.typesafe.ai/),
provide it through your shell or secret manager, and enable the backend:

```sh
# Provide TYPESAFE_API_KEY privately in this shell first.
sys1 jev enable
sys1 jev status
```

`jev enable` requires the credential to be present, stores only
`hosted.enabled: true`, and sets routing to `hosted-only`. The key remains in the
environment; Sys1 never writes it to its config or prints it. Avoid putting
the key in source files or shell history. Restart a gateway that was
started before the key was exported. To disable hosted Jev:

```sh
sys1 jev disable
```

Enabling Jev selects `hosted-only`: a hosted outage or missing credential returns
an error without substituting Qwen. To experiment with local fallback after
measuring its quality on your application, explicitly run
`sys1 config set routing.policy auto`. That policy prefers reachable Jev, then
the installed model named by `local.model`. Disabling Jev returns a hosted-only
configuration to `auto` for the selected local model. Installing additional
models does not change the selection. If no eligible route is available, Sys1
reports an error instead of silently choosing another installed model.

### Make your first Jev API request

After enabling Jev, start the loopback daemon with `sys1 up`. Save this as
`request.json`; it asks about a small, supplied piece of evidence:

```json
{
  "model": "typesafe/jev-1.13.0",
  "state": { "result": "The check exited with code 1." },
  "questions": {
    "failed": {
      "type": "noul",
      "instructions": "Does the supplied result report a failed check?"
    }
  }
}
```

```sh
sys1 eval --file request.json --json
```

Read `answers.failed.noul` as the model's probability of yes. This request
demonstrates the API; code should read an available exit status directly.
Pinning `typesafe/jev-1.13.0` selects the hosted route and version. TypeSafe's
[`jev-latest` alias](https://docs.typesafe.ai/models) can move to a new version;
Sys1's default remains the configured version until you change it. Review and
verify commands can call Jev directly without starting the daemon; the client,
`sys1 eval`, and commands using `--gateway` need a running gateway.

For a failed request, check `sys1 jev status` and `sys1 doctor`. Restart the
daemon after changing its environment. An HTTP error from a backend is
returned without a retry; the client does not silently try a different model.
Current provider limits and prices are in [TypeSafe's model reference](https://docs.typesafe.ai/models).

## Local models

`sys1 setup` and `sys1 pull` manage model artifacts under
`~/.sys1/models` (or `$SYS1_HOME/models`). Downloads stream to a temporary
file, enforce an 8 GiB ceiling, verify SHA-256, run bounded GGUF structural
validation, and only then atomically enter the model store. Manifest filenames
cannot escape the store, symbolic-link weights are not admitted, and the daemon
never downloads weights implicitly.

```sh
sys1 pull --list
sys1 pull qwen3-1.7b
sys1 model list
sys1 model verify qwen3-1.7b
```

The curated registry contains three experimental GGUF models:

| Model | Kind | Download | Role |
| --- | --- | ---: | --- |
| `qwen3-1.7b` | `gguf` | 1.03 GiB | default local experiment |
| `qwen3-0.6b` | `gguf` | 365 MiB | diagnostic model; explicit selection only |
| `qwen3.5-4b` | `gguf` | 2.55 GiB | larger candidate; explicit selection only |

All entries are pinned to the publisher's Hugging Face LFS SHA-256. Weight
licenses and terms remain those of their publishers; weights are not included
in the Sys1 package.

`sys1 pull` defaults to Qwen3 1.7B and only installs an artifact; it does not
change `local.model`. To change the local route, install the model first, then
select its installed ID with `sys1 config set local.model MODEL`. Other
installed models require a request-level model pin. This keeps a new download
from becoming an unintended fallback.

Older inventories containing removed CUA-S1 or Needle artifacts fail closed.
Sys1 preserves those files and the manifest; use a new `SYS1_HOME` for the
current GGUF store.

### Generic GGUF adapter

For builtin GGUF models, Sys1 renders a bounded question prompt, evaluates
the full first-token vocabulary distribution with llama.cpp, and sums
probability mass over constrained answer labels. Choice and score use unique
one-character labels to avoid ambiguous multi-token option names. Builtin
inference supports up to 35 options per question; hosted and external
backends retain the protocol's 255-option limit. Builtin answers use the
official Jev wire shapes and disclose `generic-gguf` in the
`x-sys1-local-adapter` response header:

- Noul returns only `type` and probability-of-yes `noul`;
- Choice returns `choice`, keyed `probabilities`, and `confidence`;
- Score returns a zero-based probability-weighted fractional `score`, keyed
  `legend`, keyed `probabilities`, and `confidence`.

Adapter input bounds fail closed: Sys1 never silently truncates state,
instructions, or criteria. Generic GGUF accepts up to 6,000 state characters,
2,000 instruction characters, 96 characters per option name/criterion, and
16,000 characters for the complete rendered prompt. An input beyond the adapter's
bounds returns an error without being sent to a different backend.

Adapter quality signals stay outside those answer objects:
`x-sys1-local-min-coverage` is the least total probability mass assigned to
allowed labels, and `x-sys1-local-min-concentration` is the least
distribution concentration in the batch. Low coverage means the model did not
cleanly follow the decision instruction. These are useful local signals, not
a calibration guarantee. Use hosted Jev or a task-qualified System One-specific
backend when its behavior has been evaluated for your task.

An unlisted public Hugging Face GGUF can be installed explicitly:

```sh
sys1 pull 'hf:owner/repository:path/model.gguf' --sha256 <64-hex-digest>
```

## The endpoint

| Route | Purpose |
| --- | --- |
| `POST /v1/systemone` | Evaluate `{model?, state, questions}` through the selected backend |
| `GET /v1/models` | List model ids, backend names, kinds, and reachability |
| `GET /healthz` | Report daemon liveness and version |

Responses carry `x-sys1-backend` and `x-sys1-attempts`; builtin responses
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

For unpinned requests (`model: "auto"` or omitted), `routing.policy` controls
the order of enabled hosted Jev and the installed model named by `local.model`:

| Policy | Order |
| --- | --- |
| `auto` (default) | hosted Jev, then the selected local model |
| `prefer-local` | selected local model, then hosted Jev |
| `prefer-hosted` | hosted Jev, then the selected local model |
| `local-only` | selected local model only |
| `hosted-only` | hosted Jev only |

Other installed models and all registered HTTP services require an explicit
request model or backend/model pin. They never receive unpinned fallback
traffic. A missing selected model does not promote another installed model.
Registered HTTP services are local only when their URL uses a
loopback host; off-machine URLs count as hosted. Redirects are never followed.
`local-only` decisions neither probe nor dispatch to hosted endpoints. Explicit
model discovery and doctor may probe all configured backends. Backend names must
be unique; `typesafe` and `local-*` are reserved for managed candidates. Requests can pin either a model id or an exact backend/model:

- `"model": "jev-1.13.0"` selects a backend serving that hosted model;
- `"model": "local-qwen3-1.7b/qwen3-1.7b"` pins the builtin Qwen runner;
- `"model": "local-qwen3-0.6b/qwen3-0.6b"` explicitly selects the experimental model;
- `"model": "openjev/openjev-latest"` pins a registered HTTP backend that advertises that alias.

Selection is capability-aware. Sys1 compares each request's largest option
count and total question count against the backend's published limits. A backend the request exceeds is skipped; when no configured backend
can serve the request at all the gateway answers `422 request_unsupported`
rather than dispatching a request that would fail downstream. Builtin
backends publish their adapter limit (`generic-gguf` 35 options); remote backends
are probed at `GET /v1/limits` (openjev-style `max_answers_per_question` and
`max_questions`). A backend that publishes nothing has unknown capacity; Sys1 can enforce only
its configured limits and the common protocol envelope. Missing limits never
mean zero capability.

## External System One backends

Sys1 can route to an [OpenJev](https://github.com/razorback16/openjev) server
through its standard System One decision API. OpenJev's image, chat, and
advanced sampling extensions are not supported. A server you register answers
only requests that select it; adding one does not change the default route.

Any service implementing `POST /v1/systemone` and `GET /v1/models` can join the
same router. For an existing OpenJev server, first inspect its advertised model
IDs. The example uses OpenJev's documented `openjev-latest` alias; replace it if
your server advertises a different ID:

```sh
curl http://127.0.0.1:8080/v1/models
sys1 backend add \
  --name openjev \
  --url http://127.0.0.1:8080 \
  --model openjev-latest
```

Before routing agents to an operator backend, qualify its discovery, limits,
and all three answer shapes:

```sh
sys1 backend check --name openjev
```

Select it in a request with `"model": "openjev/openjev-latest"`. Registration
and qualification do not add an HTTP service to automatic routing.

The check makes bounded calls to `/v1/models`, `/v1/limits`, and
`/v1/systemone`; validates the official response schema, probability
normalization, and Score arithmetic; and never prints or persists request or
response bodies. Backends that do not publish limits receive a warning unless
static caps were configured. All configured HTTP processes remain
operator-owned: Sys1 probes and forwards to them but does not download their
weights, mutate credentials, or own their lifecycle.

## Kev and decision profiles

[Kev](https://github.com/jaredpalmer/kev) servers use a dedicated adapter
(`--adapter kev`) that handles Kev's two-decimal probability output and
structured Score legends. Versioned decision profiles reuse task instructions
with Jev, local models, or a separately trained Kev checkpoint.
[Kev and tuning guide](kev.md).

After starting and verifying a separately owned Kev server, register it explicitly:

```sh
sys1 backend add --adapter kev --name kev \
  --url http://127.0.0.1:8009 --model kev-latest
sys1 backend check --name kev
```

Kev remains outside automatic routing. A versioned profile pins the route and
reuses the same instructions and criteria while each call supplies new state:

```ts
import { createClient, createProfile } from "@hraness/sys1/client";

const triage = createProfile({
  version: 1, id: "ticket-triage", revision: "1", model: "kev/kev-latest",
  questions: {
    urgent: { type: "noul", instructions: "Does the ticket describe an active outage?" },
  },
});
const result = await createClient().evaluate(triage.request("Checkout is unavailable."));
```

Profiles work with the Node/Bun client and embedded router. Definitions are
validated and frozen; each request is a fresh ordinary System One request.
Only model, state, and questions cross the wire. No templating, hidden prompt
injection, global profile registry, or automatic training is involved. Save
the definition as JSON for `sys1 eval --profile triage.json`, which accepts
only `{"state": ...}` on stdin or `--file`.
[Start from the ticket-triage profile](../examples/ticket-triage.profile.json).

From a source checkout, [evaluate profiles on labeled examples](profile-evaluation.md)
with an offline preview, request limits, and per-question results. Experimental
[profiles](../examples/workflows) cover failure triage, excerpt relevance, and claim
support. These experiments require Bun and the project dependencies; they are
separate from the installed review and verification skills. Read the
[September 28, 2026 trial](../benchmarks/workflows/results/2026-09-28.md) for the
method, recorded outcomes, and limits.

That trial submitted 48 frozen synthetic examples to Jev 1.13.0 once each:

| Source workflow | Correct / submitted | Errors | Deterministic baseline |
| --- | ---: | ---: | ---: |
| Claim support | 16/16 | 0 | 6/16 with literal text matching |
| Failure triage | 16/16 | 0 | 16/16 with error signatures |
| Excerpt relevance | 13/16 | 3 | 6/16 with token overlap |

Claim support is a candidate for a larger trial against stronger comparators.
Triage tied ordinary error matching. Relevance needs response-format diagnosis.
These small synthetic sets do not establish production accuracy, and the
literal-match claim baseline is deliberately weak. Errors remain in the
denominators; profiles, labels, and thresholds were unchanged after the run.

For a direct Kev endpoint, use `createClient({ baseUrl: "http://127.0.0.1:8009",
adapter: "kev" })` with an ordinary request containing `model: "kev-latest"`.
When calling the Sys1 gateway, leave the client adapter unset. Routing metadata
identifies Kev and its two-decimal precision; probabilities are not renormalized.

The backend/model pin identifies a route, not its weights. Kev always advertises
`kev-latest`; verify the server's actual checkpoint separately. The
[setup and tuning guide](kev.md) covers pinned checkpoints, prompt revisions,
fine-tuning, calibration, and held-out evaluation. Model downloads and training
remain explicit Kev operations. Protocol tests do not establish model quality.

## Diagnostics

`sys1 doctor` checks the install and prints one line per check (✓, ⚠ or ✗),
a count, and the command to run next. It verifies the
Bun floor, state-directory access, config, native llama.cpp runtime/backend,
the installed-model list, every installed model's GGUF header, leftover or
unknown files in the model folder, routing candidates, and daemon ownership. It does not hash entire model
files; use `sys1 model verify MODEL` for exact SHA-256 verification.

```sh
sys1 doctor
sys1 doctor --json
```

Warnings do not fail readiness. Failed checks return exit code 6. JSON is
versioned (`version: 1`) and check identifiers are stable and additive.

## Commands

```text
sys1 setup [--tier compact|quality] [--dry-run]
sys1 jev status|enable|disable
sys1 up|down|serve|status|doctor
sys1 pull [MODEL]|pull --list
sys1 model list|verify|remove
sys1 models
sys1 eval
sys1 audit --staged|--worktree|--since <ref> --model <backend/model>
sys1 review checkpoint|issues|feedback|recheck|setup
sys1 rules list|check|draft
sys1 verify setup codex|claude-code|devin
sys1 verify --model <backend/model> [--message <file|->]
sys1 usage [--days <n>]
sys1 backend list|add|check|remove
sys1 config path|get|set|unset
sys1 --version|--help
```

See [saved checks and review workflows](workflows.md) for `sys1 workflow`
commands and the [update guide](cli-updates.md) for `sys1 update`.

Supporting commands accept `--json`. When an agent runs sys1 (Claude Code,
Codex, Cursor, Gemini CLI, or `AI_AGENT` is set), JSON is the default;
`HRANESS_AUDIENCE=human` or `agent` overrides the guess. Machine data goes to
stdout; diagnostics, next-step hints and download progress go to stderr. Every
command has its own help (`sys1 setup --help`). Errors are one sentence and the
command to run next; with `--json` they are one `{"ok":false,"error":{...}}`
object on stdout. `sys1 setup --dry-run` shows the model, its size and the
folder it would be downloaded to.

## Configuration

`~/.sys1/config.json` is created on the first write. `SYS1_HOME` overrides
the state directory. Settable keys:

- `routing.policy`;
- `gateway.host` (loopback addresses only), `gateway.port`,
  `gateway.request_timeout_ms`, `gateway.probe_timeout_ms`;
- `hosted.base_url`, `hosted.model`, `hosted.api_key_env` (activation uses
  `sys1 jev`);
- `local.enabled`, `local.model`, `local.context_tokens`, `local.eval_timeout_ms`,
  `local.max_loaded_models`.

Fresh config uses `routing.policy: auto`, `local.enabled: true`,
`local.model: qwen3-1.7b`, `hosted.model: jev-1.13.0`, and
`hosted.enabled: false`. The daemon reads config per request, so routing and
backend changes do not need a restart. Restart after changing local runtime
context, timeout, or residency settings. Environment variables are inherited when
the daemon starts, so restart it after exporting a new Jev credential. Already
loaded GGUFs stay resident up to `local.max_loaded_models` (default one) and are
released on eviction or daemon shutdown. Local requests are serialized
to keep context state isolated and residency bounded. GGUF inference lives in
an owned worker process; abort, timeout, or disposal terminates and collects
that worker before the next request can reuse the engine slot.

The decision endpoint accepts loopback binds only and has no application
authentication. Network admission blocks browser-originated decision dispatch and
non-loopback Host authorities, but it does not authenticate local processes.
Any process that can connect locally can dispatch decisions using the gateway's
enabled backends and credentials; use it only on a trusted local machine.
The in-process `createRouter`/`createFetchHandler` surface leaves admission to
its owning application. Daemon shutdown uses a per-instance
secret from its private pid file and an authenticated control endpoint. Sys1
never signals an arbitrary PID read from that file.

