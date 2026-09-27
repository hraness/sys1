# Historical review examples

These are **discovery examples, not a held-out accuracy benchmark**. Fifteen
units come from public Sys1, Ghostget, and design-kit history. Rule wording was
written after inspecting the repairs. Four candidate checks remain opt-in; they
are not installed with the default audit pack and are not qualified for blocking
changes.

`manifest.json` records public commit and parent IDs, source paths and line
windows, complete source blob hashes, excerpt hashes, label evidence, and the
representation of each example. `fixtures.jsonl` contains the exact model input.
The independent [label review](label-review.md) finished before live predictions.
It excluded the Sys1 inference pair: the earlier adapter explicitly exposed zero
confidence and coverage, making its false-success label ambiguous under the rule.
All 15 units remain as historical evidence; 13 are eligible for evaluation.

Most examples are exact historical source windows represented as additions from
an empty file. This asks whether introducing that code would break the rule. It
is **not** the original bug-introducing commit or a reversal of the repair. The
before example contains no later repair text, tests, or diagnosis. Three controls
are actual unrelated public diffs. Two additional controls test legitimate
fallback and missing-context behavior. Clean labels are specific to a rule and
the visible evidence, not a claim that a repository or file has no defects.

The source/label families are:

| Family | Public repair | Evidence |
| --- | --- | --- |
| Login persistence | Ghostget `42fbc4d` | Device login returned success before token storage; added tests cover delayed and failed writes. |
| Empty inference | Sys1 `3fa98af` | Empty label mass changed from a fabricated answer to `inference_unreadable`; zero-confidence disclosure makes the old label debatable. |
| Model filename | Sys1 `67197a9` | A manifest path such as `../../escape.gguf` passed the schema and was joined into the model directory; the repair adds component validation and a regression case. |
| Forced appearance | design-kit `f335cf8` | Portal appearance chose the resolved preference ahead of a forced mode; the helper and tests now give forced mode precedence. |
| Label activation | design-kit `850a0d3` | A focusable ancestor could receive focus during native label activation and dismiss the menu; mouse/touch browser cases and a pointer guard were added. |

The bundled reproduction verifier accepts explicit public checkout paths and
compares every byte with the manifest. It does not fetch anything. Repositories
are only needed to regenerate evidence, never for the package build or ordinary
tests. Public visibility was checked with `gh repo view --json visibility,url`
on September 27, 2026.

The deterministic baseline needs precision. Sys1 and Ghostget's package scripts
have no general ESLint step. design-kit uses ESLint recommended plus
`typescript-eslint` strict (not type-checked rules), consistent type imports, and
no non-null assertions. Those rules do not model native event ordering or override
precedence. `no-floating-promises` can overlap login persistence but commonly
allows explicit `void`; path-injection security analysis can overlap manifest
validation. We do not claim a model uniquely catches either class. Reproduction
and lint measurements are recorded separately from these capability observations.

All before/after units in a family are related; they are not independent samples.
Small support, cherry-picking from fix history, differing excerpt lengths, repair
comments, and repaired controls make precision/recall optimistic for everyday
changes. The narrow native-activation rule currently has one positive family.
No automatic hooks or rule promotion follow from these results. Further evaluation
must freeze whole unseen families before viewing their fixes or tuning wording.

## Reproduce and run

```sh
bun test test/reviewer-corpus.test.ts
bun benchmarks/reviewer/verify-sources.ts /path/to/sys1 /path/to/ghostget /path/to/design-kit
bun benchmarks/reviewer/reproduce.ts
bun benchmarks/reviewer/run.ts --validate typesafe/jev-1.13.0 http://127.0.0.1:13900 20
# Only after explicitly activating an isolated gateway with an authorized provider:
bun benchmarks/reviewer/run.ts --live typesafe/jev-1.13.0 http://127.0.0.1:13900 20
```

The runner bounds requests, requires an explicit route and loopback gateway, and
refuses live work before independent review. It never reads credentials or
activates a gateway. Reports contain tiers, counts, request hashes, usage and
latency without raw source or answers. Related rejected or unresolved families
are excluded together. The numeric budget is capped at 100 requests per run.

The behavioral reproduction runs original source excerpts for one supported
pair per repository. It proves path traversal passes the old schema and fails
the repair, login succeeds before pending/rejected storage in the old handler
but waits/reports error after repair, and the old portal value chooses resolved
light over forced dark while the repair chooses dark. These use mocked storage,
the installed Zod version, and a directly executed theme computation; they do
not substitute for full historical application or browser test suites.

## Measured deterministic baseline

[baseline.json](baseline.json) records executed checks with exact commit/source
hashes. All eight complete historical source files (before/after for the four
supported positive families) passed the pinned ESLint comparison with zero
diagnostics. The config is design-kit's original config from `f335cf8`, using
ESLint 9.39.5, typescript-eslint 8.67.0, and TypeScript 6.0.3 in an isolated
installation with scripts disabled. For Sys1 and Ghostget this is an explicitly
added comparison, not a claim about their configured repository gate. This does
not measure type-aware promise lint, security analysis, or every possible linter.

To repeat the lint comparison, install those pinned packages plus
`@eslint/js@9.39.5` in a disposable directory with `bun install --ignore-scripts`,
copy design-kit's `f335cf8:eslint.config.mjs` there, and pipe each recorded source
blob to `node_modules/.bin/eslint --stdin --stdin-filename PATH --format json`.
The evidence records each original PATH and SHA; no partial excerpts were linted.
The top-level versions match the historical lock; the isolated transitive lock
is hashed separately and is not claimed identical to the complete repository
lock. Original added regression suites were inspected but not executed; the
three source-excerpt behavioral reproductions above are the executed evidence.
