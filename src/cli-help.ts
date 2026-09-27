// Help text for the sys1 CLI (SPEC § D2, § D3): a short start screen, grouped
// root help, and one block per command for `sys1 <command> --help`.

export const SYS1_COMMANDS = [
  "setup", "jev", "up", "down", "serve", "status", "doctor", "pull", "model", "models",
  "backend", "config", "eval", "audit", "review", "rules", "help", "version",
] as const;

const DESCRIPTION = `Sys1 lets agents ask yes/no, choice, and score questions and get validated
answers with probabilities from hosted Jev, a local model, or your own server.`;

export function bareScreen(version: string): string {
  return `${DESCRIPTION}

Start here
  sys1 setup --dry-run       See what setup would download
  sys1 setup                 Download the local model and turn it on
  sys1 up                    Start the gateway in the background
  echo '{…}' | sys1 eval     Ask a question through the gateway

Everyday
  sys1 status                Gateway state and which models can answer
  sys1 doctor                Check the install and say what to fix

All commands: sys1 --help · Command help: sys1 help <command>
sys1 ${version}
`;
}

export function rootHelp(settableKeys: readonly string[]): string {
  return `Usage: sys1 <command> [options]

${DESCRIPTION}

Start here
  sys1 setup [--dry-run]     Download the local model and turn it on
  sys1 up                    Start the gateway in the background
  sys1 eval [--file <path>]  Ask a question through the gateway

Setup
  sys1 jev status|enable|disable
                             Use hosted Jev (needs TYPESAFE_API_KEY)
  sys1 doctor                Check the install and say what to fix

Gateway
  sys1 status                Gateway state and which models can answer
  sys1 down                  Stop the background gateway
  sys1 serve                 Run the gateway in this terminal

Models
  sys1 pull [<model>]        Download and verify a model (--list shows all)
  sys1 model list|verify|remove
                             Manage installed models
  sys1 models                List models on every reachable backend

Review (experimental)
  sys1 audit --staged --model <backend/model>
                             Suggest changes using reusable rules
  sys1 review checkpoint|issues|feedback|recheck|setup
                             Review batches and track investigated candidates
  sys1 rules list|check|draft
                             Inspect rules or draft repository conventions

Routing
  sys1 backend list|add|check|remove
                             Manage your own System One HTTP servers
  sys1 config path|get|set|unset
                             Show or change settings

Options
  --json          Print JSON (the default when an agent runs sys1)
  -h, --help      Show help (also: sys1 <command> --help)
  -V, --version   Show the version

Settings: ${wrapList(settableKeys)}
State folder: SYS1_HOME (default ~/.sys1) · Gateway: http://127.0.0.1:13900
`;
}

function wrapList(items: readonly string[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line === "" ? item : `${line}, ${item}`;
    if (next.length > 68 && line !== "") {
      lines.push(`${line},`);
      line = item;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines.join("\n  ");
}

const COMMAND_HELP: Readonly<Record<string, string>> = {
  review: `Usage: sys1 review checkpoint <--staged|--worktree|--since <ref>>
                   --model <backend/model> [options] [-- paths...]
       sys1 review issues [--json]
       sys1 review feedback <id> useful|incorrect|unverifiable [--json]
       sys1 review recheck <id> --model <backend/model> [options]
       sys1 review setup codex|claude-code [--dry-run] [--json]

Review a batch of Git changes, investigate candidates, and record feedback.
Experimental and advisory. Hosted Jev is opt-in; local models are experimental.

Checkpoint/recheck options
  --model <route>       Exact backend/model, with no fallback
  --dry-run             Preview paths and requests without inference or writes
  --max-requests <n>     Request cap: 1..200, default 20
  --timeout-ms <n>       Model-call deadline: 1..120000 ms, default 30000
  --gateway             Use the running loopback gateway (needed for local)
  --json, --agent        Print JSON

Checkpoint uses the same source selection and rule packs as sys1 audit.
Unchanged complete batches reuse a review for up to 24 hours. Changed rules,
source, or route trigger a new review. Repeated candidates are suppressed.
Issues lists their metadata and feedback. Recheck always evaluates again when
the original evidence is available. Superseded evidence never means fixed.

Source context goes to the selected backend. SYS1_HOME holds private metadata
and feedback, without source, raw answers, rule prose, or scores. Setup installs
a project skill, preserves edited files, and does not configure hooks or models.

Exit 0: previewed/completed, including advisory findings or unchanged batches.
Exit 8: incomplete, stale, unavailable, or superseded evidence; inspect report.

Examples
  sys1 review setup codex
  sys1 review checkpoint --staged --model typesafe/jev-1.13.0 --dry-run
  sys1 review issues --json
`,
  rules: `Usage: sys1 rules list [--json]
       sys1 rules check <pack-directory> [--json]
       sys1 rules draft <name> --ensure <sentence> --breaks <sentence>
                  --path <glob> --source <guide-path> [--dry-run] [--json]

List active rules, validate a pack, or draft a repository convention locally.
These commands make no model calls. Run them within a Git repository.

Draft requires a kebab-case name, a narrow repository-relative path glob, an
ensure sentence, a breaks sentence, and the guide's repository-relative path.
It writes .sys1/drafts/<name>/pack.yaml and leaves the rule inactive. Existing
edited files are preserved. Review the prose and test examples before moving
the pack into .sys1/rules/<name>/ to activate it for audits and checkpoints.

List includes rule revisions, source, selection, and override information.
Check validates the schema and request compilation without evaluating accuracy.
--json or --agent prints machine-readable output. --dry-run applies to draft.

Examples
  sys1 rules list --json
  sys1 rules check .sys1/drafts/await-success
`,
  audit: `Usage: sys1 audit <--staged|--worktree|--since <ref>>
                  --model <backend/model> [options] [-- paths...]

Review a Git diff with reusable rules (experimental, advisory). Findings are
candidates to inspect, not verified defects. Scores are uncalibrated.

Options
  --staged              Review HEAD versus the index
  --worktree            Review HEAD versus current files, including untracked
  --since <ref>         Review committed changes from ref to HEAD
  --model <route>       Pin the exact backend/model; no fallback
  --dry-run             List coverage and request count without model calls
  --max-requests <n>     Request cap: 1..200, default 20
  --timeout-ms <n>       Model-call deadline: 1..120000 ms, default 30000
  --gateway             Use the loopback gateway (needed for local models)
  --json, --agent        Print a machine-readable report
  -- paths...           Exact files or directory prefixes within the repository

Rules load from bundled packs, SYS1_HOME/rules, then .sys1/rules in the repo.
Later rules replace earlier rules with the same id. Only hunk rules run.
Source diff context goes to the pinned configured backend. Hosted Jev must be
enabled explicitly. Sensitive/generated paths and oversized evidence are
skipped and reported. No source, answers, or findings are saved by audit.

Exit 0: completed or previewed (including advisory findings).
Exit 8: incomplete coverage or a model error; inspect skipped in the report.

Examples
  sys1 audit --staged --model typesafe/jev-1.13.0 --dry-run --json
  sys1 audit --worktree --model typesafe/jev-1.13.0 -- src test
`,
  setup: `Usage: sys1 setup [--tier quality|compact] [--dry-run] [--json]

Download the local model for this computer, check it, and turn it on. Local
decisions are experimental; check them on your own cases first.

Options
  --tier <tier>   quality (Qwen3 1.7B, 1.0 GiB, the default) or
                  compact (Qwen3 0.6B, 365 MiB)
  --dry-run       Show what would be downloaded, then stop
  --json          Print JSON

Example
  sys1 setup --dry-run
`,
  jev: `Usage: sys1 jev status|enable|disable [--json]

Use hosted Jev for answers. enable needs TYPESAFE_API_KEY in the environment
and sends every request to Jev; disable goes back to automatic routing.

Example
  sys1 jev status
`,
  up: `Usage: sys1 up [--port <n>] [--json]

Start the gateway in the background on 127.0.0.1 (port 13900 unless you
choose another).

Example
  sys1 up
`,
  down: `Usage: sys1 down [--json]

Stop the background gateway.
`,
  serve: `Usage: sys1 serve [--port <n>]

Run the gateway in this terminal until you press Ctrl-C.
`,
  status: `Usage: sys1 status [--json]

Show whether the gateway is running, which model is selected, and which
backends can answer.
`,
  doctor: `Usage: sys1 doctor [--json]

Check Bun, the state folder, settings, the local model runtime, installed
models, routing and the gateway. Exits 6 when something needs fixing.
`,
  pull: `Usage: sys1 pull [<model>] [--sha256 <hex>] [--json]
       sys1 pull --list [--json]

Download a model and check its SHA-256. With no model, downloads qwen3-1.7b.
A model can also be hf:<org>/<repo>:<file.gguf> with --sha256.

Example
  sys1 pull qwen3-0.6b
`,
  model: `Usage: sys1 model list [--json]
       sys1 model verify <model> [--json]
       sys1 model remove <model>

List installed models, recheck a model's SHA-256, or remove one.
`,
  models: `Usage: sys1 models [--json]

List the models every reachable backend offers.
`,
  backend: `Usage: sys1 backend list [--json]
       sys1 backend add --name <n> --url <url> --model <m> [options]
       sys1 backend check --name <n> [--json]
       sys1 backend remove --name <n>

Manage your own System One HTTP servers. check sends a test question of each
type and reports what works.

Options for add
  --adapter <a>     systemone (default) or kev
  --size-b <n>      Model size in billions of parameters
  --cost-rank <n>   Lower numbers are tried first

Example
  sys1 backend add --name lab --url http://127.0.0.1:8080 --model lab-7b
`,
  config: `Usage: sys1 config path|get
       sys1 config set <key> <value>
       sys1 config unset <key>

Show or change settings. The keys you can set are listed at the end of
sys1 --help.

Example
  sys1 config set routing.policy prefer-local
`,
  eval: `Usage: sys1 eval [--file <path>|-] [--profile <path>] [--json]

Send one System One request to the running gateway and print the answer. The
request is JSON from --file or standard input. With --profile, the input is
{"state": ...} and the profile turns it into the request.

Example
  sys1 eval --file request.json
`,
  version: `Usage: sys1 version [--json]

Print the version. Same as sys1 --version.
`,
};

export function commandHelp(command: string): string | undefined {
  return Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
}

export const SYS1_HELP_TOPICS = Object.freeze(Object.keys(COMMAND_HELP));
