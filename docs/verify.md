# Verify an agent's claims

`sys1 verify` checks the claims in a coding agent's final message against
reachable evidence: the Git worktree, linked pull requests, check-command
results from the local Devin transcript, and fetched live pages. The command is
experimental and advisory. A confirmation means the evidence agrees; it does
not prove the claim. A contradiction means the evidence disagrees — inspect
before trusting the message.

Run it inside the repository the agent worked in, after the agent reports
completion:

```sh
sys1 verify --model typesafe/jev-1.13.0
```

With no `--message`, the newest Devin session whose working directory contains
the current directory supplies the final assistant message and the last turn's
check-command results. Other agents pipe the text:

```sh
sys1 verify --message ./final-message.txt
sys1 verify --message - <<< "$FINAL_MESSAGE"
sys1 verify --model typesafe/jev-1.13.0 --url https://example.com
```

## What it checks

One request scores a bounded list of claim types against the message tail:

- `deployed_or_live` — the message says a site, page, or change is live or
  publicly visible now
- `merged_or_pushed` — the message says code was pushed, merged, or landed in
  a pull request
- `committed` — the message says the work was committed
- `checks_passed` — the message says tests, checks, builds, or CI passed
- `complete` — the message says the requested work is finished

Only claims the model scores at or above probability 0.5 are checked.

| Claim | Evidence | Contradicted when |
| --- | --- | --- |
| `merged_or_pushed` | `git rev-list @{upstream}..HEAD`, linked pull requests | commits remain unpushed, or a linked PR is not merged |
| `committed`, `complete` | `git status --porcelain` | the worktree still holds uncommitted files |
| `checks_passed` | the turn's check-like commands and their tool results (Devin sessions only) | a check command failed, or none ran (unverifiable) |
| `deployed_or_live` | each `--url` and every public https URL in the message, fetched and judged against the claim on the selected route | the fetched page does not reflect the claimed change |

The fetch is bounded: HTTPS only, at most four pages, three redirects, ten
seconds, and 24 KiB of stripped text. Unreachable pages, missing upstreams, and
absent transcripts report `unverifiable`, never `contradicted`.

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

`--dry-run` plans the claims and evidence with local Git state only: no model
calls and no fetches. `--json` prints the machine-readable report.

## Privacy and limits

- Message and page text are read into memory and sent only to the selected
  backend. Verify writes nothing to disk.
- Transcript reading is local, read-only, and limited to the session's last
  turn; the report lists command lines and verdicts, not outputs or message
  text.
- A passing page check means the fetched excerpt supports the claim at a
  threshold, not that the deployment is correct or safe.
- Verify does not read Claude Code or Codex transcripts yet; pass the message
  with `--message` for those agents.
