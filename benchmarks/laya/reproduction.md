# Laya MLX direct candidate reproduction

This is an exploratory run of upstream Laya, not a Sys1 runtime adapter qualification. No repository runtime, prompt or fixture was changed. Model predictions do not generate text or reasoning traces.

The September 20, 2026 run completed all 362 calls with valid normalized responses. It answered 30/72 first-pass cases correctly (choice 9/24, noul 13/24, score 8/24), and 90/216 across three repetitions. Choice output was invariant for 20/24 cases; 57/144 permuted calls were correct. Median direct native inference was 9.738 ms, p95 15.325 ms, and the measured supervisor loop completed 89.625 valid decisions/second. This speed result excludes model loading and HTTP; it is not an isolated-machine or service-throughput claim. Input usage was 29,157 tokens measured and 48,860 across all calls, with zero generated output tokens.

All 362 requests passed the full-token/marker preflight; the longest was 166 tokens and the longest option 18 tokens. The report records a disposal message with zero cached bytes and 22 active bytes, followed by supervisor SIGTERM and process collection. It does **not** record a natural exit code zero. All 362 responses completed before that cleanup signal. The raw report and exact measured harness are preserved without a rerun or cleanup rewrite.

Pins: source `mizorewww/laya-mlx@fc1df62828a3fedf4d8229fdac1cbd85f1cdf337`; checkpoint `aac6fef/laya-typed-decisions-mlx@28416e78cb26a239a4eabaa2e084904ec5e6cacb`; safetensors 842,609,225 bytes, SHA256 `804ef8802b4cac7a67913b0cfb8448659e934a50284aaa867b98d7d9a6e7d1e0`. All downloaded model files total 846,230,667 bytes. The runtime uses Python 3.12, MLX 0.32.2 and only hashed runtime wheel dependencies from the upstream lock; no Torch, development extras, source builds, or remote model code.

On Apple silicon with Python 3.12, Bun, uv and a Sys1 checkout matching the report's grader/fixture hashes, copy these harness files from `benchmarks/laya/` into a separate scratch directory. Set `SYS1_CHECKOUT` to that checkout's absolute root; no sibling checkout is required. All source/model/environment/schedule/report paths are command arguments. The native worker, exporter and runtime requirements must remain beside the supervisor. Keep `laya-artifacts.json` beside the model directory. Use the machine's native-work scheduler where installed.

```sh
SYS1_CHECKOUT=/path/to/sys1
git clone https://github.com/mizorewww/laya-mlx.git laya-mlx-source
git -C laya-mlx-source checkout fc1df62828a3fedf4d8229fdac1cbd85f1cdf337
uv venv --python python3.12 --cache-dir ./laya-uv-cache ./laya-runtime-env
uv pip install --python ./laya-runtime-env/bin/python --cache-dir ./laya-uv-cache --index-url https://pypi.org/simple --only-binary :all: --require-hashes --no-deps -r laya-runtime-requirements.txt
python3.12 laya-download.py laya-model laya-artifacts.json
bun laya-export-schedule.ts "$SYS1_CHECKOUT" laya-v3-schedule-exact.json
hra-host-run --mode=heavy --lane=mac-native --label=laya-preflight -- ./laya-runtime-env/bin/python laya-preflight.py --source laya-mlx-source --model laya-model --schedule laya-v3-schedule-exact.json --output laya-v3-preflight.json
hra-host-run --mode=heavy --lane=mac-native --label=laya-v3 -- bun laya-v3-run.ts "$SYS1_CHECKOUT" laya-mlx-source laya-model laya-runtime-env/bin/python laya-v3-schedule-exact.json laya-v3-preflight.json decisions-v3-laya-2026-09-20.json
```

Preflight compares full untruncated token IDs and option markers against the exact upstream `Agent.prepare` output for all 362 requests. It also rejects mask-token literals. Any change or clipping blocks inference; no shortening is permitted. The native process uses GPU, float16, batch size one, no compilation, no prompt cache and the publisher's unchanged 1024-token configuration.

The schedule and grading come from Sys1's frozen decisions-v3 harness: two original forms warmups, 72 cases repeated three times, then all six permutations of each of 24 choice cases. Raw responses retain upstream `laya-rl-agent`, action fields and noul confidence. The explicit SystemOne projection sets the pinned checkpoint identity, drops only the extra action/noul-confidence fields, and preserves probabilities. The report distinguishes direct native latency from supervisor wall time and retains invalid attempts. Each call has a 60-second ceiling within an absolute eight-minute inference-process deadline, followed by bounded owned-process cleanup; three consecutive errors stop the run.

The checkpoint was trained on specific workflow families. This small authored synthetic set does not establish general quality, calibration, broad superiority or production readiness. Repeats and permutations are not independent cases; option-order invariance does not imply correctness.

Included public evidence: `laya-artifacts.json` records every downloaded file hash, `laya-hf-metadata.json` preserves the public pinned publisher metadata, `laya-v3-schedule-exact.json` contains only public synthetic requests and separate expected labels, and `laya-v3-preflight.json` records every preservation check. The raw result is published separately as `decisions-v3-laya-2026-09-20.json`. `publication-sha256.json` freezes the accompanying file bytes. Runtime environments, caches, model weights and private machine paths are not part of this reproduction bundle.
