# Skill pack benchmark plan

Status: planned, not run. Written 2026-09-28. No results exist yet, and the
site says so.

## Question

Does installing a skill pack make a coding agent finish real tasks more often,
with fewer tokens, in less time, and with fewer false "done" claims? We want to
answer that for System One Skills and for the packs people compare it with,
using the same tasks, agent, and model for every arm.

## Arms

Each arm pins an exact commit or release. Record the SHA in the run manifest.

| Arm | Source | Pin at plan time |
|---|---|---|
| No pack (baseline) | agent defaults only | n/a |
| System One Skills | `hraness/system-one-skills` | v0.4.1 release tarball |
| Sys1 skills | `sys1-review`, `sys1-verify` from `hraness/sys1` | v0.17.0, local Qwen3 1.7B and hosted Jev as separate arms |
| gstack | `garrytan/gstack` | `65bfb0ce49da807698359ca033a05709e342c684` |
| pstack | `backnotprop/pstack` | `157aae39a733135e93d8b5b19ff62c6a84b0ad56` |
| Superpowers | `obra/superpowers` | `8ca22dba9a94f28898bbce59f2537ff4d87c747d` |
| Anthropic skills | `anthropics/skills` | `8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4` |

Install each pack the way its README says for the chosen agent. If a pack
needs a setup step we cannot automate, record it and run the arm anyway or
drop it with the reason. Do not modify another pack's skills.

## Agents and models

- Primary: Claude Code and Codex, each with one pinned model per run.
- Same model, temperature, context limit, and tool permissions for every arm.
- Fresh container per task run, no network except package registries and the
  hosted Jev endpoint for that arm.

## Task set

40 tasks, frozen before the first scored run, in four groups of 10:

1. **Noisy checks.** Fix a failing test in a repository whose test or build
   output is over 2,000 lines. Measures context spent on logs.
2. **Completion honesty.** Tasks where one step cannot succeed (a push to a
   read-only remote, a missing credential, a flaky external check). Measures
   whether the agent claims success it does not have.
3. **Review.** Diffs seeded with known defects (swallowed errors, deleted
   assertions, broken invariants) plus clean diffs. Measures true and false
   findings.
4. **Ordinary features.** Small feature requests with hidden acceptance tests.
   Measures whether a pack helps or hurts general work.

Tasks come from public repositories with permissive licenses, pinned by SHA.
Keep 10 tasks held out: tune nothing on them and report them separately.

## Metrics

Per run:

- Task success from hidden acceptance tests (pass or fail).
- Total input and output tokens, from the agent's own usage log.
- Wall-clock time to the agent's final message.
- False completion claims: the final message states something the repository,
  remote, or check output contradicts. Scored with `sys1 verify` evidence and
  confirmed by a human reviewer who does not know the arm.
- Review precision and recall for group 3.
- Log characters that entered context, for group 1.

## Protocol

- 3 runs per task per arm, randomized order. Report every run.
- Report medians with bootstrap 95% intervals and the per-task table.
- A pack "wins" a metric only when its interval excludes the baseline.
- Publish the task set, manifests, raw agent logs with secrets removed, and the
  scoring scripts under `benchmarks/skill-packs/`, and mirror them to the
  public benchmark dataset.
- Publish results where another pack beats System One Skills or Sys1 with the
  same prominence as results where it loses.

## Budget and limits

- About 40 tasks x 7 to 8 arms x 3 runs x 2 agents, roughly 1,900 runs. Run a
  10-task pilot first to measure cost and fix harness bugs, and discard the
  pilot from reported results.
- The packs aim at different jobs. A pack that does poorly on noisy checks may
  do well on planning, which this task set does not measure. Say so next to
  the results.

## Site copy until results exist

The homepage states that the comparison is planned and shows no
head-to-head numbers. Only the existing System One Skills study (563 replayed
validation outputs, 35% less text) and Sys1's own evaluations appear as
measured results.
