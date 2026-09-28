# Checkpoints in three complete repositories

On September 27, 2026, the source CLI reviewed selected committed changes in
complete, clean, detached checkouts of Sys1, Ghostget, and design-kit. All three
checkpoints completed. Repeating each unchanged checkpoint made no model calls.

This verifies the checkpoint workflow for these selected changes. It does not
establish everyday adoption, useful defect discovery, or saved review effort.
No findings appeared, so there were no findings to investigate, label, or
recheck. The changes were intended ordinary-change examples; they were not
independently certified defect-free.

## Scope and results

| Repository | Complete checkout files | Selected files | Evaluated units / planned | Requests | Questions | Findings | Repeat requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sys1 | 261 | 16 | 21 / 21 | 21 | 27 | 0 | 0 |
| Ghostget | 1,241 | 4 | 10 / 10 | 10 | 13 | 0 | 0 |
| design-kit | 533 | 2 | 2 / 2 | 2 | 3 | 0 | 0 |

Every selected unit completed, with no skips. All six checkpoint commands
exited 0; the three repeats reported `unchanged`. The checkouts stayed clean at
their pinned heads. The pilot installed no project skills or hooks.

| Repository | Base | HEAD | Selected paths | Request cap |
| --- | --- | --- | --- | ---: |
| Sys1 | `3d2faecdfcce3057c93720a5f5b7bac52341a5ad` | `6759898c0dae3a032015a87f1786e8ff0a232af8` | `src`, `test` | 24 |
| Ghostget | `79b08398d94ccfa9d50ac122e38b2916c1f21b0d` | `fccd37840420c9ff75ce39eab4efef8f0e9442c7` | `src/browser.ts`, `src/browser.test.ts`, `src/web-session-cleanup-admission.ts`, `src/web-session-cleanup-admission.test.ts` | 12 |
| design-kit | `fd47d9229e590dc956a08ccc4df00625846991ee` | `077fd940ccd9fd8324c32e8a688ca44693212a56` | `src/status-page.ts`, `src/status-page.test.ts` | 4 |

Both rules were explicitly selected in every command:
`--rule core-new-empty-catch --rule core-removed-test-assertions`. The exact
route was `typesafe/jev-1.13.0`, and each batch had a 60-second deadline. The
rules kept their existing wording and thresholds.

Whole-repository previews exposed useful scope choices: Sys1 and Ghostget
exceeded the default 20-request cap, while design-kit's assets consumed the
100-file limit before the relevant status-page files. Selecting the task paths
above produced complete planned coverage. Path selection made these batches
fit their limits. The rule selector explicitly fixed which checks each trial
ran; it preserves rule file filters and reports uncovered evidence.

## Calls, latency, and local state

The three batches ran in parallel through one temporary loopback gateway. The
gateway allowed only the frozen request hashes and exact public payloads,
refused duplicate hosted dispatches, and enforced a shared cap of 40. It made
33 hosted requests and no retries. Repeats added no hosted requests.

| Repository | First CLI, ms | Model-evaluation phase, ms | Repeat CLI, ms | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sys1 | 6,481 | 4,690 | 1,779 | 52,196 | 636 |
| Ghostget | 3,074 | 2,202 | 821 | 15,819 | 306 |
| design-kit | 1,314 | 724 | 574 | 4,306 | 70 |

Parallel wall time for the three first runs, repeats, and issue-list reads was
8,427 ms. These are single observations on the local host, not latency
benchmarks. Usage totaled 72,321 input and 1,012 output tokens; all 33 requests
had known usage. The pilot did not measure a billed monetary cost.

Each isolated state directory contained only `config.json` and one
`state.sqlite`, both with mode `0600`. The issue lists were empty. No user
worktree was edited for a trial. Separate metadata directories avoided changing
existing review state.

## Public provenance and offline checks

Before inference, anonymous GitHub requests matched 32 exact public source
blobs at the pinned commits and confirmed 12 expected absent-before paths.
The bundled core pack also matched its pinned public bytes. No repository rule
overrides were present. The gateway accepted only the 33 frozen requests and
their corresponding transport bodies, with the hosted model name substituted.

The published records contain numeric results, command arguments,
repository-relative paths, hashes, and dated public-source receipts. Local
checkout and metadata directory names are removed. No upstream source code,
model request bodies, raw answers, or credentials are redistributed here.
The separate Hugging Face export allowlist is unchanged.

Run the offline consistency check from the repository root:

```sh
python3 benchmarks/reviewer-next/adoption/verify.py
```

It checks published file hashes and bounds; public-source receipt identities;
the 33 unique dispatches against the frozen allowlist; coverage, usage, and
empty finding counts; and the three unchanged repeats. It makes no network
requests and does not rerun inference or independently re-fetch GitHub source.

Exact CLI arguments are in [results.json](results.json), selected sources and
request digests in [freeze.json](freeze.json), source receipts in
[public-sources.json](public-sources.json), and dispatch metadata in
[dispatches.json](dispatches.json). [manifest.json](manifest.json) hashes the
published records. `source_freeze_sha256` identifies the original local freeze;
the exported freeze omits local directory fields.
