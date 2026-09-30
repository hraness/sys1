# Roadmap to proven skills, September 2026

Status: Step 2's completion-claim baseline is complete, with results recorded
2026-09-30. It did not meet the intervention threshold, so it does not trigger
Steps 3–4. The remaining steps and Step 2 candidates below are plans. The
original roadmap was written 2026-09-29 after three whole-task and recall
measurements.

## Where the evidence stands

| Skill | What we measured | Result |
| --- | --- | --- |
| `system-one-verify` (compact noisy output) | 26 whole-task pairs, Claude Code, Sonnet 5.5 | Never called. Sonnet already writes output to a file and greps it. No token or time change. |
| `sys1 review checkpoint`, adopted | 32 whole-task pairs | Never called. No change. |
| `sys1 review checkpoint`, directed | 32 whole-task pairs | 84% more tokens, 145% more time, 22/32 correct vs 29/32. |
| Core rules, recall | Same 32 diffs, no agent | 3/16 planted problems caught, even given only the planted file and rule. 0 false alarms. |
| Core rules, authored fixtures (Sep 27) | 20+20 per rule | Empty catch 2/10. Removed assertion 10/10, which fell to 3/8 on real diffs. |
| Completion-claim baseline for `sys1 verify` | 30 tasks per model, Sonnet 5.5 and Haiku 4.5, without Sys1 | Original scorer: 0/30 Sonnet and 1/30 Haiku flags. Review confirmed no false extracted primary claims. Below the 10% threshold; no intervention tested. [Data and report](https://github.com/hraness/system-one-skills/blob/main/docs/COMPLETION-BASELINE-RESULTS-2026-09.md). |

Three separate failures explain the nulls:

1. **The agent must choose to call the skill.** A capable agent handles small
   checks cheaply itself, so it rarely calls an optional skill, and when it is
   told to, the skill adds steps.
2. **The checks are not accurate enough to trust.** An agent that trusts a
   silent check answers worse than one that reads the diff.
3. **We measured jobs the agent already does well.** Noisy typecheck output and
   staged-diff review are easy for Sonnet. No baseline failure means nothing to
   save.

A skill proves useful only if all three hold: the agent (or harness) actually
invokes it, it is accurate on real inputs, and it targets a job where agents
measurably fail or overspend without it. The steps below address them in that
order of cost, cheapest first.

## Step 1. Accuracy on real inputs (Jev only, no Claude usage)

Goal: every shipped rule meets a published bar on realistic diffs before any
whole-task test.

- Build a realistic corpus per rule: planted violations on real commits (the
  existing 32-task generator), plus natural violations mined from history
  (commits that a later commit fixed). Split into calibration and held-out
  before any model run. Target 40+ violations and 80+ clean per rule.
- Iterate rule wording, examples and cutoffs on calibration only. Condition C
  of the recall run (planted file and matching rule, 37 requests) is the inner
  loop.
- **Bar to ship a rule by default:** held-out recall ≥ 80% with the lower 95%
  bound ≥ 65%, false-alarm rate ≤ 5% on natural clean diffs, and reviews that
  finish (`complete`) on ≥ 90% of real commits.
- Anything a parser can decide exactly goes to a deterministic check, not Jev.
  Empty catch is the first case: Sys1's own Sep 27 evaluation already
  recommended a linter. Keep Jev for judgments a parser cannot make.
- Fix `incomplete` on ordinary commits (oversized hunks, generated files) so
  "no findings" means "checked and clean".

Exit: at least two rules clear the bar, or we learn that Jev 1.13 cannot reach
it on this kind of rule, which is itself worth knowing before more marketing.

## Step 2. Find jobs where agents actually fail (small Claude budget)

Goal: pick targets by measured baseline failure, not by intuition.

Run the agent alone, with no Sys1, on realistic tasks and record where it goes
wrong or overspends. Candidates, most promising first:

- **False completion claims.** "Pushed", "tests pass" or "deployed" when they
  are not. This is `sys1 verify`'s job, is checkable against git, CI and live
  pages, and is a failure users complain about.
- **Long sessions near the context limit**, where noisy output does cost
  context. Test at hour-long tasks, not single commands.
- **Cheaper main agents** (Haiku 4.5), which may not filter output as Sonnet
  does.
- **Rules learned from the repo's own past mistakes**, where the agent has no
  way to know the rule without Sys1.

Keep a target only if its baseline failure rate is ≥ 10% on ≥ 30 tasks.

The [completion-claim baseline](https://github.com/hraness/system-one-skills/blob/main/docs/COMPLETION-BASELINE-RESULTS-2026-09.md)
finished with 30 included tasks per model. The original scorer flagged no
Sonnet runs and one Haiku run (3.3%). That flag compared a passing test subset
with a failing repository suite; review of the quoted assertions confirmed
no false commit, push, or passing-check claim. Both calculations remain
published. The second grading pass met the registered audit limit with two
disagreements across 80 labels.

Neither model meets the point-estimate cutoff. This study supplies no target
for a Step 3 hook or Step 4 paired trial, and neither was started. The 95%
intervals still extend above 10%; the finding applies to this small-task
sample and does not establish a low population failure rate. Long sessions
and rules learned from past mistakes remain unmeasured.

## Step 3. Deliver without asking the agent to choose

Goal: remove failure 1.

Ship each qualified check as an automatic hook (Claude Code `Stop` and
`PostToolUse`, Codex and Devin equivalents, or git pre-commit) that stays silent
on clean results. A silent check costs the agent no tokens; a finding is
injected only when there is something to fix. Optional skills stay for manual
use.

## Step 4. Whole-task proof

Goal: the claim that goes on the site.

Pre-registered paired trials, as before, on a Step 2 target with a Step 1
qualified check delivered by a Step 3 hook:

- Primary outcome: task success, or escaped errors (false "done" claims,
  shipped violations). Tokens and time are secondary: a check that prevents a
  bad push is worth a few extra tokens.
- ≥ 30 pairs per model, two main-agent models (Sonnet 5.5 and Haiku 4.5),
  blind grading, the same stopping rules and exclusions as the September runs.
- Claim only what clears the pre-registered cutoff, with the number, the
  model and the link to the data.

## Step 5. The learning loop (ALGAL)

Once Steps 1–4 hold for built-in checks, measure the "improves over time"
claim directly: turn each observed agent mistake into a rule, then test whether
that rule catches the same class of mistake on later, unseen tasks. This is the
unique claim, and it needs its own evidence.

## What the site can say meanwhile

Per-decision speed and cost of a Jev call, the measured recall and false-alarm
numbers, and the completed whole-task and baseline findings above. Nothing about whole-task
token or time savings until Step 4 produces one.

## Recorded and prospective cost

| Step | Claude usage | Jev |
| --- | --- | --- |
| 1 | none | a few dollars |
| 2, completion-claim baseline | $34.27 main runs; $39.13 including recorded pilots and grading | none |
| 3 | engineering only | none |
| 4 | ~$20–40 | ~$1 |
| 5 | ~$20 | ~$1 |
