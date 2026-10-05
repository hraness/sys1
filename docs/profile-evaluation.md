# Evaluate a decision profile

Run a profile against labeled examples to see which decisions it gets right,
which remain unresolved, and how long the calls take. The experimental evaluator
runs from a Sys1 source checkout with Bun 1.3.14 and installed dependencies.

The included profiles explore failure triage, excerpt relevance, and claim
support. Each has eight development examples and eight separately authored
synthetic screening examples. They are small experiments for inspecting errors;
their results do not establish production reliability or faster completed tasks.

Read the [September 28, 2026 trial](../benchmarks/workflows/results/2026-09-28.md)
for recorded Jev results, deterministic comparisons, errors, and coverage.

## Check examples before calling a model

From the repository root:

```sh
bun scripts/evaluate-profile.ts \
  --profile examples/workflows/failure-triage.clef.profile.json \
  --fixtures benchmarks/workflows/failure-triage.development.json
```

The default command validates the profile, every state, and every expected
answer, then prints a JSON preview. It makes no model calls. Replace
`failure-triage` in both paths with `evidence-relevance` or `claim-support` to
inspect another workflow.

A fixture is a JSON array. Each example has a unique ID, a state, and one
expected value for every profile question:

```json
[
  {
    "id": "explicit-support",
    "state": {
      "claim": "Fable Notes version 2.0 exports notes as Markdown.",
      "excerpt": "Fable Notes 2.0: use Export to save your notes as Markdown files."
    },
    "expected": { "support": "supported" }
  }
]
```

Choice labels are option names, Noul labels are booleans, and Score labels are
integer indices into the criteria. Expected values stay out of model requests.

## Run a fixed trial

Use an already configured Sys1 gateway with access to the profile's exact
`backend/model` route. The `*.clef.profile.json` examples target `cloudflare/clef`;
they do not enable Clef, install a model, or start a gateway. Inspect configuration
with `bun src/cli.ts clef status --json` or follow the
[Cloudflare Clef setup guide](../README.md#add-cloudflare-clef). The September 28
results used the earlier Jev routes and profile hashes; they are historical,
not measurements of Clef. The original `*.profile.json` files without `.clef`
remain byte-for-byte frozen for reproducing that historical Jev trial.

After inspecting the preview, add `--run`:

```sh
bun scripts/evaluate-profile.ts \
  --profile examples/workflows/failure-triage.clef.profile.json \
  --fixtures benchmarks/workflows/failure-triage.screening.json \
  --run --max-requests 8 --timeout-ms 30000 --deadline-ms 240000
```

Calls run one at a time with no retries. `--url` selects a gateway instead of
the default `http://127.0.0.1:13900`. Errors and skipped examples remain in the
report. Keep the same profile and dataset when comparing runs, and preserve
the first result before making any changes.

The generic GGUF adapter accepts at most 96 characters per criterion. The
included hosted profiles exceed that limit. To try a local model, make a new
profile revision with shorter criteria and move explanatory detail into
instructions, then freeze and validate it before evaluating. Changing only
the route is insufficient.

## Read the result

The report identifies the profile, inputs, and composed requests with hashes.
It reports coverage, correct and incorrect answers, unresolved ties, timing,
usage, and returned route metadata. It omits raw states, question text, answer
bodies, and server error messages. Treat case and question IDs, numeric results,
and route metadata as potentially sensitive if you use your own examples.

The hashes cover JSON serialization of validated inputs; they differ from
the raw-file checksums in the fixture manifest. Returned model names and route
headers are observations, not proof of an immutable provider checkpoint.

Choice and Score grading requires a unique most-probable answer. A Noul answer
of 0.5 is unresolved. Score errors are also reported numerically. A returned
confidence is a model output, not an observed accuracy rate. Numeric probability
vectors and weighted-score absolute errors are retained for inspection. A complete run
means every example was evaluated; it does not mean every answer was correct.

These timings cover a client call through the response, including transport
and validation. Compare complete workflows separately: count corrections and
follow-up reads, and verify that the final task is still correct.

## Compare against ordinary code

The [workflow fixture directory](../benchmarks/workflows/) includes a checksum
record and fixed baselines in
[`scripts/workflow-baselines.ts`](../scripts/workflow-baselines.ts): error
signatures for triage, token overlap for relevance, and literal text checks for
claim support. These are simple comparators, not strong semantic judges.
Baseline reports include expected and predicted labels.

```sh
bun scripts/workflow-baselines.ts failure-triage \
  benchmarks/workflows/failure-triage.screening.json
```

Use development examples to change a profile. Keep screening examples fixed
for the first comparison, and create a new dataset if observed errors guide
later changes. The report alone cannot establish that a model saves agent work.

- Failure triage suggests a next investigation. It does not run repairs or
  authorize a retry; count investigations of the wrong cause.
- Relevance prioritizes reading. Keep all candidates until you measure whether
  the workflow finds every source needed for the task.
- Claim support concerns only the supplied excerpt. Count unsupported claims
  incorrectly accepted, and check source quality separately.

See [decision profiles and tuning](kev.md#improve-prompts-before-training) for
dataset partitions, profile revisions, and checkpoint identity.
