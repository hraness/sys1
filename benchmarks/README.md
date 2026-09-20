# Public model benchmarks

`forms-v1.json` contains twenty authored, synthetic form-action examples. Each
asks for one of three actions: submit a valid form, correct a missing or invalid
field, or wait for an operation. Correct labels and their option positions are
balanced 7/7/6. Every case fits the CUA-S1 Forms checkpoint's 224-byte combined
state/instruction context and 96-byte option bounds.

This is a small reproducible sanity check, not a general quality benchmark or
evidence of calibration. These are narrative submit/correct/wait questions, unlike the CUA checkpoint's
training format (TASK/FORM/ELEMENT contexts and fill/check/click/skip actions).
This checks transfer into a common Sys1 request shape, not native specialist
performance. It does not establish extraction, reasoning, safety, or production
performance.

## Run

Run from a repository checkout with Bun 1.3.14 after `bun install --frozen-lockfile`.
Qwen measurements require the optional node-llama-cpp native runtime; the harness
checks readiness before measurement.

The local harness accepts only this fixed public fixture. It does not read Sys1
configuration or credentials, call hosted services, or download anything.
Explicitly acquire the pinned models first into an isolated store:

```sh
SYS1_HOME="$PWD/work/benchmark-models" bun src/cli.ts pull qwen3-0.6b
SYS1_HOME="$PWD/work/benchmark-models" bun src/cli.ts pull cua-s1-forms
SYS1_HOME="$PWD/work/benchmark-models" bun src/cli.ts pull needle3
bun scripts/benchmark-local.ts --validate-only
bun scripts/benchmark-local.ts \
  --home "$PWD/work/benchmark-models" \
  --models qwen3-0.6b,cua-s1-forms,needle3 \
  --output "$PWD/work/forms-v1-results.json"
```

Use a new output path for each experiment; existing results are never silently
overwritten. Omitting `--models` selects only `qwen3-0.6b`. The four curated
models are the only permitted selections, and no selection occurs implicitly
from a user config. Qwen3 1.7B can be acquired and selected separately. Run
through your host's compute scheduler when one is installed. Real inference is
opt-in and is never part of the ordinary test suite.

The harness verifies installed file sizes, registry digest pins, model
structure, and the platform Needle engine before measurement. GGUF runs also
probe the native backend without loading a model. These steps are excluded
from recorded inference latency.

## Timing and quality

Each model runs at concurrency one, with a 2,048-token GGUF context and one
resident model. Each request has a 60-second cancellation deadline;
the measured run has an overall 15-minute cancellation deadline. Interrupting
the run disposes its owned runners and preserves a partial report. Do not use
an interrupted or failed report as a completed comparison.
Three consecutive invalid/error responses stop that model. Its report records
the actual observations and skipped calls; valid but incorrect answers do not
trigger this stop rule. A stopped model is not a completed 100-call measurement.
Any stopped model makes the overall status `complete_with_model_failures` and
the command exit nonzero, while preserving measurements from completed models.

1. Three fresh `LocalRunner` instances each evaluate the first fixture case
   and are disposed. Report all three times as **fresh-runner first calls**.
2. Another runner evaluates two warmup cases, then the twenty cases in fixed
   order five times, producing 100 repeated-call timing samples.
3. Every raw result includes case ID, expected label, validated response,
   correctness, sanitized failure code, diagnostics, reported usage and
   elapsed time. First-pass accuracy uses twenty cases; repeats do not create
   additional independent quality examples. Failures count as incorrect.
4. p50 and p95 use nearest-rank percentiles. Both all-attempt and valid-response
   latency are reported so failures cannot silently improve the chart.
   Throughput divides attempt or valid-response count by total repeated-phase
   wall time, including loop and response-validation overhead.

Per-call time covers `LocalRunner.decide`: manifest lookup, prompt adaptation,
native/TypeScript model work, and worker IPC. It excludes response validation,
HTTP/gateway routing, acquisition, and digest verification. Fresh-runner time
is **not cold-machine time**: the digest check reads weights into the OS file
cache, and neither OS caches nor the parent runtime/JIT are reset. Needle
starts a process on every request, so its repeated results never mean a warm
resident native engine. Do not compare these measurements directly with an
upstream server-side latency claim or a provider's unrelated dataset.

The JSON records source commit and modified-worktree status, harness/fixture/
registry/runtime-source/lockfile SHA-256 values, weight and engine SHA-256 values, Bun version,
OS, CPU, total system memory and native backend. Memory is system capacity,
not measured model RSS or GPU memory. Preserve the exact source and fixture
with a published result; a Git SHA alone does not identify uncommitted edits.
The runtime-source digest hashes each TypeScript path followed by a NUL, its
bytes, and another NUL, traversing sorted directory entries beneath `src/`.

## Token counters are adapter-specific

| Adapter | Interpretation |
| --- | --- |
| Generic GGUF / Qwen | Actual tokenizer count for the fully wrapped prompt per question. Sys1 reads first-token probabilities and returns no generated text, so output usage is zero. |
| CUA-S1 option scorer | UTF-8 byte scoring without autoregressive generation. Protocol usage is 0/0; generated-token throughput is not applicable. |
| Needle | Current adapter does not expose native token accounting. Protocol usage is 0/0; actual token work is unreported. |

Use latency per completed decision, valid decisions per second, correctness,
and failure rate for cross-adapter comparisons. Do not turn zero counters into
claims of zero model work or infinite token efficiency. Adapter probabilities
and confidence also have different meanings; they are not calibrated against
one another by this fixture.

## Hosted Jev on the same cases

The separate Jev harness sends the same public states, instructions, criteria,
and option order to TypeSafe. It pins `jev-1.13.0` instead of a moving alias.
It reads only `TYPESAFE_API_KEY` from the environment; it does not read a user
configuration, change routing policy, or search for credentials. Configure the
key privately before running; never put its value in a command or result file.

```sh
bun scripts/benchmark-jev.ts --validate-only
bun scripts/benchmark-jev.ts \
  --region "your coarse client region" \
  --output "$PWD/work/forms-v1-jev-results.json"
```

A live run makes at most 105 API calls: three initial client calls, two warmups,
and five passes over twenty cases. It uses concurrency one, a 60-second request
deadline and a 15-minute overall deadline, with no automatic retries. Three
consecutive invalid/error responses stop the run. Existing output files are
never overwritten. The offline validation command needs no key and makes no
API calls.

Jev latency covers dispatch through receipt of the complete HTTP body, before
JSON and response validation. It includes network time. The local measurements
cover the adapter and exclude HTTP. Put these boundaries beside any comparison;
neither is isolated server inference time. Initial client calls do not reset
provider models, caches, DNS, or connections. Repeated identical inputs may
benefit from provider caching; that behavior is not measured.

Only the first measured pass supplies the twenty-case correctness score.
Repeated calls supply timing observations, not additional independent examples.
Responses must satisfy the same Sys1 schema and match the pinned model. Missing
usage is an invalid Sys1 response, not a fabricated zero-token measurement.
Reports preserve sanitized failures, actual/skipped call counts, model identity,
reported usage, and source/fixture hashes. Incomplete runs are not completed
comparisons.

Cost estimates use the [published input rate](https://docs.typesafe.ai/models)
of $0.042 per million tokens, checked September 19, 2026. Reported usage for
warmups and initial calls belongs in total experiment cost, separately from the
100-call measured phase. Failed calls can be billable even when no usable
accounting is returned, so known-usage estimates are not invoices or guaranteed
cost totals. This fixture has one short question per request and does not test
Jev's shared-state advantage across multiple questions.
