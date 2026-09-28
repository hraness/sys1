---
language:
- en
license: mit
tags:
- evaluation
- synthetic
- decision-making
pretty_name: Sys1 decision benchmarks
---

# Sys1 decision benchmarks

Public synthetic decision cases and recorded adapter studies from
[Sys1](https://sys1.io). Use them to inspect how a particular model and adapter
answered yes/no, choice, and score questions. The
[evaluation guide](https://sys1.io/docs/evaluations) explains the studies and
links their original reports.

## Files and use

`data/benchmarks/` contains the original JSON fixtures and expected answers:

| Fixture | Scope |
| --- | --- |
| `forms-v1.json` | Historical 20-case form-action study |
| `decisions-v2.json` | 72 synthetic decisions in nine workflow families |
| `decisions-v3.json` | 72 decisions in nine new families, authored after v2 failures were known |

`data/site/data/` contains six complete historical reports: the local and Jev
form studies, Qwen3 0.6B and 1.7B on v2, and Qwen3.5 4B and direct Laya MLX on
v3. The files preserve their original schemas, model responses, failure counts,
timing observations, and source identities. They are JSON documents with nested
records, rather than a shared table. Load each document with a JSON parser.

The v2 and v3 fixture versions contain different tasks. Their scores do not
measure a controlled improvement. The v3 cases were frozen before Qwen3.5 4B
execution. Historical results describe the named adapter and runtime at the
recorded date. Direct Laya is a research adapter outside the shipped backends.

## Method and limits

The [reproduction guide](https://github.com/hraness/sys1/tree/main/benchmarks)
defines grading, call limits, model pins, and hashes. For v2 and v3, correctness
uses the first measured pass. Repeated timing passes and option permutations
are observations on the same cases, not additional independent examples.
Incorrect answers and failed calls remain in the reports.

Qwen timing includes local worker communication; Jev timing includes HTTP and
network time; direct Laya timing excludes both IPC and HTTP. The shared host
was not isolated, and repeated requests may benefit from caching. These timing
boundaries prevent a direct inference-speed ranking. Token counts also use
different tokenizers. Read the report's environment and source fields before
comparing observations.

These small, project-authored synthetic studies measure adapter behavior.
They do not establish calibration, production safety, or general model quality.
The separate external JevBench leaderboard is not included in this dataset.
The historical code-review studies in `benchmarks/reviewer/`,
`benchmarks/reviewer-next/`, and `benchmarks/reviewer-contract/` remain in the
source repository and are outside this synthetic dataset's explicit export list.
The source repository also contains
[workflow screening experiments](https://github.com/hraness/sys1/tree/main/benchmarks/workflows)
outside this dataset's export list.

## Provenance and updates

The [source repository](https://github.com/hraness/sys1) is licensed under MIT.
Its original [license](https://github.com/hraness/sys1/blob/main/LICENSE) applies
to these project-authored fixtures and reports. Model weights are not included.
`export-manifest.json` records the source commit and each file's SHA-256.
Future studies add dated files and preserve earlier observations and fixture
versions. Cite the dataset revision, fixture version, and report filename when
using a result.
