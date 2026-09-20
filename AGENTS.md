# Contents

- `src/protocol.ts` owns the System One wire format: request/response schemas,
  body and field bounds, and the shared error envelope.
- `src/config.ts` owns the `~/.sys1/config.json` schema, defaults, load/save,
  and the settable-key registry. `SYS1_HOME` overrides the state directory.
- `src/router.ts` owns backend selection as a pure function over probed
  candidates — policy order, model pinning, cheapest-smallest local order,
  capability limits, and specialist exclusion from unpinned fallback.
- `src/backends.ts` owns runtime backends: hosted Jev (credential from the
  environment only), configured HTTP services, installed builtin candidates,
  bounded probing (including advisory `GET /v1/limits`), and request
  forwarding.
- `src/defaults.ts` owns qualified platform targets and deterministic compact
  versus quality local-model recommendations.
- `src/qualification.ts` owns bounded conformance checks for operator-configured
  System One HTTP backends.
- `src/local/decide.ts` owns bounded generic-GGUF prompts and the pure mapping
  from vocabulary probability mass to System One answers.
- `src/local/engine.ts` owns the lazy node-llama-cpp lifecycle and serialized
  first-token distribution evaluation.
- `src/local/torchckpt.ts` owns the bounded ZIP reader, restricted pickle
  interpreter, and tensor materialization for `torch.save` checkpoints.
- `src/local/scorer.ts` owns the pure-TypeScript CUA-S1 tiny/tinyx option
  scorer: checkpoint config validation and the forward pass.
- `src/local/needle.ts` owns the bounded per-request Cactus Needle engine
  process: tools/prompt bounds, telemetry disabled, validated JSON turns.
- `src/local/adapt.ts` owns the System One ↔ scorer/Needle contract mappings
  and the disclosed needle-extract probability approximation.
- `src/local/store.ts` owns the curated model registry, the SHA-256-admitted
  multi-kind store (`gguf`, `scorer`, `needle` + engine companion), manifest,
  download limits, structural validation, verification, and removal.
- `src/local/runner.ts` owns builtin candidate enumeration, engine/scorer
  residency, per-kind dispatch, and local response assembly.
- `src/gateway.ts` owns the loopback HTTP surface (`POST /v1/systemone`,
  `GET /v1/models`, `GET /healthz`), request validation, and the bounded
  retry loop.
- `src/daemon.ts` owns the pid file, detached spawn, health checks, and
  stop/status lifecycle.
- `src/doctor.ts` owns the stable versioned readiness report. Keep checks
  bounded, read-only, credential-free, and additive by id.
- `src/cli.ts` owns the `sys1` command surface and exit codes.
- `src/client.ts` is the portable Node/Bun client and `/client` export.
- `src/runtime.ts` is the embedded Bun router with explicit disposal.
- `src/index.ts` is the runtime package public surface.
- `test/` contains protocol, routing, config, gateway, model-store, decision,
  and fake-engine tests; no ordinary test downloads weights, touches the
  network, or uses a real credential.
- `scripts/` holds the dist build, isolated exact-tarball package smoke, and
  cross-platform release install verification.
- `site/` is the static sys1.io landing page; it has no product-runtime
  connection.
- `.github/workflows/check.yml` is read-only CI. `release.yml` is the annotated
  stable-tag channel for exact cross-platform artifacts and immutable GitHub
  Releases; it does not publish npm.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` are the public
  contract.

# Guidelines

- Use Bun 1.3.14. Run `bun run check` before handoff: strict typecheck,
  tests, dist build, and packed-package smoke check.
- Reject oversized local input without silently truncating evidence.
- Keep the gateway loopback-only. Config must reject non-loopback binding. Do
  not add remote state without an explicit authenticated design change.
- Read the hosted credential from the environment only. Never persist keys,
  log them, or put them in the config file, `--json` output, or error bodies.
- Never log request `state`, `questions`, or answer bodies; log routing
  metadata only. Keep the documented private Needle tools-file exception
  bounded to its request lifecycle; other adapters use pipes, not request files.
- Parse every foreign value from `unknown` through the protocol schemas.
  Bound every input: body bytes, state bytes, question counts, options,
  timeouts, probes, and retry count.
- A backend that returned any HTTP response is definitive; only transport
  failures (no response) may re-dispatch, at most once, and never for a
  `backend/model` pinned request. Surface retries via `x-sys1-attempts`.
- Keep `--json` stable and machine-readable; additive fields only. Data to
  stdout, diagnostics to stderr, closed exit codes.
- Download weights only from explicit `sys1 setup` or `sys1 pull`; cap
  size, require a trusted SHA-256, stream to a temporary file, and admit only
  after digest, size, per-kind bounded structure (GGUF header, restricted
  torch checkpoint, `.cact` header/directory), safe filename, and regular-file
  checks. Needle entries also verify their platform engine companion the same
  way. Never put weights in git, release artifacts, or ordinary CI.
- Treat generic-GGUF answers as an approximation, not calibrated Jev output.
  Scorer and needle adapters disclose their contracts via `x-sys1-local-*`
  adapter headers; needle probabilities are a confidence-derived
  approximation, not per-option distributions. Keep Noul/Choice/Score answer
  objects exactly Jev-compatible. Do not make stronger model-quality claims
  without checkpoint-specific qualification.
- Keep local inference lazy, serialized, cancellation-bounded, and
  residency-capped. Needle runs one bounded process per request with
  telemetry disabled. Terminate and collect owned native worker processes on timeout, abort,
  eviction, and shutdown. Never claim unsupported native AbortSignal semantics.
- Specialist models (scorer, needle) never receive unpinned fallback traffic;
  honor published backend capability limits (`/v1/limits`) as advisory, and
  fail over-capability requests closed as `request_unsupported`.
- Keep operator-registered HTTP runners separately owned; never mutate their
  weights, credentials, or process lifecycle. Qualify discovery, limits, and
  response conformance without exposing request or response bodies.
- Fresh config is local-first: hosted Jev stays disabled even when its
  environment credential exists. Only `sys1 jev enable` activates it; the
  credential remains environment-only.
- Releases use one annotated `v<version>` tag at exact current `main`. Preserve
  exact tarball/checksum identity, Ubuntu/macOS/Windows artifact execution,
  repository release immutability, and the no-npm-publication boundary.
- Keep the public repository independently buildable. No sibling checkouts,
  private packages, internal project names, or unpublished provenance.

<!-- oompa-local-efficiency:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the gates applicable to that action pass. Do not ask for duplicate confirmation. Build confidence through relevant automated checks, bounded diagnostics, and independent review, not another human approval. Passing checks does not expand task scope or authority.
- Prefer agentic service provisioning for new infrastructure. Check Vercel Marketplace for a native product that can provision the required resource first; use Stripe Projects as a supported alternative when it better covers the service or the Marketplace route only connects an existing account. Verify the current catalog, account, region, plan, recurring cost and resource capabilities before selecting a route. Prefer supported provider CLIs or APIs over browser-only setup when neither catalog fits, and explain the concrete exception. Reuse existing owner-controlled resources where appropriate; this preference alone does not authorize migrations, duplicate accounts, paid upgrades or wider access. Continue setup already authorized by the task and budget without duplicate confirmation. Keep provider credentials and generated environment files private, complete required interactive authentication, and verify deployment, persistence and recovery separately from successful provisioning.
- Separate artifact admission from live qualification and operational activation. Use applicable automated source, security, package/install, and provenance evidence for artifact admission; live provider qualification is not a universal publication prerequisite. Preserve explicit live acceptance criteria and require relevant live evidence for claims that depend on it. If publication or an artifact's install, upgrade, or default-use path activates risky unqualified behavior, keep that behavior guarded or disabled, or obtain bounded relevant evidence before shipping or activation.
- Use the repository's documented delivery workflow and preserve the identity, target, capacity, migration, and recovery guards applicable to operational activation. Replace an obsolete gate through a reviewed source and policy change with corresponding tests, never an ad hoc skip. Preserve every runtime-enforced approval, access control, branch protection, environment rule, safety policy, and required final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, unavoidable interactive authentication, an irreversibly destructive action outside task scope, or resolution of a failure that cannot be handled safely and autonomously.
- Preserve production and user data throughout delivery. Inspect the exact account, environment, deployment, and data target before writes. For data changes, inspect a dry run or equivalent migration plan and validate the recovery path before any effect that could lose or corrupt data. Prefer additive, backward-compatible migrations and bounded batches. Record mutation intent, use idempotency or conditional writes, and reconcile uncertain results before retrying. Verify deployed identity, health, and relevant data invariants after delivery. Routine delivery never authorizes resetting, truncating, dropping, or overwriting user data; stop the unsafe operation if preservation or recovery cannot be established.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Use unattended stable publication and production promotion when supported by the provider and repository. Establish supported machine authority once and verify it with a non-publishing preflight where available; routine releases should not require recurring interactive authentication or conversational approval. Retain account two-factor authentication and provider controls, including required authentication for approval of an exact staged artifact; do not add long-lived personal tokens to eliminate an interactive prompt.
- Keep delivery gates proportional to the failure they prevent. Prefer required checks on the current integration candidate, independent agent review, and atomic or conditional integration. Add a merge queue or another approval stage only for a demonstrated coordination or safety need. Replace redundant queues, serial waits, and duplicate checks through reviewed policy changes while retaining evidence for the integrated result.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use `$oompa-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- oompa-local-efficiency:end -->


## Needle process boundary

The explicitly pinned Needle specialist requires a private per-request tools
file containing question instructions and criteria, deleted when the request
settles. Its native CLI receives state as a process argument, visible to local
process inspection. Abrupt host termination can leave the private temporary
file behind. Do not use this adapter for inputs whose policy forbids that
exposure. The GGUF worker uses private pipes; ordinary request bodies,
credentials, answers, and prompts are not application logs or durable state.
