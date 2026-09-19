# Model comparison: evidence and measurement

Checked **2026-09-19**. The upstream evidence below is separate from the [local Sys1 adapter
measurements](https://sys1.io/compare#local-results). Different models, hardware, workloads, and timing
boundaries answer different questions. Sys1 provides a common interface and
routing policy; it does not make the underlying models equally fast or accurate.

## Jev: hosted decisions and input-token pricing

| Measure | Published value | Scope |
| --- | --- | --- |
| Current model | `jev-1.13.0` | `jev-latest` resolves to this version |
| Input price | $0.042 / million tokens | Output tokens are free |
| End-to-end latency | 70–500 ms | Vendor launch range; no percentile or sample count supplied |
| Workflow result | 67.8% reference agreement; approximately 0.4 s and $0.0004 per case | Rounded chart values, equally averaged across four workflows |

Pricing and model identity come from [TypeSafe's model reference](https://docs.typesafe.ai/models).
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

Sys1's [model registry](../src/local/store.ts) pins exact downloads:

| Builtin model | Artifact | Download size | Role |
| --- | --- | ---: | --- |
| Qwen3 0.6B | Q4_0 GGUF | 382,156,480 bytes | Compact general decision candidate |
| Qwen3 1.7B | Q4_K_M GGUF | 1,107,409,472 bytes | Larger general decision candidate |
| CUA-S1 forms | PyTorch checkpoint | 2,840,436 bytes | Form-action option scorer |
| Needle 3 | `.cact`, plus platform engine | 35,335,380 bytes, plus engine | Structured extraction specialist |

Download size is not peak RAM. Published artifacts:
[Qwen 0.6B](https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/tree/50968a4468ef4233ed78cd7c3de230dd1d61a56b),
[Qwen 1.7B](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/tree/d7f544eead698dbd1f15126ef60b45a1e1933222),
[CUA-S1](https://huggingface.co/cua-ai/cua-s1-forms/blob/f54adbf447f4ca6ec259f529ee3f2e3e09f8cc71/README.md),
[Needle](https://huggingface.co/Cactus-Compute/needle3/tree/b009f8937124b2d0458f4ed040c10c41fd2a0dfc).
CUA-S1 and Needle require explicit selection; see [specialist contracts](../README.md#specialists).

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
100 repeated calls per adapter, on an Apple M5 Max with 36 GiB system RAM,
Bun 1.3.14 and a Metal capability probe. Source `83ca299` was unmodified for
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
