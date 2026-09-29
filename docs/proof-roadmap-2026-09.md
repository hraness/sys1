# Roadmap to proven skills, September 2026

Status: plan. Written 2026-09-29 after three whole-task and recall
measurements. Nothing here is a result.

## Where the evidence stands

| Skill | What we measured | Result |
| --- | --- | --- |
| `system-one-verify` (compact noisy output) | 26 whole-task pairs, Claude Code, Sonnet 5.5 | Never called. Sonnet already writes output to a file and greps it. No token or time change. |
| `sys1 review checkpoint`, adopted | 32 whole-task pairs | Never called. No change. |
| `sys1 review checkpoint`, directed | 32 whole-task pairs | 84% more tokens, 145% more time, 22/32 correct vs 29/32. |
| Core rules, recall | Same 32 diffs, no agent | 3/16 planted problems caught, even given only the planted file and rule. 0 false alarms. |
| Core rules, authored fixtures (Sep 27) | 20+20 per rule | Empty catch 2/10. Removed assertion 10/10, which fell to 3/8 on real diffs. |
| `sys1 verify` (completion claims) | Not measured on whole tasks | Unknown. |

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
numbers, and that whole-task results are in progress. Nothing about whole-task
token or time savings until Step 4 produces one.

## Rough cost

| Step | Claude usage | Jev |
| --- | --- | --- |
| 1 | none | a few dollars |
| 2 | ~$10–15 | none |
| 3 | engineering only | none |
| 4 | ~$20–40 | ~$1 |
| 5 | ~$20 | ~$1 |
