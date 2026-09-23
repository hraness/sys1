# Shared appearance assets

This directory owns the released appearance menu, palette bridge, palette system,
and license. `site/appearance.js` is a generated bundle of Sys1's authored
`scripts/site-appearance.js` bootstrap and the pinned shared browser export.
Lantern belongs to the separate strict `site/vendor/hraness-lantern` snapshot.

After the reviewed design-kit release is available, install that checkout's
dependencies from its frozen lockfile and run with Bun 1.3.14:

```sh
bun scripts/build-site-appearance.ts --refresh KIT_CHECKOUT FULL_COMMIT vVERSION
bun scripts/build-site-appearance.ts --check
```

Refresh verifies that the stable local tag resolves to the supplied full commit.
CSS, license, browser identity, and dependency-lock receipts come from that Git
object. The actual browser artifact and lock must match before bundling, and inputs
are checked again before publication. The palette bridge's relative import resolves
to the adjacent palette-system file. Review the upstream third-party notices when
upgrading the recorded dependency lock.

Generation binds the canonical physical repository root and each output directory.
Linked roots or ancestors, non-directory ancestors, and linked or non-regular owned
files are rejected before publication. Reads use no-follow file descriptors, and
directory identities are rechecked before every published file, including the final
receipt. A redirected output tree cannot be accepted by the integrity check.

The version-2 receipt separately records upstream artifacts, the authored bootstrap,
and the generated bundle. Check verifies their measured hashes and byte counts.
The previous digest-checked bundle-only command remains available:

```sh
bun scripts/build-site-appearance.ts KIT_CHECKOUT/dist/browser/index.js
```

That command does not upgrade upstream palette assets. Use refresh for an upstream
release change. Generation publishes the receipt last; interruption or partial
publication fails the check and requires rerunning the generator. No missing asset
or future-release digest may be filled in by hand.

The checked-in version-1 receipt predates this palette migration. Its generated
files remain untouched until the stable design-kit release is selected; delivery
requires a successful version-2 refresh and check.
