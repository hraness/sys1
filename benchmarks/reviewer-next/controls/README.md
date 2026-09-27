# Fresh clean controls, original broad questions

Ten public historical controls across five repositories were frozen and
[independently labeled](label-review.md) before predictions. They exercise the
**unchanged four broad questions** from the original
[discovery pack](../../reviewer/reviewer-candidates/pack.yaml). This is a small
false-alarm baseline. It does not qualify the separate, narrower claim-checking
strategy, estimate recall, or demonstrate useful autonomous defect discovery.

## Result, 2026-09-27

Exactly **12 hosted requests** completed through Sys1's gateway router using
`typesafe/jev-1.13.0`: ten primary controls and two separate diagnostic states.
No retries occurred. Thresholds were frozen at 0.8 / 0.9 before inference.
All 48 numeric rule scores and tiers are retained in [results.json](results.json).

| Target rule | Reviewed clean controls | Flags at ≥0.8 | Flags at ≥0.9 |
| --- | ---: | ---: | ---: |
| Required work before success | 2 | 0 | 0 |
| Validate path components | 3 | 0 | 0 |
| Explicit override precedence | 3 | 0 | 0 |
| Preserve native activation | 2 | 0 | 0 |
| Total | 10 | 0 | 0 |

Target scores ranged from 0.06 to 0.37. The descriptive Wilson 95% interval for
0/10 false alarms is **0%–27.8%**. Per-rule support is only two or three examples.
This purposive sample is not random production traffic. There are no admitted
positive examples, so precision and recall remain unknown.

The run used 39,313 input and 1,008 output tokens in 2,778 ms. Median request
latency was 213.5 ms; nearest-rank p95 was 354 ms. These are observed request
latencies and provider-reported token usage, not an invoice or a user-effort
measurement. Other rules' answers are retained without assigning new labels.

The Wordcell concurrent-release pair is **diagnostic only**. The historical
repair makes a second `release()` promise wait for the first operation. The
original broad success rule scored the earlier/later states 0.15/0.17. Both are
excluded from all primary metrics because the rule's misleading-success
condition is not established; see [the adjudication](label-review.md).

## What is frozen

- [fixtures.jsonl](fixtures.jsonl): ten controls, target-rule clean labels only.
- [diagnostics.jsonl](diagnostics.jsonl): two excluded Wordcell release states.
- [manifest.json](manifest.json): exact public revisions, representations,
  source windows, whole-source and payload hashes, overlap notes, label basis,
  original test references, and seventeen license-revision checks.
- [freeze.json](freeze.json): runner, request, state, question and rule hashes;
  model, request cap, thresholds, deadlines and zero-retry policy.
- [public-provenance.json](public-provenance.json): GitHub returned all nine
  exact source commits and confirmed all five repositories are public.
- [public-payload.json](public-payload.json): fourteen anonymous public blob
  downloads reconstructed every sent payload byte-for-byte, including all
  three actual diffs from their before/after public files.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): original MIT notices.

Seven primary controls replay source snapshots as additions; three are actual
historical diffs. They cover five repositories: Sys1, Ghostget, design-kit,
Wordcell, and Slopcamera. Two design-kit controls use separate helpers from the
same source file/revision, disclosed in the manifest. Discovery commits are
excluded, but some projects and broad rule families are shared with discovery.
Bounded history research did not establish a new positive family for these
exact predicates; the diagnostic pair was not promoted to fill that gap.

## Reproduce without network or sibling repositories

From the Sys1 checkout with its normal development dependencies installed:

```sh
bun benchmarks/reviewer-next/controls/corpus.ts
bun benchmarks/reviewer-next/controls/run.ts --validate
bun benchmarks/reviewer-next/controls/verify-results.ts
bun benchmarks/reviewer-next/controls/reproduce.ts
```

The first three commands check fixture/schema/label hashes, reconstruct the
frozen requests without sending them, and recompute the numerical result
invariants. They are portable, require no credentials, and perform no network
requests. The behavioral reproduction passed **64 assertions** on Bun 1.3.14,
macOS arm64; [receipt](reproduction.json). It exercises eight primary controls
and the two diagnostic states. The two ordinary presentation diffs have source
review only. No originating browser/UI suite was rerun.

Reproduction executes the fixed, reviewed source bodies with explicit browser
API fakes and temporary filesystem state. It does not open a listener. Native
modules for the HTTP and release examples are complete historical snapshots.
The escaping-symlink case needs local symlink permission. This is a bounded
behavioral proof, not an untrusted-code sandbox or a complete repository test.

Optional verification against local sibling checkouts:

```sh
bun benchmarks/reviewer-next/controls/verify-sources.ts \
  /path/to/sys1 /path/to/ghostget /path/to/design-kit \
  /path/to/wordcell /path/to/slopcamera
```

This reproduced all twelve payloads and seventeen MIT license revisions.
Git must support the global `--no-lazy-fetch` option; older versions fail
closed. Missing objects in a partial clone cause failure without network fetch.
To repeat anonymous public source verification, explicitly opt into downloads:

```sh
python3 benchmarks/reviewer-next/controls/verify-public.py --download-public
```

`run.ts --live` is a bounded hosted experiment requiring an environment
credential. It is not part of ordinary validation or CI. It refuses an existing
one-shot run marker; do not clear that marker or overwrite this experiment to
retry. A future experiment needs its own reviewed identity, budget and freeze.
Credentials are never part of the request state or saved evidence. Candidate
source bytes are public and independently verified. HF export scope is unchanged.
