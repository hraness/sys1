# Changelog

Each release page on GitHub copies its version's section from this file. Write
the section in the pull request that bumps the version: a one-line summary
paragraph, then one bullet per change a user or operator would notice. Keep
each paragraph and bullet on one line; release pages render line breaks.

## 0.19.1 - 2026-10-01

Page claim checks exclude script and stylesheet bodies with HTML closing-tag whitespace or trailing attributes.

- Keep hidden script and style text out of page evidence when closing tags contain HTML whitespace or trailing attributes, or the fetched page ends inside a raw-text body.
- Preserve visible text in similarly named custom elements and retain existing fetch and evidence limits.

## 0.19.0 - 2026-09-30

Sys1 can update supported global CLI installations before work starts.

- Add `update`, `update check`, `update status`, `update enable`, and `update disable`, with automatic updates enabled by default on macOS and Linux.
- Keep SDK imports, local/source installs, executable pins, and active commands on their current code.
- Require the gateway to be stopped before updating and keep nested daemon commands on the same installation.

## 0.18.0 - 2026-09-30

Sys1 includes ALGAL to save check results and continue a scoped code review across agent sessions.

- Run `sys1 workflow check -- <command>` on macOS or Linux to save a check result and private command log without a model or account.
- Use `sys1 workflow review` to run a check before an advisory review, with an explicit model route and request limit. Pause after the check when you want to inspect it before review.
- List, show, resume, and verify saved runs. Resume checks the project, command, environment, rules, configuration, and check age before continuing; an interrupted step with an unknown outcome requires inspection instead of an automatic retry.
- Keep model bodies, command arguments, and credentials out of the saved execution record. Command output is stored separately in private logs with size and retention limits.
- Let the review skill use the combined workflow when the agent already needs to run a repository check and review its changes. Existing review-only commands remain available.

## 0.17.1 - 2026-09-30

Sys1 makes installation and everyday checks easier to follow, with working CLI examples and a shorter path from the website to the first useful command.

- Start CLI help with installation confirmation, review and completion-check commands, and explicit hosted or local setup.
- Provide a complete JSON request in evaluation help, with gateway prerequisites.
- Shorten installation guides and move the full runtime reference to `docs/runtime.md`.
- Lead the website with the independent compact-output skill, then explain optional Sys1 workflows and their measured limits.

## 0.17.0 - 2026-09-28

Sys1 adds a portable verification skill and clearer guides for reviewing changes and checking completion claims with coding agents.

- `sys1 verify setup codex|claude-code|devin` installs project instructions for checking a final-message file or stdin, with a dry-run preview and protection for existing user edits. Setup makes no model calls, adds no hooks, and changes no backend settings.
- Review instructions explain how to choose task-owned paths and repository rules across languages, and verification instructions distinguish explicit messages from optional Devin session discovery and transcript evidence.
- Verification distinguishes a claim that a pull request was merged from a message that only says it was opened or pushed, so an open linked PR does not by itself create a contradiction.
- The README, homepage, documentation, skills guide, and machine-readable guide explain each workflow, its limits, and the Jev integration. Page metadata, a sitemap, and crawler instructions improve discovery without changing model-quality claims.
- `bun run release:sync` updates current public release references from the package version, and the repository check detects stale installation links while preserving historical reports.

## 0.16.1 - 2026-09-28

Sys1 fixes live-page checks in `sys1 verify` and sharpens the page judgment.

- Pages larger than 24 KiB are truncated to their leading evidence instead of being discarded, so verify no longer reports ordinary pages as unverifiable.
- The page judgment asks whether the claimed content is visibly present, which separated hidden and absent claims from confirmed ones in a small live-site check.

## 0.16.0 - 2026-09-28

Sys1 adds `sys1 verify`, an experimental check of an agent's final message against reachable evidence.

- `sys1 verify --model <backend/model>` reads the newest Devin session for the current directory, a `--message` file, or piped text, and checks claims such as deployed, merged or pushed, committed, checks passed, and complete against the Git worktree, linked pull requests, check-command results in the transcript, and fetched live pages. Contradicted claims exit 7; unverifiable evidence is never a contradiction; incomplete runs exit 8.
- Live-URL checks accept `--url` for pages the message did not link; fetched pages are judged against the claimed change on the selected route.
- The installed review skill tells agents to verify before reporting completion. Message and page text are never stored.

## 0.15.0 - 2026-09-28

Sys1 adds Devin setup for agent review and a read-only `sys1 usage` report on how often coding agents use Sys1, and adopts a new one-line description.

- `sys1 review setup devin` installs the project review skill at `.devin/skills/sys1-review/SKILL.md`, alongside the Codex and Claude Code targets. It adds no hooks and configures no models.
- `sys1 usage [--days <n>]` counts `sys1` subcommands, `system-one-skills check` runs, and Sys1 or System One skill loads in local Devin, Claude Code, and Codex transcripts, per agent and per day. It prints counts only, never prompt text, command text, paths, or source, and makes no model calls.
- The one-line description now reads: Sys1 helps coding agents review changes against your repository's rules, with probability-scored answers from hosted Jev, a local model, or your own server. Review remains experimental and advisory.

## 0.14.0 - 2026-09-27

Sys1 lets agents focus a review on selected rules and records what narrower requirements changed in experiments on historical code.

- Add repeatable `--rule <id>` to `sys1 audit` or `sys1 review checkpoint` to check selected active rules without rewriting a pack. Unknown IDs fail before model calls, and selecting rules preserves repository overrides, path restrictions, and review freshness checks.
- The project skill and review guide explain how to preview selected checks and draft a specific repository requirement.
- A frozen 24-request experiment revisits three previously missed defects. Specific requirements detected two; adding full supporting files detected none. The native activation case remained undetected. These known examples guide the workflow and do not establish detection on unseen defects.
- Publish a separate ten-case clean-control check and CLI trials on selected changes in complete Sys1, Ghostget, and design-kit checkouts. All three checkpoints completed and repeated without additional requests; the reports preserve the limits on detection and review-time claims.

## 0.13.0 - 2026-09-27

Sys1 adds an advisory agent review workflow: check a batch of edits, investigate candidates, record feedback, and recheck the original evidence.

- `sys1 review setup codex|claude-code` installs project instructions without changing models or adding hooks. Checkpoints preview selected paths and request counts, require an explicit backend/model route, and retain audit's request and time limits.
- `sys1 review checkpoint` reuses unchanged complete batches for up to 24 hours and suppresses repeated candidates. Private worktree metadata retains up to 2,000 findings without source, raw answers, rule prose, or model scores.
- `sys1 review issues` lists recorded candidates; `feedback` records useful, incorrect, or unverifiable judgments. `recheck` evaluates available original evidence again. Changed, missing, or superseded evidence is never marked fixed; incomplete and stale results exit 8.
- `sys1 rules draft`, `check`, and `list` help turn repository conventions into inactive drafts, validate their structure, and inspect active packs. Activating a draft requires moving it into the repository's rules directory.
- An opt-in source benchmark includes four candidate rules and historical defects and controls from Sys1, Ghostget, and design-kit, with source hashes, independent label review, and deterministic baselines. These discovery examples stay outside the packaged and default rule packs.

## 0.12.0 - 2026-09-27

Sys1 can review a Git diff with reusable rules and report candidates for an agent or developer to inspect. This audit is experimental and advisory; its model scores are not calibrated defect probabilities.

- `sys1 audit` reviews staged, working-tree, or committed changes with an explicitly selected backend and model. It preserves removed lines, reads staged content from the index, and reports excluded or incomplete evidence.
- Bundled rules look for newly empty error handlers and removed test assertions. Repository and user rule packs can override or extend them. `--dry-run` previews paths, rules, and request count without calling a model.
- Audits have request and time limits, never retry model calls, and keep source and answers out of persistent storage. Findings do not fail the command; incomplete coverage exits 8. Audit installs no automatic hooks.
- An opt-in fixture benchmark reports confusion counts, uncertainty intervals, token usage, and latency separately for calibration and held-out examples. It does not automatically approve a rule for production use.

## 0.11.0 - 2026-09-26

The sys1 command line is easier to read: a short start screen, help for every command, errors that say what to run next, and a setup that shows the download size first.

- Running `sys1` alone prints a short start screen. `sys1 --help` is grouped with a "Start here" block, and every command has its own help (`sys1 setup --help`, `sys1 help setup`).
- `sys1 setup --dry-run` and `sys1 setup` show the model, its size and the folder it downloads to before the first byte; `--json` adds a `download` object. Download progress redraws one line in a terminal and stays quiet in pipes.
- `sys1 doctor` prints one line per check with ✓, ⚠ or ✗, a count, and the command to run next. Check summaries use plain words; check ids and the JSON shape are unchanged.
- Errors are one sentence and one next command, such as `✗ Unknown command "stauts". Did you mean "status"?`, instead of the full usage. With `--json`, or when an agent runs sys1, they are one `{"ok":false,"error":{...}}` object on stdout. Exit codes are unchanged.
- When Claude Code, Codex, Cursor, Gemini CLI or `AI_AGENT` is detected, commands that support `--json` print JSON by default. `HRANESS_AUDIENCE=human` keeps text.
- `sys1 --version` and `-V` print `sys1 0.11.0`; `sys1 --version --json` prints the name and version.
- `sys1 status`, `up` and `down` print short sentences with ●/○ for the gateway state. Symbols fall back to ASCII with `TERM=dumb`, and `NO_COLOR` turns color off.

## 0.10.0 - 2026-09-21

Sys1 can send decisions to a Kev server you run, and versioned decision profiles let you reuse the same questions and instructions with hosted Jev, a local model, or Kev.

- `sys1 backend add --adapter kev` registers a Kev server. The gateway converts each request and response to and from Kev's format, keeps Kev's two-decimal probabilities without renormalizing them, and marks Kev answers with `x-sys1-adapter: kev` and `x-sys1-probability-decimals: 2`. Kev never receives unpinned traffic; a request reaches it only with a `backend/model` pin.
- `sys1 backend check` tests a Kev backend against Kev's decision format.
- `createProfile` (from `@hraness/sys1` and `@hraness/sys1/client`) builds a frozen, versioned profile with a pinned model and fixed questions. `profile.request(state)` returns an ordinary System One request.
- `sys1 eval --profile FILE` applies a saved profile to JSON input that contains only `{"state": ...}`. `examples/ticket-triage.profile.json` is a starting profile.
- The client accepts `adapter: "kev"` for calling a Kev endpoint directly, and reports Kev's precision in the response metadata.
