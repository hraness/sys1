# Contributing

Contribute a focused fix, a well-scoped rule, or an integration backed by
reproducible evidence. Preserve the loopback, credential, and bounded-input
invariants and run the checks below before submitting a change.

## Setup

Requires Bun ≥ 1.3.14 (`bun install`).

## Checks

```sh
bun run check
```

Runs the typechecker, current release-reference and brand checks, deterministic
tests, the dist build, and an isolated import/CLI execution check against the
actual packed tarball.

When bumping `package.json`, run `bun run release:sync` to update the runtime
version and add the matching changelog section. Public install links follow
`site/published-release.json`, independently of the source version. Advance
that record only after the immutable release and its installation checks have
passed, then run `bun run release:sync` and verify the published site.
Historical reports retain their original versions. The aggregate check rejects
stale source versions and public release references.

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
  credentials as durable state. Send GGUF worker input through private pipes.
- Admit model files only after bounded streamed download, exact SHA-256, safe
  store-local filename, regular-file, and bounded GGUF structure verification.
  Never add weights to git, releases, packages, or ordinary CI.
- A backend that returned a response is definitive; only transport failures
  may re-dispatch, once, and never for pinned models.
- Keep fake-engine tests deterministic. Put heavyweight live qualification
  outside the ordinary test gate.
- Keep the default routes explicit: opt-in Cloudflare Clef and the installed model
  named by `local.model` (Qwen3 1.7B by default). Other installed models and
  configured HTTP services require a request pin. A new download or registration
  must not change automatic fallback behavior.
- Keep `--json` additive-only and machine-readable.

## npm

After the GitHub Release, the release workflow's `npm` job publishes the
released tarball to npm as `@hraness/sys1` with a provenance attestation. It
uses npm trusted publishing, so GitHub Actions proves the workflow's identity
to npm and no npm token is stored anywhere. No one needs to approve a release.
The job skips a version that npm already has.

npm only accepts trusted publishing for a package that already exists, so the
job warns and skips until a maintainer does this once:

1. Publish the newest release tarball by hand:
   `gh release download vX.Y.Z --repo hraness/sys1 --pattern '*.tgz'` and
   `npm publish hraness-sys1-X.Y.Z.tgz --access public`.
2. Let this workflow publish from now on:
   `npm trust github @hraness/sys1 --repo hraness/sys1 --file release.yml --allow-publish --yes`
   (npm 11.16 or newer).
3. In the package settings on npmjs.com, require two-factor authentication and
   disallow tokens.
