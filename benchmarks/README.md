# Public local adapter benchmark

`forms-v1.json` contains twenty authored, synthetic form-action examples. Each
asks for one of three actions: submit a valid form, correct a missing or invalid
field, or wait for an operation. Correct labels and their option positions are
balanced 7/7/6. Every case fits the CUA-S1 Forms checkpoint's 224-byte combined
state/instruction context and 96-byte option bounds.

This is a small reproducible sanity check, not a general quality benchmark or
evidence of calibration. The tasks favor the form specialist's domain. They do
not establish extraction, reasoning, safety, or production performance.

## Run

The harness accepts only this fixed public fixture. It does not read Sys1
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
