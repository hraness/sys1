# Sys1 icon

The boxed numeral takes its cue from **1️⃣**. Its geometry is original SVG
artwork: a rounded square and a wide numeral with an angled flag and a broad
foot. It does not depend on a font, an emoji image, or an image model.

The blue, single-ink mark appears beside `sys1.io` in every page header and
in the [Hraness project grid](https://hraness.com). The browser and home-screen
icons use the same paths with the shared two-tone palette and black background.

## Generate and verify

```sh
bun install --frozen-lockfile
bun run brand:generate
bun run brand:check
```

Edit `sys1.source.json`, then regenerate; do not edit derived files. The
generator and its pinned Sharp dependency live in this repository. The
manifest records the source, recipe, raster toolchain, and asset hashes.
`brand:check` also runs in the repository's full check. It verifies the source
and generator hashes, exact SVG output, committed raster hashes and dimensions.
It preserves the canonical render across platforms instead of requiring native
raster libraries on every OS to emit identical compressed PNG bytes.

| Asset | Use |
| --- | --- |
| `site/marks/sys1.svg` | 160-unit, transparent blue mark; rendered at 32px in headers |
| `brand/sys1.illustration.svg` | Same mark with additional space for larger artwork |
| `brand/sys1.duotone.svg` | Two path source for application icons |
| `site/icon.png` | 512px browser/application icon |
| `site/apple-icon.png` | 180px home-screen icon |
| `site/favicon-16.png`, `site/favicon-32.png` | Small browser icons |
| `site/favicon.ico` | The same 16px and 32px PNGs in an ICO container |

Generation checks visible coverage and the transparent numeral at 16px and
32px. Review those sizes visually after any geometry change. Keep the mark
uncropped and preserve the transparent numeral; adding an outline or shrinking
the numeral weakens recognition at small sizes. Keep the Hraness project-grid
artwork synchronized with the mark and illustration when changing the identity.

The selected design was reviewed at 16, 32, 64 and 160px. A Slopcamera model
candidate was rejected because its filled tile lost the numeral; the shipped
geometry is authored and reproducible. No generated raster candidate ships.
