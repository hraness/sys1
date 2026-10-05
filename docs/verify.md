# Check an agent's completion message

`sys1 verify` checks the claims in a coding agent's proposed final message against
reachable evidence: the Git worktree, linked pull requests, check-command
results from the local Devin transcript, and fetched live pages. The command is
experimental and advisory. A confirmation means the evidence agrees; it does
not prove the claim. A contradiction means the evidence disagrees; inspect
before trusting the message.

## Install the project skill

With [Sys1 installed](../README.md#install), run these commands inside the
repository to add standalone verification instructions for your coding agent:

```sh
sys1 verify setup codex --dry-run --json
sys1 verify setup codex --json
```

Use `setup claude-code` or `setup devin` for those agents. The skill is written
to `.agents/skills/sys1-verify/SKILL.md`,
`.claude/skills/sys1-verify/SKILL.md`, or
`.devin/skills/sys1-verify/SKILL.md`, respectively. Setup needs no model route
and makes no model calls. It preserves an identical existing file and refuses
to overwrite different instructions; review existing files manually when
updating. Commit the skill if the repository should share it.

The skill works independently of `sys1 review`. Setup adds no automatic hooks
and does not enable a backend. Other coding agents can follow the commands
below directly.

## Use with any coding agent

Run verify inside the Git worktree the agent changed. Choose an enabled
backend/model route. For hosted Jev, provide `TYPESAFE_API_KEY` in your
environment and run `sys1 jev enable`; the selected backend receives the
message excerpt and, for a live-page claim, the fetched page excerpt. The part
of a route before the slash may use only lowercase letters, digits, and
hyphens, so verify rejects the bundled local Qwen routes such as
`local-qwen3-1.7b/qwen3-1.7b`. A route to a server registered with
`sys1 backend add` is accepted with or without `--gateway`.

Save the proposed final message to a text file outside the Git worktree,
then preview the check. These examples use `/tmp/final-message.txt`; choose
an equivalent local path on Windows. A draft inside the worktree can itself
create an uncommitted-file contradiction.

```sh
sys1 verify --message /tmp/final-message.txt --model typesafe/jev-1.13.0 --dry-run --json
```

Repeat without `--dry-run` to evaluate it:

```sh
sys1 verify --message /tmp/final-message.txt --model typesafe/jev-1.13.0 --json
```

Codex, Claude Code, Devin, and other agents can also pipe text:

```sh
cat /tmp/final-message.txt | sys1 verify --message - --model typesafe/jev-1.13.0 --json
```

Add `--url https://example.com` for a page the message does not link. Message
files and stdin are limited to 64 KiB; claim extraction uses the trailing
8,192 characters. `--timeout-ms` sets the model-call timeout, from 1 to
120,000 ms, with a default of 30,000 ms. Use an explicit route even for a
preview.

## Read a local Devin session

With no `--message`, verify finds the newest local Devin session whose working
directory is the current directory or an ancestor. It reads the last assistant
message and the check-command results from that turn:

```sh
sys1 verify --model typesafe/jev-1.13.0
sys1 verify --model typesafe/jev-1.13.0 --url https://example.com
```

It does not select a session by its title. Use `--message` when several
sessions share a directory or when you need to check a specific draft. File
and stdin input contain no transcript evidence, so `checks_passed` claims are
unverifiable through those input modes.

## What it checks

One request scores a bounded list of claim types against the message tail:

- `deployed_or_live`: the message says a site, page, or change is live or
  publicly visible now
- `merged_or_pushed`: the message says code was pushed, merged, or landed in
  a pull request
- `committed`: the message says the work was committed
- `checks_passed`: the message says tests, checks, builds, or CI passed
- `complete`: the message says the requested work is finished

Claims the model scores at or above probability 0.5 are checked. A separate
question in that request distinguishes a completed merge from opening a pull
request, pushing commits, or waiting for a merge. Linked GitHub pull requests
are checked for merge state only when the model identifies a completed-merge
claim.

| Claim | Evidence | Contradicted when |
| --- | --- | --- |
| `merged_or_pushed` | `git rev-list @{upstream}..HEAD`, linked pull requests | commits remain unpushed, or a linked PR is not merged despite a completed-merge claim |
| `committed`, `complete` | `git status --porcelain` | the worktree still holds uncommitted files |
| `checks_passed` | the turn's check-like commands and their tool results (Devin sessions only) | a check-command result contains a failure marker |
| `deployed_or_live` | each `--url` and every public https URL in the message, fetched and judged against the claim on the selected route | the fetched page does not reflect the claimed change |

Verify reads at most four live pages and follows at most three redirects per
page. It keeps the first 24 KiB of each response and strips scripts, styles,
and markup; it does not render a browser or execute JavaScript. Fetches have
a ten-second timeout. Content beyond that excerpt or rendered only by
JavaScript may be unavailable to the check. Unreachable pages, missing
upstreams, and absent check-command results report `unverifiable`, never
`contradicted`. Pull-request checks use the installed GitHub CLI's access.

## Reading the result

```
Verify complete: 1 contradiction, 2 requests.
[contradicted] merged_or_pushed p=0.97
    2 commits are ahead of origin/main
[confirmed] deployed_or_live p=0.93
    https://example.com: page reflects the claim (p=0.81)
[unverifiable] checks_passed p=0.88
    no check-like command ran in the final turn
[not_claimed] committed p=0.04
[not_claimed] complete p=0.02
```

Exit 0 means nothing contradicted the reachable evidence. Exit 7 means at least
one claim was contradicted; fix the work or the message and rerun. Exit 8 means
the run was incomplete, for example after a backend failure.

`--dry-run` reports the input type, selected model route, and claim categories
without model calls or fetches. It does not display the message or gathered
evidence. Read the message file and inspect its links before evaluating it.
`--json` prints the machine-readable report.

The displayed claim probability measures whether the model thinks the message
makes that claim. A page-match probability is a separate judgment about the
fetched excerpt. Neither is a measured reliability score for the completed work.

## Privacy and limits

- Message and page text are read into memory and sent only to the selected
  backend. Evaluating a message writes nothing to disk.
- Transcript reading is local, read-only, and limited to the session's last
  turn; the report lists command lines and verdicts, not outputs or message
  text.
- A passing page check means the fetched excerpt supports the claim at a
  threshold, not that the deployment is correct or safe.
- Git checks inspect the current worktree and locally known upstream state.
  Unrelated local edits can contradict a completion claim, and a clean tree
  does not establish that the user's requested behavior works.
- Verify does not read Claude Code or Codex transcripts yet; pass the message
  with `--message` for those agents.
