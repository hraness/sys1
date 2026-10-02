# Sys1

Sys1 gives coding agents tools to review code, check completion claims, and get
structured answers from Jev or a local model. Jev is TypeSafe’s hosted decision
model. Project skills work with Codex, Claude Code, and Devin; applications can
use the same tools through a CLI, Node/Bun client, or HTTP API.

Latest release: v0.19.1. Install the GitHub release with npm and run it with
Bun 1.3.14 or newer. MIT licensed.

[Get started](#install) · [Agent skills](https://sys1.io/skills) · [Documentation](https://sys1.io/docs) · [Releases](https://github.com/hraness/sys1/releases)

## Choose what helps your workflow

| You want to | Use | What you receive |
| --- | --- | --- |
| Save a check and continue its review later | [`sys1 workflow`](#save-a-check-and-continue-its-review) | A saved execution record, a private command log, and input checks before resume. |
| Check a change against a repository rule | [`sys1 review`](#review-changes-with-your-agent) | Candidates tied to the rule and diff, with feedback and reuse of unchanged reviews. |
| Check a proposed completion message | [`sys1 verify`](#check-an-agents-completion-message) | A comparison with Git state, linked pull requests, and live pages. |
| Add a decision to application code | [Client and HTTP API](#use-as-a-module) | Yes/no, choice, or score answers with probabilities and validated response shapes. |
| Keep long test logs out of the agent’s context | [System One Skills](https://sys1.io/skills#compact-checks), a separate package | A short result, the command’s exit status, and the full log saved locally. No model or API key. |


## Install

Install [Bun](https://bun.sh/docs/installation) 1.3.14 or newer and have npm
available, then run:

```sh
npm install --global --allow-scripts=node-llama-cpp \
  https://github.com/hraness/sys1/releases/download/v0.19.1/hraness-sys1-0.19.1.tgz
sys1 --version
```

The version command prints the installed release number. The release supports macOS, Linux,
and Windows. `--allow-scripts=node-llama-cpp` allows the optional local inference
runtime’s install script; installation downloads no model weights and enables
no hosted backend. The release includes a SHA-256 checksum.

## CLI updates

Sys1 0.19.0 and newer support automatic updates for Bun and npm globals
on macOS and Linux. Use `sys1 update disable` to keep a version. See
[update controls and supported installations](docs/cli-updates.md).

## Save a check and continue its review

From a Git worktree on macOS or Linux, run your repository’s check command:

```sh
sys1 workflow check -- bun test
sys1 workflow list
```

Sys1 saves the result and command output locally. This check needs no model or
API key. After configuring a backend, `sys1 workflow review` can run the check
and then review the selected changes. You can pause after the check and resume
with the same inputs; uncertain interrupted steps are never silently repeated.
ALGAL handles execution and saved state inside Sys1.

The [workflow guide](docs/workflows.md) covers scoped reviews, resume, private
logs, and inspecting a saved run. Keep running fresh required checks before
delivery.

## Review changes with your agent

Run these commands inside the Git repository you are working on. They install
project instructions and preview a review without calling a model:

```sh
sys1 review setup codex
sys1 review checkpoint --worktree --model typesafe/jev-1.13.0 \
  --max-requests 10 --dry-run --json -- src test
```

For Claude Code, use `setup claude-code`; for Devin, use `setup devin`. Replace
`src test` with the paths you changed. The preview lists selected files, rules,
skipped evidence, and the number of requests. If no requests are planned, inspect the skipped
evidence, selected paths, and active rules. Setup adds no automatic hooks and preserves
existing instructions.

The bundled rules cover newly empty catch blocks and removed test assertions
in JavaScript and TypeScript. Add [your repository’s rules](docs/review.md#draft-a-repository-rule)
for conventions that need judgment. For an exact syntax pattern, use a linter.
Review and completion checks are experimental and advisory: investigate
findings and keep the repository’s normal tests and review.

### Add hosted Jev

Get a key from [TypeSafe](https://console.typesafe.ai/) and provide it as
`TYPESAFE_API_KEY` through your shell or secret manager. Then enable Jev:

```sh
sys1 jev enable
sys1 jev status
```

The key stays in the environment. Enabling Jev selects `hosted-only` routing,
so a failed hosted request cannot silently use a local model. Selected source
and diff context go to Jev; inspect the preview before sending them. Provider
usage is billed by TypeSafe at its [published rates](https://docs.typesafe.ai/models).

Run the previewed check by removing `--dry-run`:

```sh
sys1 review checkpoint --worktree --model typesafe/jev-1.13.0 \
  --max-requests 10 --json -- src test
```

No background gateway is needed for this hosted workflow. Investigate each
candidate and record it as useful, incorrect, or unverifiable. Complete,
unchanged batches reuse their review for up to 24 hours. The [review guide](docs/review.md)
covers feedback, rechecks, and rule drafts; [`sys1 audit`](docs/audit.md) runs a
check without saved review history.

## Check an agent’s completion message

After setting up a backend, install the standalone verification instructions:

```sh
sys1 verify setup codex
```

Use `setup claude-code` or `setup devin` for those agents. Ask the agent to save
its proposed final message outside the Git worktree, then compare the draft
with available evidence:

```sh
sys1 verify --message /tmp/final-message.txt \
  --model typesafe/jev-1.13.0 --dry-run --json
```

Choose an equivalent external file path on Windows. The preview reports the
input type and model route without model calls or page fetches. Read the message
file and inspect its links before rerunning without `--dry-run`; the message and
any fetched page excerpts go to the selected backend. Use `--message -` for
piped text and `--url https://example.com` to include a live page the message
does not link.

Contradictions exit 7; unavailable evidence is marked unverifiable. A clean
report does not prove completion. File input works with any coding agent;
check-command evidence requires local Devin transcript discovery. See the
[verification guide](docs/verify.md) for input modes, evidence, and exit codes.

## Use as a module

For an application using Node 24 or Bun, install the portable client:

```sh
npm install --omit=optional \
  https://github.com/hraness/sys1/releases/download/v0.19.1/hraness-sys1-0.19.1.tgz
```

With a backend configured, run `sys1 up` to start the gateway, then call it:

```ts
import { createClient } from "@hraness/sys1/client";

const sys1 = createClient(); // http://127.0.0.1:13900
const { response } = await sys1.evaluate({
  model: "typesafe/jev-1.13.0",
  state: "Customers cannot complete checkout after today’s release.",
  questions: {
    urgent: {
      type: "noul",
      instructions: "Does this describe an active customer-impacting incident?",
    },
  },
}, { signal: AbortSignal.timeout(5_000) });

console.log(response.answers.urgent);
```

The answer contains the model’s probability of yes. Sys1 validates requests and
responses, supports cancellation, and returns stable error codes. Your
application decides which actions are allowed and evaluates the model on its
own examples. A valid answer can still be wrong.

The [client and embedded router guide](docs/runtime.md#use-as-a-module) covers
custom endpoints, the in-process Bun router, and existing Jev applications.

## The endpoint

The loopback gateway serves `POST /v1/systemone` for decisions,
`GET /v1/models` for discovery, and `GET /healthz` for liveness.
[HTTP request and response reference](docs/runtime.md#the-endpoint).

## Local models

Local Qwen models are experimental. In the broader recorded studies, Qwen3
1.7B answered 32/72 cases correctly; Qwen3.5 4B answered 44/72 on a different
fresh fixture. Evaluate the selected model on your task before relying on it.
[Model studies](https://sys1.io/docs/evaluations).

Preview the download with `sys1 setup --dry-run --json`. The [local setup guide](docs/runtime.md#experimental-local-decisions)
covers supported platforms, downloads, and model selection. Setup explicitly
downloads and selects Qwen3 1.7B; other installed models are never automatic
substitutes.

## External System One backends

Connect a server that implements the System One API, including OpenJev or Kev.
Register and check the server, then select it in each request. Adding a server
does not change default routing. [Compatible server setup](docs/runtime.md#external-system-one-backends)
· [Kev and decision profiles](docs/kev.md).

## Reference and troubleshooting

<a id="diagnostics"></a>
<a id="routing"></a>
<a id="configuration"></a>
<a id="commands"></a>
<a id="kev-and-decision-profiles"></a>

- [`sys1 doctor` and diagnostics](docs/runtime.md#diagnostics): inspect the runtime, routing, model store, and gateway after setup.
- [Routing](docs/runtime.md#routing): select a model and control fallback.
- [Configuration](docs/runtime.md#configuration): settings, credentials, and gateway access.
- [Commands](docs/runtime.md#commands): CLI reference and JSON output.
- [Decision profiles](docs/runtime.md#kev-and-decision-profiles): reuse questions across application requests.
- [Model comparison](https://sys1.io/compare) and [evaluation reports](https://sys1.io/docs/evaluations): inspect model-specific evidence.

If `sys1` is missing after installation, check that npm’s global binary
directory is on your `PATH` and that `bun --version` works. If a request cannot
find a model, inspect `sys1 jev status` and `sys1 doctor`. Restart an existing
gateway after changing its credential environment.

## Releases

An annotated `v<version>` tag at the exact current `main` head requests a
release and must match `package.json`. The release workflow reruns the complete
gate, creates one npm-format tarball and `SHA256SUMS`, and installs those exact
bytes with the native dependency on Ubuntu, macOS, and Windows before
publishing an immutable GitHub Release. Release notes come from
[CHANGELOG.md](CHANGELOG.md). The optional npm mirror publishes that same
tarball after the package’s one-time registry setup.

When a pull request that bumps the `package.json` version merges and Check
passes on `main`, the tag is created automatically. Pushing the tag by hand
still works.

## Development

```sh
git clone https://github.com/hraness/sys1.git
cd sys1
bun install
bun run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and release workflow.
Report a bug in [GitHub Issues](https://github.com/hraness/sys1/issues), or follow
[SECURITY.md](SECURITY.md) for a security report.
