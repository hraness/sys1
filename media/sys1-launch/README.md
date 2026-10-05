# Introducing Sys1 film

A 52-second launch film for Sys1, authored as deterministic Canvas typography and diagrams and rendered locally with Slopcamera 3.4.0. The score is an original synthesized instrumental composition. There is no spoken narration.

The film follows the shared Hraness Tokyo Night palette and uses the repository's unmodified Nebula Sans typeface assets. Review and verification examples are illustrative and advisory. Cloudflare Clef remains opt-in, local Qwen remains experimental, and the workflow profiles are identified as source-checkout experiments.

## Edit and render

The recorded render used Python 3.14.6 with NumPy 2.5.3, Slopcamera 3.4.0, and its verified local Chrome/FFmpeg runtime (FFmpeg 7.1.5). The Slopcamera CLI coordinates its own rendering resources. Run from this directory:

```sh
python3 build-source.py
python3 score.py
slopcamera doctor --json
slopcamera html render --input preview.json --json
slopcamera html render --input master.json --json
```

`scene.template.html` contains the authored motion. `build-source.py` embeds the repository's existing font files and emits `scene.html`. No network font or third-party library is loaded. `score.py` writes the original 48 kHz stereo WAV from oscillators and a fixed score; no samples or external music are used. `master.json` requests a native 3840 × 2160 master at 24 fps. `preview.json` samples eight representative moments for visual review.

Slopcamera returns the output movie, retained scene, ordinary editable project, and render receipt. Its generated `artifacts/` directory and the WAV stay local. Keep the returned master and exact receipt together. The site serves the compact 1080p derivative, poster, social crop, captions, and prose transcript in `site/media/`.

For a site derivative, use the returned master path as `MASTER`:

```sh
ffmpeg -i "$MASTER" -vf scale=1920:1080:flags=lanczos -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -c:a copy -movflags +faststart ../../site/media/sys1-launch.mp4
```

The film has no narration; its WebVTT track describes the visible story and significant music. Its plain-text transcript also describes the diagrams and their changes. Render receipts establish file identity and settings. Public provenance records actual visual review and distinguishes audio signal checks from listening.

## Sources and rights

- Authored motion and oscillator score: original work for this repository, under the repository's MIT license.
- Sys1 mark: repository asset, `site/marks/sys1.svg`.
- Nebula Sans: existing repository asset, with SIL Open Font License and provenance in `site/vendor/nebula-sans/`.
- Product facts: `PRODUCT.md`, `src/verify/verify.ts`, and the current review, verification, and profile-evaluation guides.
- No paid generation, provider upload, external footage, or stock music was used.
