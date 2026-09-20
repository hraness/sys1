# Model comparison: evidence and measurement

The two built-in paths in Sys1 0.9 are hosted Jev 1.13.0 and experimental
local Qwen. Qwen3 1.7B remains the local setup selection; 0.6B and 3.5 4B
require explicit selection. No local candidate is generally qualified. CUA and Needle
adapters have been removed; their historical measurements remain below.
See [the current comparison](https://sys1.io/compare) and
[the reproducible evaluation method](../benchmarks/README.md).

Upstream evidence checked **2026-09-20**; Jev pricing reconfirmed **2026-09-20**.

## JevBench v1.2.6: external cross-model reference

Sys1 now refers to the pinned [JevBench v1.2.6 snapshot](https://github.com/fstandhartinger/jevbench/tree/v1.2.6) for the external Jev-class leaderboard rather than duplicating its full suite. This is an explicit snapshot, so later JevBench revisions are not silently mixed into these numbers. The [results and methodology](https://github.com/fstandhartinger/jevbench/blob/275763201a29d6083d4ee1431d709c296ef81281/RESULTS-v1.2.md) and [reproducible JSON artifact](https://github.com/fstandhartinger/jevbench/blob/275763201a29d6083d4ee1431d709c296ef81281/results/v1.2/jevbench-v1.2-results.json) are pinned to commit `275763201a29d6083d4ee1431d709c296ef81281` (tag `v1.2.6`). The [implementation rules](https://github.com/fstandhartinger/jevbench/blob/275763201a29d6083d4ee1431d709c296ef81281/IMPLEMENTATION.md) and [hard-tier notes](https://github.com/fstandhartinger/jevbench/blob/275763201a29d6083d4ee1431d709c296ef81281/datasets/HARD-TIER.md) are the audit trail.

| System | JevBench Score | Rank | Run condition |
| --- | ---: | ---: | --- |
| Jev 1.13.0 | 75.4 | 1 | Hosted API |
| SemIf · Qwen3.5 4B | 74.7 | 2 | GPU endpoint |
| djev · DiffusionGemma | 74.3 | 3 | Hosted API, free preview |
| openJev Verdict 1.4 | 72.5 | 4 | Local CPU |
| Laya · 421M | 70.1 | 5 | Local CPU |
| OpenJev · DiffusionGemma 26B | 67.7 | 8 | GPU server |

The table selects the leading rows plus the DiffusionGemma GPU reference; it is not a complete ranking. The score is a 25:25:25:25 geometric mean of intelligence, calibration, serial p50/p95 speed, and dollars per 1,000 decisions over 534 decisions (72 easy, 96 standard, 146 judge, 220 hard). The hard tier has 111 public and 109 held-out cases, frozen and hashed before evaluation. JevBench reports native probability distributions separately from verbalized JSON paths, preserves per-task outcomes, and applies no retries or repair.

These are point estimates from one serial run, not confidence intervals or a seed sweep. This is external evidence, not Sys1 qualification. djev is a hosted Maisa DiffusionGemma implementation, while the OpenJev DiffusionGemma row is a separate GPU server. Self-hosted latency receives an explicit ×2 + 0.15 s adjustment; it is an assumption. The suite is English, partly LLM-authored/reviewed, the held-out cases are sent to evaluated services, and cost can be estimated for unbilled/local runs.

For local follow-up, the most practical JevBench candidates are openJev Verdict 1.4, Laya, jeff, open-jev-deberta-v3-large, and GLiNER2. The Jev-compatible [OpenJev DiffusionGemma server](https://github.com/razorback16/openjev) is the clearest local GPU path (NVIDIA 24 GB or more, native probabilities, `/v1/systemone`), but its vLLM branch and server quality still need qualification. DiffusionGemma is a 26B block-diffusion model intended for GPU runtimes; an experimental Apple Silicon adapter exists, but it has no held-out Sys1 quality or calibration result. Any local run should pin its adapter, checkpoint, hardware, probability source, and exact JevBench revision.

The publisher results below are separate from our
[September 19 local adapter](#local-sys1-result-snapshot) and
[September 20 hosted Jev](#hosted-jev-result-snapshot) measurements. Different models, hardware,
workloads, and timing boundaries answer different questions. Sys1 provides a
common interface and routing policy; it does not make the underlying models
equally fast or accurate.

## Jev: hosted decisions and input-token pricing

| Measure | Published value | Scope |
| --- | --- | --- |
| Current model | `jev-1.13.0` | `jev-latest` resolves to this version |
| Input price | $0.042 / million tokens | Output tokens are free |
| End-to-end latency | 70–500 ms | Vendor launch range; no percentile or sample count supplied |
| Workflow result | 67.8% reference agreement; approximately 0.4 s and $0.0004 per case | Rounded chart values, equally averaged across four workflows |

Pricing and model identity come from [TypeSafe's model reference](https://docs.typesafe.ai/models).
The $0.042 per million input tokens and free output rate was reconfirmed on
September 20, 2026; the remaining upstream evidence retains its September 19
check date.
The [September 15 launch](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
says latency evaluations generally ran from West Coast laptops against its
West Coast service. The [workflow evaluation](https://evals.typesafe.ai/) uses
frontier-model consensus as its reference, not human ground truth. These
figures do not establish accuracy on your application's decisions.

## OpenJev: throughput changes with concurrency

This is [razorback16/OpenJev](https://github.com/razorback16/openjev/blob/91d5005effcf8cc0ecccaa9538ceabbb130fef59/README.md),
a DiffusionGemma 26B-A4B NVFP4 server using vLLM. Its published test uses an
RTX PRO 6000, reports “38% of the GPU,” and sends three questions per request
with cache-busted states.

| Concurrent requests | Requests / second | p50 latency | p95 latency |
| ---: | ---: | ---: | ---: |
| 1 | 10.7 | 94 ms | 94 ms |
| 16 | 43.3 | 367 ms | 369 ms |
| 32 | 51.7 | 545 ms | 618 ms |
| 64 | 57.4 | 760 ms | 1,109 ms |

More concurrency increased aggregate throughput and individual waiting time.
The table does not disclose sample count, input-token distribution, or an
accuracy result. It is not evidence that OpenJev outperforms Jev or a laptop
model. Source revision: `91d5005`, September 18, 2026.

## SemIf: direct scores versus generated answers

[SemIf, formerly TheoLeeCJ/OpenJev](https://github.com/TheoLeeCJ/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/docs/RESULTS.md),
is separate research, not a bundled Sys1 integration. Its comparison holds
Qwen3.5-4B BF16, an RTX 3090, one state, and 21 binary questions fixed.

| Output path | Median completion | Generated answer tokens | Result |
| --- | ---: | ---: | --- |
| Direct option scores | 1.023 s | 0 | 21 probability pairs |
| Compact JSON generation | 5.332 s | 111 | 21 yes/no values |

Each median covers three runs. The generated path starts producing tokens at
0.489 s but finishes later; first-token time is not decision-completion time.
The paths agree on only 18 of 21 choices, so the 5.21× timing difference does
not prove equal semantic quality. See the [raw results](https://github.com/TheoLeeCJ/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/results/raw/decision-vs-compact-array.json).

Its [evaluation method](https://github.com/TheoLeeCJ/SemIf/blob/ca3ba65f142967030ecb453346e94d6f476a69df/docs/METHOD.md)
excludes model loading from warm timing. Published quality results concern
native BF16 checkpoints, not Sys1's Qwen3 0.6B or 1.7B GGUF artifacts. Source
revision: `ca3ba65`, September 19, 2026.

## Local models: match the artifact and task

The historical Sys1 0.8 registry pinned these downloads. The current
[registry](../src/local/store.ts) includes only Qwen artifacts:

| Builtin model | Artifact | Download size | Role |
| --- | --- | ---: | --- |
| Qwen3 0.6B | Q4_0 GGUF | 382,156,480 bytes | Explicit diagnostic option; not the default |
| Qwen3 1.7B | Q4_K_M GGUF | 1,107,409,472 bytes | Default local experiment |
| Qwen3.5 4B | Q4_K_M GGUF | 2,740,937,888 bytes | Explicit experimental candidate |
| CUA-S1 forms | PyTorch checkpoint | 2,840,436 bytes | Removed in 0.9; historical measurement |
| Needle 3 | `.cact`, plus platform engine | 35,335,380 bytes, plus engine | Removed in 0.9; historical measurement |

Download size is not peak RAM. Published artifacts:
[Qwen 0.6B](https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/tree/50968a4468ef4233ed78cd7c3de230dd1d61a56b),
[Qwen 1.7B](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/tree/d7f544eead698dbd1f15126ef60b45a1e1933222),
[CUA-S1](https://huggingface.co/cua-ai/cua-s1-forms/blob/f54adbf447f4ca6ec259f529ee3f2e3e09f8cc71/README.md),
[Needle](https://huggingface.co/Cactus-Compute/needle3/tree/b009f8937124b2d0458f4ed040c10c41fd2a0dfc).
CUA-S1 and Needle required explicit selection in 0.8; both adapters are removed
in 0.9. These artifact links explain the historical measurements only.

[Qwen's generation benchmark](https://qwen.readthedocs.io/en/latest/getting_started/speed_benchmark.html)
reports 414.17 tokens/s for 0.6B and 227.80 for 1.7B: BF16, SGLang
0.4.6.post1, one H20 96 GB GPU, batch one, one input token and 2,048 generated
tokens. Its rate counts input plus output over elapsed time. These are not
Sys1's quantized llama.cpp decision speeds.

The [Needle 3 release page](https://cactuscompute.com/needle) reports
400–4,000 decode tokens/s and 1,000–10,000 prefill tokens/s on Raspberry Pi 5
across its model family. It does not give a sample count or a matching
sequence length for that range. Those rates are not request latency, and its
current 8–29 MB family description does not describe Sys1's older pinned
artifact byte-for-byte.

Needle's [published quality chart](https://huggingface.co/Cactus-Compute/needle3/raw/c1fc4d4cb32993156a880ceb8ff171b03b1f166a/assets/benchmarks.svg)
reports 20-layer accuracy of **86.0%** on Mobile Actions (961 rows, exact call)
and **47.0%** on DroidCall (200 rows, exact ordered calls). Task choice changes
the result substantially. These evaluations use its shipped CQ2 binary and
confidence gate, not Sys1's adapter. No corresponding Sys1 quality result is
established for CUA-S1, Qwen, or Needle by these sources.

## Tokens, cost, and useful measurements

Jev processes shared state once. Its [documented budgets](https://docs.typesafe.ai/models)
are 64k tokens for state plus all questions and 32k for state plus the longest
question. Account token/request rate limits are quotas, not measured speed.

At the published price, **1,000 billable input tokens × 1 million requests =
$42**. This illustrative calculation excludes retries. Use reported billable
tokens; characters, JSON bytes, and another model's tokenizer are not substitutes.
The [official SDK](https://docs.typesafe.ai/sdk/python/api/types/responses)
allows missing usage counts: unknown is not measured zero.

Zero generated answer tokens still requires input computation. Local execution
avoids a hosted per-token bill but consumes hardware, memory, and electricity.
For an adoption decision, measure the same labeled inputs and exact model
revision: cold load separately from warm p50/p95 latency, failures, correct
decisions per second, peak memory, and confidence calibration. Keep request
count separate from question count, and record quantization, concurrency,
cache state, token-count provenance, and sample size alongside every result.

## Local Sys1 result snapshot

The [public raw report](../site/data/forms-v1-m5-max-2026-09-19.json) records
the September 19, 2026 run: 100 repeated calls per adapter, on an Apple M5 Max
with 36 GiB system RAM, Bun 1.3.14 and a Metal capability probe. Source `83ca299` was unmodified for
all runtime/harness inputs. This is a shared development host, not isolated hardware.

| Adapter | Correct / 20 authored cases | p50 / p95 adapter latency | Valid responses |
| --- | ---: | ---: | ---: |
| CUA-S1 Forms | 8/20 | 54.8 / 60.7 ms | 100/100 |
| Cactus Needle 3 | 8/20 | 143.5 / 171.3 ms | 100/100 |
| Qwen3 0.6B | 8/20 | 206.6 / 225.1 ms | 100/100 |
| Qwen3 1.7B | 18/20 | 258.3 / 271.4 ms | 100/100 |

These narrative submit/correct/wait questions differ from CUA’s native
TASK/FORM/ELEMENT observations and field-action candidates. Needle is adapted
from extraction to choice. The test measures request-format transfer, not
native specialist performance. All four passed schema validation; only Qwen
1.7B achieved high correctness on this tiny fixture, and even it missed two
cases. None is qualified for a broad automatic application migration by this
experiment. Always choosing the most frequent label yields 7/20.

Both Qwen tiers report 12,960 input tokens over 100 calls (129.6 per call).
CUA token throughput is inapplicable; Needle accounting is not exposed. The
[methodology and harness](../benchmarks/README.md) disclose startup/cache
boundaries, percentiles, timing exclusions, sample counts, and failure rules.

## Hosted Jev result snapshot

The [September 20, 2026 raw report](../site/data/forms-v1-jev-2026-09-20.json)
records a completed live run against `jev-1.13.0`, using the same twenty
synthetic cases as the local snapshot. The
[exact hosted harness](https://github.com/hraness/sys1/blob/e7704839f24e6dc6c07098d32c4e5c21067a9645/scripts/benchmark-jev.ts)
is from source `e7704839f24e6dc6c07098d32c4e5c21067a9645`, with relevant
worktree inputs unmodified. This is distinct from local source `83ca299`.
The client ran Bun 1.3.14 on an Apple M5 Max, macOS / Darwin 25.5.0.

| Model | Correct / 20 first-pass cases | Valid / correct repeated calls | p50 / p95 client HTTP latency | Valid decisions / second |
| --- | ---: | ---: | ---: | ---: |
| Jev 1.13.0 | 20/20 | 100/100 valid; 100/100 correct | 246.1 / 343.0 ms | 3.89 |

The run used concurrency one, three initial client calls, two warmups, and
five passes over the twenty cases, with no retries, errors, or skipped calls.
Repeated calls provide timing observations, not 100 independent quality
examples. A perfect score on this tiny authored fixture does not establish
general model quality, confidence calibration, or production readiness.

Jev latency includes network, provider processing, and receipt of the complete
HTTP body, excluding JSON/protocol validation. Local latency covers the
adapter and excludes HTTP; neither measures isolated hosted inference time.
Throughput includes repeated-phase validation and loop overhead. Client
region was not independently verified; provider hardware, load, and cache
behavior are unknown. The returned model identity is provider-asserted, not
an independently checked weight hash. One question per request does not test
Jev's shared-state fan-out advantage.

| Phase | Provider-reported input tokens | Provider-reported output tokens | Estimated input cost |
| --- | ---: | ---: | ---: |
| 100 repeated calls | 34,760 | 3,800 | $0.00145992 |
| All 105 calls, including initial calls and warmups | 36,510 | 3,990 | $0.00153342 |

All 105 calls supplied validated usage. Output counts are nonzero; output is
free under the [published pricing](https://docs.typesafe.ai/models), reconfirmed
September 20. These counters do not independently identify the model's internal
inference method. Costs use $0.042 per million reported input tokens and are
estimates, not invoices. The immutable report retains the harness's September 19
price-check date; the September 20 reconfirmation is separate publication evidence.

## Local failure patterns and integration readiness

The first measured pass shows systematic answer collapse. Qwen3 0.6B and
Needle each select `submit` on 19 of 20 cases and `wait` once, never `correct`.
CUA selects `correct` on 15 of 20 cases, `submit` three times and `wait` twice.
All five passes preserve these choices. No label/index mapping defect was
found in the inspected adapters; that does not prove the adapters are sound.
The fixture holds option order fixed, so it cannot distinguish position bias
from semantic failure. These are real failures of the shipped paths on this task.

A confidence threshold would retain many errors: all twelve wrong first-pass
Needle answers and ten of twelve wrong Qwen 0.6B answers report confidence at
least 0.90. Confidence here is not an empirically calibrated success probability.

At the historical forms-v1 source revision, setup recommendations chose
Qwen 1.7B at 16 GiB system memory and above, or 0.6B below that threshold.
Unpinned routing preferred the smallest model among eligible
local candidates. With both Qwen tiers available, 0.6B is selected when policy
chooses local execution; the `auto` policy prefers an available hosted backend. Specialists already
require explicit selection. Installed, supported, and schema-valid do not mean
application-qualified. Pin a model for application evaluation and retain
application-owned deterministic fallback; broad automatic migration from Jev
is not supported by the current evidence.

The next proposed checks at that point were all six option-order permutations, then fresh held-out
cases and a same-weights comparison of Qwen's first-token readout against
ordinary constrained generation. CUA also needs native TASK/FORM/ELEMENT cases
and reference-forward parity; Needle needs native extraction controls. Preserve
this published baseline when evaluating changes rather than replacing it with
only the successful runs.

## Broader frozen decisions-v2 result (September 20)

The original forms-v1 result did not generalize. The new fixture was authored
and frozen before execution, with 72 cases across nine workflow families and
all three answer types. Both local runs completed 362 planned calls: two old
form warmups, 216 measured calls, and 144 option-order permutations.

| Model | First-pass correct | Choice | Noul | Score | Invariant choice cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3 1.7B | 32/72 | 12/24 | 13/24 | 7/24 | 7/24 |
| Qwen3 0.6B | 25/72 | 8/24 | 12/24 | 5/24 | 0/24 |

The best constant label per choice family plus constant Noul and Score answers
gets 27/72. Qwen3 1.7B exceeded that reference by only five cases. It predicted
true 23/24 times and score level 1 twenty times, never levels 0 or 3. Of 40
wrong first-pass answers, 35 had confidence at least 0.90. Five invariant choice
cases were always correct; two were always wrong. Its permutation correctness
was 18/48, 31/48, and 17/48 when the expected option appeared first, second, or
third. All three measured passes gave identical decisions. These results do
not support confidence-based approval or dependable general local fallback.

| Model | p50 / p95 | Valid decisions/s | Valid measured calls | Input / output tokens |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 1.7B | 213.6 / 247.6 ms | 4.63 | 216/216 | 45,183 / 0 |
| Qwen3 0.6B | 209.6 / 255.0 ms | 4.73 | 216/216 | 45,183 / 0 |

These are local-runner timings, including model/IPC and excluding HTTP. Same
Apple M5 Max, 36 GiB system memory, Darwin 25.5.0, Bun 1.3.14; Metal capability
probe, without per-inference GPU instrumentation or memory measurement. Score
weighted-value MAE on 24 valid first-pass cases was 0.92867 for 1.7B and 0.94992
for 0.6B; a constant numeric prediction of 1.5 has MAE 1.0 on these labels.

Raw reports: [1.7B](../site/data/decisions-v2-qwen17-2026-09-20.json),
[0.6B](../site/data/decisions-v2-qwen06-2026-09-20.json). Fixture SHA-256 is
`7e1b3e988c9c27eae96efd1782cb301d998204b94a09ed915bebe0ad3d97e69b`.
The 1.7B run's relevant sources were clean at
`b9e423dbb425e8dc5f09cafa44294cd0b72058c6`. The 0.6B run records the same HEAD
with a dirty-source flag because the CLI-only hosted-policy correction was in
progress. Its complete recorded runtime-source digest,
`06a03e78d3c309e133badb7f3048a6192b1d57eaf3c9f63cef516da6df5d1550`,
was independently matched to committed source `a1faf3f` before any later runtime
edit. The inference engine, prompts, fixture, and harness were unchanged
between these two runs. The original reports and dirty flag are preserved.

The [new Jev attempt](../site/data/decisions-v2-jev-auth-incomplete-2026-09-20.json)
received HTTP 401 three times and stopped with no valid answers. It is an
incomplete authentication failure, not a new accuracy or speed measurement.
The earlier completed 20-case Jev result remains separate.

Product consequence: `sys1 jev enable` now selects hosted-only operation.
Local substitution requires an explicit routing-policy change after the
application evaluates the chosen model. Setup preserves a hosted-only policy.
Neither a valid schema nor high reported confidence authorizes model switching.

## Fresh decisions-v3 Qwen3.5 evaluation (September 20)

The [complete Qwen3.5 report](../site/data/decisions-v3-qwen35-2026-09-20.json)
uses 72 new cases, frozen before execution. The source was clean at
`476a2a04140344c01d0797c0fc250823d394605b`; the fixture SHA-256 is
`992d0078faff0f781d87be0755828b48689345e4a8a68d20b25f12b7a0fa87cc`.
The independently recomputed report SHA-256 is
`0720e2796ddbadf5013a61fb9c506663d959ae1d75bb0f366a3836d9932a5e5c`.

The pinned Q4_K_M candidate uses the model's Qwen3.5 chat template with thinking
disabled by its wrapper. The old `/no_think` text is absent: Qwen3.5 does not
support that Qwen3 soft switch. Native admission identified architecture
`qwen35`, Metal, 33 GPU layers, and 2,048 context tokens.

| Measure | Qwen3.5 4B |
| --- | ---: |
| Correct first-pass cases | 44/72 (61.1%) |
| Choice / Noul / Score | 16/24 · 16/24 · 12/24 |
| Constant-label reference | 27/72 |
| Order-invariant choices | 13/24; ten always correct, three always wrong |
| Correct reordered calls | 90/144 |
| Valid / correct repeated calls | 216/216 valid; 132/216 correct |
| p50 / p95 local adapter latency | 464.7 / 540.8 ms |
| Valid decisions / second | 2.13 |
| Measured input / generated output tokens | 44,604 / 0 |
| All-call input / generated output tokens | 75,237 / 0 |
| Score expected-value MAE | 0.7271 over 24 cases |

Noul returned true on 20/24 cases and missed eight of twelve false cases.
Score selected level 1 on 13/24. Identical repeated predictions establish
repeatability, not correctness. All 362 responses passed request-matched
validation; all grades, schedule entries and summary values were independently
recomputed. No demonstrated label-mapping bug explains the failures. These
results test Qwen through this one-token adapter, not its broader generative
capabilities. Source and fixture changed from v2, so comparing their aggregate
scores does not establish a same-benchmark improvement. Keep Qwen experimental.

### Bounded reasoning feasibility

A separate exploratory prototype took the first four cases of each question
type from the already observed v3 fixture. It allowed up to 512 private
reasoning tokens, waited for a natural thought close, then read label
probabilities. No reasoning text was retained. This was one feasibility test,
not a fresh holdout or a shipped mode.

The [complete feasibility report](../site/data/qwen35-reason-score-2026-09-20.json)
records 7/12 correct with the current path versus 3/12 with reason-then-score.
Nine reasoning attempts reached the token cap before returning a valid answer.
Median latency across attempts increased from 495 ms to 9,867 ms. The
prototype was not adopted. A longer budget was not tested; these results do
not establish that reasoning is generally ineffective.

## Laya-MLX external-runner candidate

Laya-MLX is a separate Python/MLX implementation for Apple Silicon, not bundled
with Sys1. Its bidirectional encoder and trained decision heads directly
produce named Choice probabilities, a zero-based Score distribution and
expected value, and Noul's probability of true. A thin external runner could
make these available through Sys1's existing explicitly pinned HTTP-backend
interface without adding another model loader to the core package. That
integration is a proposed fit, not a shipped feature.

The source audit pinned `mizorewww/laya-mlx` at
`fc1df62828a3fedf4d8229fdac1cbd85f1cdf337`. The selected experiment uses
`aac6fef/laya-typed-decisions-mlx`, revision
`28416e78cb26a239a4eabaa2e084904ec5e6cacb`, with weight SHA-256
`804ef8802b4cac7a67913b0cfb8448659e934a50284aaa867b98d7d9a6e7d1e0`.
The checkpoint's name does not imply general superiority: upstream describes
specialization on four synthetic workflow families and keeps its automatic
selection disabled by default. See the pinned
[architecture](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/laya_mlx/model.py#L201-L234),
[published checkpoint pins](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/benchmarks/results/hub-publication.json),
and [specialization caveat](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/laya_mlx/router.py#L1-L32).

Upstream's 378/378 answer agreement is **port fidelity**, comparing three
checkpoints and two precisions against the original runtime on 63 questions.
It does not mean those answers were correct. The published labeled sample
contains 256 AG News test examples: 245 correct for English, 242 multilingual,
and 247 typed-decisions; the recorded predictions independently reproduce
those totals. AG News belongs to upstream's training-task mix. This narrow
classification result does not establish accuracy on Sys1's boolean exceptions,
arithmetic, rubric scoring or reordered options. Published millisecond timings
are upstream M3 Max measurements with loading excluded, not measurements of
a Sys1 runner. See the
[parity results](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/benchmarks/results/validation.json),
[labeled results and limitations](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/benchmarks/results/accuracy.json),
and [timing method](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/BENCHMARKS.md).

The typed checkpoint has a 1,024-token context including instructions, options
and state, with a separate question-head budget. Upstream silently shortens
options, instructions and state, and replaces literal mask-token strings.
A Sys1 boundary must reject any changed or truncated evidence before inference;
checking final context length alone is insufficient. Its raw model name is
always `laya-rl-agent`, so a runner must supply the actual pinned checkpoint
identity and project the supported answer fields. Input usage counts retained,
unpadded tokens per question, including repeated state; zero output tokens
means no generated text. Confidence is not proven calibration on these tasks.
There is no native cancellation API: an independently supervised process must
own deadlines, shutdown and cleanup. These are integration requirements, not
capabilities Sys1 has already added. See the pinned
[formatter](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/laya_mlx/common.py#L60-L114)
and [prediction path](https://github.com/mizorewww/laya-mlx/blob/fc1df62828a3fedf4d8229fdac1cbd85f1cdf337/laya_mlx/agent.py#L173-L253).

### Direct Laya decisions-v3 result (September 20)

The [complete direct-candidate report](../site/data/decisions-v3-laya-2026-09-20.json)
uses the same frozen 72 cases and 362-call schedule as the Qwen3.5 evaluation
above. The [reproduction bundle](../benchmarks/laya/reproduction.md) preserves
the exact supervisor, worker, schedule and input-preservation preflight.
The report SHA-256 is
`088df3c18fe05f4444f50cc253583d16b70ad088545104819f14f5e6a98e258d`.
Every request passed an exact comparison between its full intended token
sequence and Laya's prepared input before inference. All 362 preserved their
instructions, options and state; the maximum was 166 tokens, with at most 18
tokens per option, against the pinned checkpoint's 1,024-token context and
256-token head budget. The checkpoint and formatter were unchanged.

| Measure | Laya typed-decisions MLX FP16 |
| --- | ---: |
| Correct first-pass cases | 30/72 (41.7%) |
| Choice / Noul / Score | 9/24 · 13/24 · 8/24 |
| Constant-label reference | 27/72 |
| Order-invariant choices | 20/24; nine always correct, eleven always wrong |
| Correct reordered calls | 57/144 |
| Valid / correct repeated calls | 216/216 valid; 90/216 correct |
| p50 / p95 direct prediction latency | 9.74 / 15.32 ms |
| Valid decisions / second, including IPC and validation | 89.62 |
| Measured input / generated output tokens | 29,157 / 0 |
| All-call input / generated output tokens | 48,860 / 0 |
| Score expected-value MAE | 0.9349 over 24 cases |

The run used an Apple M5 Max with 36 GiB memory, Python 3.12.14, MLX 0.32.2,
GPU execution, FP16 and batch size one; compilation and prompt caching were
disabled. Latency times synchronous `Agent.predict`, including tokenization
and evaluated results, but excludes process IPC, normalization/validation,
model loading and HTTP. The measured loop takes 2.410 seconds including IPC
and validation. Qwen's latency includes its worker IPC, while Jev's includes
network/provider time: these are different boundaries, not isolated inference
speed ratios. No API charge is recorded; local compute is not cost-free.

All 362 responses were valid, and grades, distributions, projection from raw
answers, usage and provenance were independently checked. All three measured
passes gave identical answers. The strong order-invariance count includes
eleven consistently wrong choices, so it does not rescue decision quality.
The upstream action probability was 1 on all 72 first-pass cases, including
42 mistakes; it must not serve as application approval. These results support
a fast experimental inference path, not a dependable general local substitute
for Jev or a reason to enable automatic fallback.

All responses completed before the worker acknowledged disposal, reporting
zero cache bytes and 22 active bytes. The supervisor then sent SIGTERM before
observing natural process exit and collected the worker. The raw report keeps
that signal and a null exit code; it does not establish a clean natural exit.
This direct experiment is not a shipped HTTP integration or an endurance test.
