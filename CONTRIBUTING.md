# Contributing

sysone is early and the contract is deliberately narrow. Contributions are
welcome; the bar is that the loopback, credential, and bounded-input
invariants stay checkable.

## Setup

Requires Bun ≥ 1.3.14 (`bun install`).

## Checks

```sh
bun run check
```

Runs the typechecker, the test suite, the dist build, and the packed-package
smoke check.

## Rules of the house

- Parse every foreign value from `unknown`; bound every input.
- Keep the gateway loopback-only. No non-loopback bind, no ambient network or
  credential access beyond the configured hosted key environment variable.
- Never log or persist request bodies, `state`, `questions`, answers, or
  credentials — routing metadata only.
- A backend that returned a response is definitive; only transport failures
  may re-dispatch, once, and never for pinned models.
- Keep `--json` additive-only and machine-readable.
