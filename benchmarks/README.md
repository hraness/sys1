# Reproduce the decision evaluation

For cross-model Jev-class comparisons, use the pinned external [JevBench v1.2.6](https://github.com/fstandhartinger/jevbench/tree/v1.2.6) scorecard and its [immutable result artifact](https://github.com/fstandhartinger/jevbench/blob/275763201a29d6083d4ee1431d709c296ef81281/results/v1.2/jevbench-v1.2-results.json). This repository's fixtures answer a narrower question: whether a specific Sys1 adapter, model pin, and local/hosted transport behave as expected. They are not a replacement leaderboard and their scores must not be blended with JevBench.

`decisions-v2.json` contains 72 public synthetic cases: 24 choices, 24 yes/no
(`noul`) questions, and 24 ordered scores, across nine workflow families.
The fixture and labels were frozen before any model run. Its SHA-256 is
`7e1b3e988c9c27eae96efd1782cb301d998204b94a09ed915bebe0ad3d97e69b`.

A fresh candidate holdout, `decisions-v3.json`, was authored after v2 exposed
poor general performance in Qwen3 0.6B and 1.7B. It uses nine new families with
the same 72-case balance and fixed grading. Its SHA-256 is
`992d0078faff0f781d87be0755828b48689345e4a8a68d20b25f12b7a0fa87cc`.
It was frozen before Qwen3.5 4B execution. Select it with
`--fixture decisions-v3`; omission preserves v2 for reproduction. Scores across
the two fixtures are not a controlled measure of improvement.

For the new candidate, explicitly pull `qwen3.5-4b` into the isolated store and
run:

```sh
bun scripts/benchmark-decisions.ts --fixture decisions-v3 \
  --model qwen3.5-4b --home "$PWD/work/benchmark-models" \
  --output "$PWD/work/decisions-v3-qwen35.json"
```

The same fixture flag applies to Jev. Qwen3.5 uses its actual embedded chat
template with thinking disabled by the model wrapper. The older `/no_think`
user-text switch was removed because the publisher does not support it for
Qwen3.5. Historical v2 reports identify the earlier prompt/runtime source.

Use a dedicated model store. The commands below explicitly download weights;
the benchmark itself never downloads weights or reads your Sys1 configuration.

```sh
SYS1_HOME="$PWD/work/benchmark-models" bun src/cli.ts pull qwen3-1.7b
bun scripts/benchmark-decisions.ts --validate-only
bun scripts/benchmark-decisions.ts \
  --model qwen3-1.7b \
  --home "$PWD/work/benchmark-models" \
  --output "$PWD/work/decisions-v2-qwen17.json"
```

Qwen3 0.6B is an explicit diagnostic comparison: pull `qwen3-0.6b`, then pass
that model ID. Run native inference through your host scheduler when installed.
Real model calls remain outside ordinary tests and CI.

For Jev, supply `TYPESAFE_API_KEY` privately in the process environment. Do not
put the key in a command, fixture, config, or report. This sends only the public
synthetic cases to TypeSafe; at most 362 API calls are made.

```sh
bun scripts/benchmark-decisions.ts \
  --model jev-1.13.0 \
  --output "$PWD/work/decisions-v2-jev.json"
```

Use a new output filename. The harness refuses to replace an existing report.
Hosted runs cannot accept a local store; local runs require one explicitly.
Only the four named model IDs are accepted. Local files must match the pinned
registry's bytes and SHA-256 and pass structure/native-runtime checks.

## Fixed protocol

Each run has concurrency one and 362 planned calls:

1. One initial call and one warmup from the older `forms-v1` fixture.
2. Three passes over the 72 held-out cases: 216 timing observations.
3. All six option orders for each of 24 choice cases: 144 permutation calls.

Correctness uses only the first measured pass. Choice requires the exact label.
Noul requires a probability strictly above 0.5 for true or below for false.
Score requires a unique most-probable level matching the label; ties fail.
The weighted-score mean absolute error is reported separately. Failures count
as incorrect. Repeats and permutations are not independent quality examples.

Permutation invariance requires six valid answers selecting the same semantic
label. An invariant answer can still be wrong. Per-position correctness reveals
whether the result changes when the expected answer appears first, second, or
third. The benchmark is authored by the project, not an independent study or a
calibration guarantee. It does not establish production safety or broad quality.
Do not adjust prompts, labels, or cases to improve this held-out result.

Every request has a 60-second deadline; the run has a 20-minute deadline.
Three consecutive invalid/error responses stop the run. There are no retries.
Interruption disposes the owned runner and preserves a partial report. A
partial run is not a completed comparison; inspect observed and skipped counts.

## Timing, tokens, and provenance

Local latency covers the complete `LocalRunner` call, including model work and
worker IPC, but excludes HTTP. Jev latency covers HTTP dispatch through the
complete response body, including network and provider time. Both exclude
response validation. Throughput includes measured-loop validation and overhead,
but excludes report persistence and permutation calls. Percentiles use nearest
rank across all attempted calls, so failures cannot improve the chart by omission.

The initial call is not a cold-machine/server result: model verification primes
the filesystem cache; provider model state and caching are unknown. Repeated
inputs may benefit from caching. The shared host is not isolated. Native backend
probing does not measure GPU utilization. System memory is not peak model RSS.

Qwen usage counts each fully wrapped prompt; output is zero because the adapter
reads first-token probabilities without returning generated text. Jev usage is
provider reported; missing counters invalidate a response. Tokenizers differ,
so input counts are not a model-independent work measure. Cost uses the published
Jev input price, $0.042 per million tokens with output free, checked September 20,
2026. Known reported usage is an estimate, not an invoice; failed-call billing
may be unknown. Initial, warmup, and permutation usage appears in the experiment
total separately from the 216 measured calls.

Reports record the exact Git commit, relevant dirty-worktree flag, runtime,
harness, fixture, warmup fixture, and lockfile hashes, plus OS, CPU, Bun, native
backend, and verified local weight pins. Hosted model identity is provider
asserted; client region and provider hardware/caching are not independently
verified. Preserve raw reports, wrong answers, and immutable source links.

## Historical forms-v1 evaluation

The original 20-case form-action evaluation remains available in
[the local report](../site/data/forms-v1-m5-max-2026-09-19.json) and
[the Jev report](../site/data/forms-v1-jev-2026-09-20.json).
It used 100 repeated timing calls per model. Jev reached 20/20, Qwen3 1.7B 18/20,
and Qwen3 0.6B, CUA-S1 Forms, and Needle each 8/20. These results prompted the
narrower supported product and broader evaluation; they have not been removed.

The current `benchmark-local.ts` runs this historical fixture on Qwen only;
`benchmark-jev.ts` runs it on Jev. For exact reproduction of the removed CUA
and Needle adapters, use the
[original local source at 83ca299](https://github.com/hraness/sys1/tree/83ca299)
with its instructions. The
[original Jev source at e770483](https://github.com/hraness/sys1/tree/e7704839f24e6dc6c07098d32c4e5c21067a9645)
also remains immutable. Those adapters are no longer included in Sys1 0.9.

## Direct Laya MLX candidate study

The [pinned reproduction kit](laya/reproduction.md) runs the same decisions-v3
cases and grading directly through Laya's typed-decisions MLX checkpoint. It
is a separate supervised research harness, not a bundled Sys1 backend. Exact
input-token and marker equality excludes silent truncation for every scheduled
request. The original response and normalized checkpoint identity are retained.
See the [complete report](../site/data/decisions-v3-laya-2026-09-20.json).

Direct Agent.predict latency excludes IPC and HTTP; measured-loop throughput
includes IPC and validation. Keep those boundaries distinct from the Qwen
runner. The candidate reached 30/72 correct despite its fast native inference.
It is not generally qualified for application decisions.
