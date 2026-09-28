# Workflow screening examples

These examples test small decisions an agent might make during work: where to
investigate a failed command, which excerpt to read first, and whether an
excerpt supports a claim. Each workflow has eight illustrative development
examples and eight separately authored synthetic screening examples.

The [profiles](../../examples/workflows/) preserve the exploration's original
questions and rubrics. The [manifest](manifest.json) records SHA256 hashes,
source families, and reasons for screening labels. Profiles, fixtures, and
baseline rules were frozen before any live model calls.

## Run a baseline

From a checkout with Bun 1.3.14 and dependencies installed:

```sh
bun scripts/workflow-baselines.ts failure-triage \
  benchmarks/workflows/failure-triage.screening.json
```

Replace `failure-triage` in both arguments with `evidence-relevance` or
`claim-support` to run another workflow. Use `.development.json` for the
illustrative examples. The command prints predictions and accuracy as JSON
without making model calls. Optional `split` and `family` identifiers are
accepted and preserved in the report.

The baseline library exports `baselinePrediction(workflow, state)` and
`runBaseline(workflow, cases)` from
[`scripts/workflow-baselines.ts`](../../scripts/workflow-baselines.ts).
Predictions use only the input state. Triage matches diagnostic signatures;
relevance measures token overlap; claim support checks literal matches and
simple negation. The claim comparator is weak: it misses paraphrases and can
mistake quotations for supporting evidence.

Follow [Evaluate a decision profile](../../docs/profile-evaluation.md) to
validate examples and compare model results with these fixed baselines.

## What the examples measure

Development examples were copied from the original prototypes. A separate
Codex worker authored the screening examples using different fictional source
families, including language-runtime diagnostics, visitor policies, forecasts,
product manuals, and service plans. The worker read the rubrics and development
examples but had no model outputs. Screening examples include incomplete
answers, contradictory details, mismatched scopes, and instructions embedded
in evidence.

This is a small synthetic screening set, not a population-quality benchmark.
Accuracy describes these examples only. It does not measure probability
calibration, corrections, follow-up reading, time saved, or completed-task
quality. Relevance measures coverage, so even an unverified excerpt can directly
answer the requested question.

Keep development and screening results separate. Once predictions have been
inspected, preserve the frozen files and create a new experiment for changed
profiles, labels, or baseline rules. The manifest records code-only
interoperability repairs separately from the original input freeze.
