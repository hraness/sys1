# Platform mark sources

`apple.svg` and `linux.svg` are vendored unmodified from the
[`simple-icons`](https://github.com/simple-icons/simple-icons) npm package
**16.33.0** (`icons/apple.svg`, `icons/linux.svg`), released under CC0-1.0
(see `LICENSE`). `src/platforms.ts` carries their single `<path d>` values
verbatim for the macOS and Linux marks; `src/platforms-vendor.test.ts` pins the
file SHA-256 digests and checks that the module paths still match them.

The Windows four-pane window and the neutral terminal glyph in
`src/platforms.ts` are original geometry drawn for this package and are
covered by the package MIT license. They are not vendor artwork.

The marks identify the operating system a command targets (nominative use).
They are drawn in `currentColor` so surfaces keep one ink.
