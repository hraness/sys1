# Kev, decision profiles, and fine-tuning

Sys1 can route typed decisions to an operator-run [Kev server](https://github.com/jaredpalmer/kev). Kev supplies a Qwen-based LoRA adapter and pointer head; Sys1 supplies the application interface, routing policy, and reusable question definitions. Kev remains a separate Python process with its own checkpoint and hardware requirements.

This guide audits Kev source at [`e943f21e40574d99cefb2d292089333bcda9047c`](https://github.com/jaredpalmer/kev/tree/e943f21e40574d99cefb2d292089333bcda9047c). Compatibility checks establish the request and response contract. They do not establish a model's accuracy, calibration, latency, or fitness for your application. No Kev model inference or training was run for this integration.

## Connect a Kev server

Kev requires Python 3.12+, PyTorch, Transformers, and PEFT. Its server selects CUDA, Apple MPS, or CPU. The current Qwen3.5 models have a slower reference implementation on Apple Silicon; an MLX implementation is not part of the pinned source. See the upstream [runtime requirements](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/pyproject.toml) and [serving notes](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/README.md#serving-performance) before choosing a model.

The following commands install Kev and explicitly download its checkpoint. Starting the server also downloads the required base weights if they are absent. Sys1 does not perform these downloads or manage this process.

```sh
git clone https://github.com/jaredpalmer/kev.git
cd kev
git checkout e943f21e40574d99cefb2d292089333bcda9047c
uv sync --extra serve

KEV_CHECKPOINT="$(uv run python -c 'from kev.evaluate import resolve_run; print(resolve_run("jaredpalmer/kev-4b@485ace8703592fcf405488b262449990824cfed1"))')"
KEV_DTYPE=bf16 uv run --extra serve python -m kev.serve \
  --run "$KEV_CHECKPOINT" --fallback "$KEV_CHECKPOINT" --port 8009
```

The checkpoint revision is an explicit reproducibility example, not an automatically updated recommendation. Its [metadata](https://huggingface.co/jaredpalmer/kev-4b/tree/485ace8703592fcf405488b262449990824cfed1) identifies the Qwen3.5-4B base. Use a resolved local directory: this version of `kev.serve` incorrectly treats a direct `--run owner/model@revision` argument as a missing local run and can fall back to `runs/smoke`, even though its underlying checkpoint resolver supports revisions. Setting the same explicit directory as the fallback prevents switching to the smoke checkpoint if the directory disappears.

In a second terminal, inspect what actually loaded:

```sh
curl --fail http://127.0.0.1:8009/v1/models
```

Check `run`, `base`, and `temperature` against your intended deployment. Kev's advertised ID is always `kev-latest`; the request's `model` field is echoed and does **not** select or verify the loaded weights. Serve different checkpoints on separate ports and register each under a distinct Sys1 backend name.

```sh
sys1 backend add --adapter kev --name kev \
  --url http://127.0.0.1:8009 --model kev-latest
sys1 backend check --name kev
sys1 up
```

`backend check` sends bounded synthetic requests to verify compatibility. It does not evaluate private application data or prove decision quality. The daemon rereads backend configuration for each request. A `hosted-only` routing policy excludes this loopback backend; explicitly select `local-only` when you intend to keep all decisions on this machine:

```sh
sys1 config set routing.policy local-only
```

Kev is explicit-only. Pin `kev/kev-latest` in each request or profile; an unpinned request will not automatically adopt it. The backend name identifies your configured server, while `kev-latest` is its wire model ID.

```sh
sys1 eval <<'JSON'
{
  "model": "kev/kev-latest",
  "state": "I was charged twice for my order.",
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this ticket?",
      "criteria": {
        "billing": "Payments, charges, and refunds",
        "shipping": "Delivery status and lost parcels",
        "access": "Sign-in and account access"
      }
    }
  }
}
JSON
```

Kev binds to `127.0.0.1` and supplies no authentication. Keep it on loopback unless you separately deploy an authenticated service. An off-machine URL is hosted traffic in Sys1, regardless of who owns the server.

## Keep application decisions in profiles

A profile versions the questions, criteria, and model route for a task. Callers provide only the changing state. The same profile can begin as hand-written instructions and later target a tuned checkpoint; application code keeps the same request shape.

```ts
import { createClient, createProfile } from "@hraness/sys1/client";

const triage = createProfile({
  version: 1,
  id: "ticket-triage",
  revision: "1",
  model: "kev/kev-latest",
  questions: {
    team: {
      type: "choice",
      instructions: "Choose the team responsible for resolving the primary issue.",
      criteria: {
        billing: "Payments, charges, and refunds",
        shipping: "Delivery status and lost parcels",
        access: "Sign-in and account access",
      },
    },
  },
});

const client = createClient();
const result = await client.evaluate(triage.request({
  subject: "Duplicate charge",
  body: "I see two charges for one order.",
}));
console.log(result.response.answers.team);
```

Save that profile definition as JSON to use it from the CLI, or copy the
[ready-to-edit example](../examples/ticket-triage.profile.json):

```sh
sys1 eval --profile ticket-triage.json <<'JSON'
{"state":{"subject":"Duplicate charge","body":"I see two charges for one order."}}
JSON
```

With `--profile`, the input is an object containing only `state`. Questions and the model route come from the profile. Keep the profile in your application's source control and change its revision whenever instructions, criteria, or the route change. Profile identity is application metadata, not a new field sent to Kev, a prompt optimizer, or a checkpoint registry.

## Improve prompts before training

Start with a labelled dataset representing your application's actual decisions. Freeze train, development, calibration, and final test partitions before comparing candidates. Group duplicate tickets, related documents, and variants of the same example into one partition to avoid leakage.

Use development examples to compare small, explicit profile revisions: clearer instructions, distinct option descriptions, consistent state fields, and an `other` or `unknown` option where that is a legitimate outcome. Change one factor at a time. Compare both errors and abstention behavior; a high returned confidence is not a measured correctness rate. Option order can affect Kev's answer, so test reordered options while preserving their names.

Record the profile revision, checkpoint identity, runtime settings, dataset hash, rejected examples, accuracy, calibration, and latency for each candidate. Choose confidence thresholds on calibration data and evaluate the final choice on the untouched test partition. Sys1 does not automatically tune prompts or collect requests into a training corpus.

## Fine-tune outside Sys1, then attach the result

If the fixed profile still misses domain-specific rules, use Kev's [fine-tuning implementation](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/kev/train.py). A labelled JSONL file uses the API request shape with a `label` added to every question. Each record occupies one line:

```jsonl
{"state":"I was charged twice.","questions":{"team":{"type":"choice","instructions":"Choose the team responsible for resolving the primary issue.","criteria":{"billing":"Payments, charges, and refunds","shipping":"Delivery status and lost parcels","access":"Sign-in and account access"},"label":"billing"}}}
```

Choice labels are option names, Noul labels are booleans, and Score labels are integer indices into the ordered criteria. Validate labels before training: Kev's custom loader checks that labels exist, but some label values are coerced later. Use the same profile instructions and criteria when creating training examples and when serving the resulting model.

The following is a starting recipe for a separately owned CUDA machine. It consumes your local `train.jsonl` and writes a new run directory. Choose resource limits and an evaluation target before running it; this guide has not executed the recipe.

```sh
uv run python -m kev.train \
  --data train.jsonl \
  --base Qwen/Qwen3.5-4B-Base \
  --base_revision 1001bb4d826a52d1f399e183466143f4da7b741b \
  --init_from "$KEV_CHECKPOINT" \
  --epochs 2 --lr 2e-5 --batch 1 --accum 8 \
  --dtype bf16 --checkpointing 1 --device cuda \
  --out runs/ticket-triage-v1

uv run python -m kev.benchmark \
  --run runs/ticket-triage-v1 --data development.jsonl \
  --out runs/ticket-triage-v1-development
```

`--init_from` loads both the existing adapter and pointer head. Starting from the base alone discards that learned decision behavior. Kev checks architecture compatibility; pin the base revision explicitly because its check permits a missing revision on either side. Optional `--suite ... --replay N` mixes records from a frozen training partition to study retention of general behavior. It can require additional dataset downloads and must never use your evaluation partition.

Training uses a much shorter context than serving: 384 state tokens, 1,024 tokens for state plus a question, and a 2,048-token packed limit. Overlong custom training records are dropped and reported. Inspect that count and every evaluation report's coverage before comparing scores. The local benchmark uses these shorter bounds too; it cannot substitute for testing your actual serving path on longer inputs.

### Calibrate the new checkpoint separately

A new fine-tuning run does not inherit the source checkpoint's fitted temperature. At this source revision, `kev.train` saves the learned head and adapter without a `temperature` field. The loader consequently uses 1.0 unless you separately calibrate or set `KEV_TEMPERATURE`.

After selecting the candidate, produce predictions on the reserved calibration partition and fit a temperature using Kev's [calibration script](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/scripts/calibrate_checkpoint.py):

```sh
uv run python -m kev.benchmark \
  --run runs/ticket-triage-v1 --data calibration.jsonl \
  --out runs/ticket-triage-v1-calibration

uv run python scripts/calibrate_checkpoint.py \
  --run runs/ticket-triage-v1 \
  --rows runs/ticket-triage-v1-calibration/rows.json

uv run python -m kev.benchmark \
  --run runs/ticket-triage-v1 --data test.jsonl \
  --out runs/ticket-triage-v1-test
```

The calibration script mutates `head.pt`; retain the original and compute final artifact hashes after calibration. It fits a global temperature and cannot guarantee calibration under distribution shift. Remove a stale `KEV_TEMPERATURE` override when serving the fitted checkpoint. If runtime precision or preprocessing differs from evaluation, verify calibration again on the served path.

Keep `adapter_model.safetensors`, `adapter_config.json`, `head.pt`, tokenizer files, `training_config.json`, and `training_metrics.json` together. Training records the initialization artifact hashes but does not create a complete deployment manifest for custom data. Record your own code SHA, base and adapter revisions, final file hashes, profile revision, dataset and split hashes, precision, temperature, preprocessing flags, hardware, and evaluation reports. Retain a previous qualified route for rollback.

Serve the final local directory on a new port, register it under a new backend name, run `backend check`, then update and evaluate a new profile revision. For example, a `kev-ticket` backend on port 8010 uses `model: "kev-ticket/kev-latest"`. The original profile and checkpoint stay available until the new one meets the acceptance criteria.

Training data can contain private source text, and evaluation output includes per-example predictions and identifiers. Keep those files private by default. Local `kev.train` does not itself upload your examples; Modal execution or model publication is a separate operation with its own data destination and cost. Sys1 neither starts those operations nor stores inference payloads as training data.

## Adapter behavior and evidence boundaries

The `kev` adapter handles the specific differences in the pinned [API serializer](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/kev/api.py) and [HTTP server](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/kev/serve.py):

- Missing instructions become `null`, which Kev renders as empty text. Explicit instructions are preserved.
- Kev rounds answer probabilities and scores to two decimals. Sys1 retains these values, including a distribution such as `0.33, 0.33, 0.33`; it validates with the declared rounding precision and does not manufacture extra precision by normalizing them.
- A very large, diffuse option set can round every probability to zero. Sys1 rejects that unusable distribution. Reduce the option set or use a server with more precise probabilities.
- Kev renders Score legends as text. After validating the response, Sys1 restores the original criterion values so callers retain the common structured legend contract.
- Sys1 continues to enforce its own request limits, including 64 questions and 2–10 Score levels. Kev allows up to 255 Choice options and 255 Score levels but publishes no `/v1/limits` endpoint. Its serving encoder requires state plus each question branch to fit within 8,192 tokens. Capability counts alone do not guarantee that an input fits or has enough memory.
- `usage.output_tokens` counts the serialized answer, not tokens generated by an autoregressive decoder. Input token counts follow Kev's encoder. Neither count implies a hosted price or measures GPU work precisely.
- Kev's choice confidence is relative to a uniform distribution; its Score confidence approximates an unpublished TypeSafe formula. These fields are not interchangeable with measured accuracy or a guarantee of calibrated risk.

The server serializes inference and caches a small number of state prefixes in memory. Its optional `KEV_DATE_FACTS` preprocessing, `KEV_LORA_SCALE`, `KEV_TEMPERATURE`, dtype, and attention settings can change the deployment being measured. Record those settings with the checkpoint; they are not profile fields or parameters Sys1 silently sends to the server.

Kev's released 0.8B, 4B, and 9B adapters are distinct from Sys1's bundled generic Qwen models. Results for either cannot be transferred to the other. Upstream results and local conformance tests are also separate from JevBench results: a Kev row belongs in that chart only after the matching checkpoint and adapter have been evaluated on the same benchmark.

Kev's code and released adapters use Apache-2.0; base models and training datasets have their own applicable terms. See the pinned [license](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/LICENSE) and [model card](https://github.com/jaredpalmer/kev/blob/e943f21e40574d99cefb2d292089333bcda9047c/docs/model-cards/kev-4b.md).
