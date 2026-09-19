# Contributing

SysOne is early and the contract is deliberately narrow. Contributions are
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

## Rules of the house

- Parse every foreign value from `unknown`; bound every input.
- Keep the gateway loopback-only. Runtime network access is limited to
  configured backends; model network access occurs only during explicit pulls.
- Never log or persist request bodies, `state`, `questions`, answers, prompts,
  vocabulary distributions, or credentials — routing metadata only.
- Admit model files only after bounded streamed download, exact SHA-256, safe
  store-local filename, regular-file, and bounded GGUF structure verification.
  Never add weights to git, releases, packages, or ordinary CI.
- A backend that returned a response is definitive; only transport failures
  may re-dispatch, once, and never for pinned models.
- Keep fake-engine tests deterministic. Put heavyweight live qualification
  outside the ordinary test gate.
- Keep `--json` additive-only and machine-readable.
