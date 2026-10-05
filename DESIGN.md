---
name: "Sys1 · Tokyo Night"
description: "The implemented Sys1 system: paired Tokyo Night colors, Nebula Sans, quiet rules, and readable developer workflows."
colors:
  primary: "light-dark(#1d4e90, #7aa2f7)"
  primary-foreground: "light-dark(#e1e2e7, #1a1b26)"
  primary-soft: "light-dark(#ccd6e7, #262b3f)"
  focus: "light-dark(#1d4e90, #7aa2f7)"
  background: "light-dark(#e1e2e7, #1a1b26)"
  foreground: "light-dark(#1c3161, #c0caf5)"
  muted: "light-dark(#414c76, #a9b1d6)"
  grid: "light-dark(#c4c8da, #24283b)"
  line: "light-dark(#b7c1e3, #292e42)"
  surface: "light-dark(#d0d5e3, #16161e)"
  surface-hover: "light-dark(#b7c1e3, #292e42)"
typography:
  display:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, sans-serif'
    fontSize: "clamp(3rem, 4.5vw, 4.6rem)"
    fontWeight: 550
    lineHeight: 1.04
    letterSpacing: "-.04em"
  headline:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, sans-serif'
    fontSize: "clamp(1.75rem, 1.3rem + 1.9vw, 2.75rem)"
    fontWeight: 550
    lineHeight: 1.08
    letterSpacing: "-.02em"
  body:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  code:
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace'
    fontSize: ".8rem"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  compact: ".375rem"
  control: ".5rem"
  frame: ".75rem"
spacing:
  related: ".75rem"
  standard: "1rem"
  gutter-mobile: "1.25rem"
  gutter: "2rem"
  section-mobile: "3.5rem"
  section: "5rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.control}"
    padding: ".6rem 1.2rem"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: ".6rem 1.2rem"
  code-frame:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.frame}"
---

# Sys1 design system

Current implementation, September 30, 2026. Sys1 uses Tokyo Night colors and
Nebula Sans throughout its marketing, documentation, and launch article. The
homepage leads with compact test output from System One Skills, then explains
optional Sys1 review, completion checks, and the typed decision API. Cloudflare Clef remains opt-in and local models experimental.
The copyable platform installer sits beneath the hero summary at `#install`;
the later `#setup` section explains the first run.

This document describes the shipped HTML/CSS and the launch changes in this
checkout. It replaces the older warm Paper palette, Instrument Serif headings,
hidden phone navigation, recorded-answer hero, and sticky-footer guidance.
Historical implementations remain in Git history. Product priorities and
navigation belong in [PRODUCT.md](PRODUCT.md); runtime architecture belongs in
[docs/design.md](docs/design.md).

## Sources and shared assets

The authoritative roles come from
[palette-system.css](site/vendor/hraness-appearance/palette-system.css), joined
to product variables by
[palette-bridge.css](site/vendor/hraness-appearance/palette-bridge.css).
[style.css](site/style.css) owns the common layout and controls;
[home.css](site/home.css) and [launch-article.css](site/launch-article.css) own
surface-specific layouts. The frontmatter records representative desktop
values; the responsive CSS remains authoritative.

The root retains `data-hraness-theme="paper"` as the shared typography contract,
with `data-palette="tokyo-night"` selecting colors. It also declares
`data-hraness-material="lantern"`, `data-hraness-pattern="none"`, and the
`editorial` marketing preset. The attribute named Paper does not select the
warm Paper palette. Pages do not require a mesh or grain background.

Paper, marketing, Lantern, and appearance are pinned to design-kit v0.23.0,
commit `3df4c411c7f5e5cbc02448463571696f0d47cee5`. The normal-flow footer release
is recorded in [its provenance](site/vendor/hraness-site-footer/provenance.json).
Directory-local provenance manifests bind the admitted assets to source and
hashes. Preserve those manifests, licenses, and font notices.
Regenerate shared assets through the repository scripts;
keep product layout changes outside immutable snapshots.

The shared cookie note is a compact corner control and checks regional policy.
Analytics starts after acceptance where required; an unavailable policy keeps
collection off until a choice is made. Pages share one consent choice.

## Color and typography

Keep palette roles paired across light and dark appearance. Links, primary
buttons, selected demo controls, and matched-result bars use the blue primary
role. Muted text supplies secondary hierarchy; grid and line roles separate
sections and controls. Terminal colors inherit surface, foreground, muted,
and primary roles from the marketing preset.

Nebula Sans Book 400, Medium 500, and Semibold 600 are served locally from
[fonts.css](site/vendor/nebula-sans/fonts.css), using `font-display: swap`.
The Book cut is preloaded. Code uses the platform monospace stack. No runtime
font CDN or Instrument Serif stylesheet is required.

Common heading rules request weight 550 and balanced wrapping. The homepage
has a compact headline beside a command/output illustration; the article uses a
larger `clamp(3rem, 6.5vw, 5.75rem)` title. Reference pages use a smaller type
scale. The body follows the browser's root size instead of setting a fixed
pixel size. Ordinary introductions stay within 65ch; article prose stays
within 67ch with a 1.78 line height.
Prose links use dotted underlines; navigation and buttons keep their own states.

## Layout and navigation

Common sections have a 70rem maximum measure and two-rem side gutters; the
header uses 76rem. Sections use five-rem vertical padding, reduced to 3.5rem
at 800px, with 1.25rem side gutters. The launch article uses 68rem and has its
own prose, figure, and table measures. Related controls wrap naturally.

The header is sticky and the footer remains in ordinary document flow. Below
720px, navigation moves into its own horizontally scrollable row under the
brand and actions. Preserve visible access to primary links and 44px phone
targets. Do not hide primary navigation to make a header fit. Anchor offsets
account for the taller mobile header, and the skip link sits above it.

The homepage hero, film feature, evidence summary, and API demonstration stack
below 760px. The article's four-step review diagram becomes
two columns below 680px and one column below 440px. Its verification row
stacks, and trial bars move below their labels on narrow phones. Wide data
tables scroll inside labelled, keyboard-focusable containers; they must not
make the whole page overflow.

## Components and diagrams

Primary buttons use primary and primary-foreground colors; secondary buttons
use a structural border. Controls have modest radii and a visible focus
outline. Ordinary sections remain flat, with rules defining groups. The
hero demonstration has a bounded surface and border. Avoid adding terminal
shadows or enclosing every paragraph in a card.

The homepage demo provides three authored question forms, selected with
ordinary buttons and `aria-pressed`. Its polite live region announces the
answer excerpt. It labels the example as illustrative and makes no model
calls. Preserve the initial choice example when JavaScript is unavailable.
Do not label authored numbers as measured model output.

Workflow diagrams keep evidence selection, a chosen backend, response
validation, and the application's action distinct. The launch article illustrates three workflows and links to the underlying
studies. Keep model-assisted findings clearly advisory and authored examples
labelled as illustrations.

Installation and API examples use code frames. Most code wraps; `.code-frame`
blocks preserve lines with local horizontal scrolling. Copy controls report
success through a status region and provide a manual-copy instruction on
failure. Use native `details` and `summary` for disclosures.

## Appearance, identity, and accessibility

The pinned shared appearance controller owns Light, Dark, and System choices,
keyboard menu navigation, focus return, storage updates, and theme-color
synchronization. It preserves the `sys1-appearance` preference and resolves it
before styles load. Without JavaScript, the palette follows the operating
system. Do not replace it with a product-local theme controller.

Use the original boxed-one SVG at [site/marks/sys1.svg](site/marks/sys1.svg)
within the accessible Sys1 home link. The shared foil wrapper provides the
brand treatment; keep footer marks under their own stylesheet ownership.
[brand/README.md](brand/README.md) records icon generation and provenance.

Core reading, links, installation commands, static diagrams, and native
disclosures work without JavaScript. Reduced motion disables smooth scrolling
and demo-control transitions. Forced colors preserve meaningful borders,
focus, selected controls, and chart distinctions. Do not put essential
information only in an image or color.

The launch film is user-started, with native controls, a poster, captions,
and a text transcript. It uses `preload="none"` and does not autoplay.
The article remains complete without playback. Film source and render
receipts live in [media/sys1-launch](media/sys1-launch).

The released footer exposes Hraness attribution and social links, with no
mailing-list form. Its shared consent initializer activates the compact corner
control. Keep the footer's normal-flow placement and the flex page's short-viewport
behavior; no fixed bar or compensating spacer is needed.

## Verification and maintenance

Check desktop and phone layouts in both appearances, including navigation,
all three demo forms, no-JavaScript reading, reduced motion, focus, and media
controls. Inspect screenshots as well as automated results. Test tables and
long code at narrow widths without page overflow. Check numerical claims against their linked study whenever copy changes.

The repository browser verifier owns the route/viewport/theme sweep; launch
source review and rendered findings are recorded in
[docs/launch-editorial.md](docs/launch-editorial.md). Do not reuse a historical
ship verdict as evidence for a new design change.
