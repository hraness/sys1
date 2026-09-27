# Use Perch through Sys1

[Perch](https://github.com/lakeday-org/perch) can send its code-review questions
through Sys1 without a protocol adapter. It remains an optional external tool;
Sys1 does not install or bundle Perch's parser, caches, or review engine.

The September 27, 2026 compatibility experiment used Perch 0.3.5 at
[`9398517a6f6c20d7af0c3aa4f85e9b1f27739a63`](https://github.com/lakeday-org/perch/tree/9398517a6f6c20d7af0c3aa4f85e9b1f27739a63)
and Sys1 0.12.0 at
[`3d2faecdfcce3057c93720a5f5b7bac52341a5ad`](https://github.com/hraness/sys1/tree/3d2faecdfcce3057c93720a5f5b7bac52341a5ad).
The downloaded Perch source archive's SHA-256 was
`0200809e1efe493358019c273bf09fa6d5024d32b1abc66d6540a40baf96d0c9`.
Tests ran on macOS arm64 with Node 24.20.0 and Bun 1.3.14.

## What the experiment established

The actual Perch CLI and client sent 16 requests to an isolated Sys1 gateway.
Thirteen reached a deterministic fake backend; three were rejected before
dispatch. No hosted model was called, so these results establish compatibility
and context behavior, not defect-detection accuracy or model latency.

| Operation | Observed result |
| --- | --- |
| Client request with Noul, Choice, and Score questions | Validated response through the explicit `pilot/fixture-model` route |
| CLI file check | One backend request |
| CLI method scan | Six backend requests, including caller and callee context |
| Repeat the same scan | Zero backend requests; Perch reused its cache |
| Check an edited method with an edited caller | Target came from the worktree; caller came from `HEAD` |
| Backend returned HTTP 503 | Perch made four attempts; Sys1 dispatched once per incoming attempt |
| 65 questions, a 1025-byte criterion, or 11 Score levels | Each request returned HTTP 422 without backend dispatch |

## Connect an installed Sys1 gateway

Perch requires Node 22 or newer, npm, and Git. Its native tree-sitter dependency
downloads language grammars on first use. The experiment installed dependencies
with lifecycle scripts disabled, built the CLI explicitly, and used only the
TypeScript grammar.

From the repository you want to inspect, install the pinned Perch source in a
separate temporary directory:

```sh
export PERCH_SOURCE="$(mktemp -d)"
git clone --no-checkout https://github.com/lakeday-org/perch.git "$PERCH_SOURCE"
git -C "$PERCH_SOURCE" checkout --detach 9398517a6f6c20d7af0c3aa4f85e9b1f27739a63
npm --prefix "$PERCH_SOURCE" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$PERCH_SOURCE" run build
```

To use hosted Jev, make `TYPESAFE_API_KEY` available in a second terminal, with
[Sys1 installed](../README.md#install). The following commands create a separate
configuration and start its gateway on an unused loopback port, 13901 in this
example. Enabling Jev selects hosted-only routing. Subsequent reviews send the
selected source and context to that hosted model.

```sh
export SYS1_HOME="$(mktemp -d)"
sys1 jev enable
sys1 serve --port 13901
```

Back in the repository terminal, replace `src/example.ts::example` with the
file and method to inspect:

```sh
PERCH_BASE_URL=http://127.0.0.1:13901/v1/systemone \
PERCH_MODEL_ID=typesafe/jev-1.13.0 \
PERCH_API_KEY=public-loopback-dummy \
node "$PERCH_SOURCE/bin/perch.mjs" check src/example.ts::example --rules defect --json
```

`PERCH_BASE_URL` is the complete request URL, including `/v1/systemone`.
Perch requires a nonempty API key even for loopback; the dummy value satisfies
that requirement while Sys1 reads the real credential from its own environment.
For another configured backend, use its explicit `backend/model` route and a
routing policy that allows it. Stop the foreground gateway with Ctrl-C.

## Differences that affect review

- **Source versions:** Perch's method check combines the target's worktree
  contents with neighboring methods from `HEAD`. Its scans use committed trees.
  Use [Sys1 review](review.md) when you need its staged/worktree diff selection
  and removed-line evidence.
- **Retries and limits:** The pinned Perch client retries HTTP 429 and 5xx
  responses up to four attempts and has no request AbortSignal or explicit
  timeout. Its question batching uses token estimates, which do not enforce
  Sys1's question-count and byte limits. A Perch command can therefore create
  several gateway requests even though Sys1 does not retry a definitive HTTP
  response. Use a small explicit target for experiments; an automated pilot
  needs its own total-request limit and process timeout.
- **Stored data:** Perch scans retain analysis, answers, and dismissed findings
  under `.perch`. Sys1 review stores finding metadata without source or answers.
- **Scores and coverage:** Perch combines gate scores when ranking findings.
  Sys1 does not treat multiplied scores as joint probabilities. Perch reports
  incomplete scan units separately, so exit zero alone does not establish
  complete coverage.

Caller and callee context is useful to compare against the misses in the
[reviewer evaluation](reviewer-evaluation-2026-09-27.md). This experiment supports
that comparison; it does not establish that importing Perch's engine would
improve Sys1's findings.

A [later Sys1 experiment](reviewer-followup-2026-09-27.md) found that complete
target-side files did not recover the three missed defects. Specific requirements
recovered two known cases. That experiment did not test caller graphs or Perch's
analysis engine.
