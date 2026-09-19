# Contributing

Sys1 is early and the contract is deliberately narrow. Contributions are
welcome; the bar is that the loopback, credential, and bounded-input
invariants stay checkable.

## Setup

Requires Bun ≥ 1.3.14 (`bun install`).

## Checks

```sh
bun run check
```

Runs the typechecker, deterministic tests, the dist build, and an isolated
import/CLI execution check against the actual packed tarball.

After that gate, `bun run check:native` packs the existing dist, installs it in
a disposable prefix with the pinned native dependency, and runs `sys1 doctor`.
Pull-request CI runs this additional check on Linux, macOS and Windows so
native installation and startup failures are found before tagging a release.
It downloads package/native binaries, but no model weights, and calls no
hosted inference. The release workflow still verifies the exact uploaded
artifact separately on all three platforms.
Commands bound output and execution time, terminate their owned process tree,
and collect the tracked child. If descendant cleanup cannot be confirmed
(for example, a Windows parent exits while a descendant retains its pipes),
the check fails with `native_check_cleanup_unconfirmed` and retains its unique
temporary paths for recovery instead of deleting potentially live files.

## Rules of the house

- Parse every foreign value from `unknown`; bound every input.
- Keep the gateway loopback-only. Runtime network access is limited to
  configured backends; model network access occurs only during explicit pulls.
- Log routing metadata only. Never persist request bodies, answers, or
  credentials as durable state. Preserve the documented private Needle tools-file
  exception and its request-lifetime cleanup.
- Admit model files only after bounded streamed download, exact SHA-256, safe
  store-local filename, regular-file, and bounded GGUF structure verification.
  Never add weights to git, releases, packages, or ordinary CI.
- A backend that returned a response is definitive; only transport failures
  may re-dispatch, once, and never for pinned models.
- Keep fake-engine tests deterministic. Put heavyweight live qualification
  outside the ordinary test gate.
- Keep `--json` additive-only and machine-readable.

## Needle process boundary

The explicitly pinned Needle specialist requires a private per-request tools
file containing question instructions and criteria, deleted when the request
settles. Its native CLI receives state as a process argument, visible to local
process inspection. Abrupt host termination can leave the private temporary
file behind. Do not use this adapter for inputs whose policy forbids that
exposure. The GGUF worker uses private pipes; ordinary request bodies,
credentials, answers, and prompts are not application logs or durable state.
