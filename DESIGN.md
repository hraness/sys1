---
name: "Sys1 — Hraness Paper"
description: "The implemented Sys1 visual system: warm Paper surfaces, editorial serif headings, and restrained developer tools."
colors:
  primary: "light-dark(#1e5ae1, #8fb0ff)"
  primary-soft: "light-dark(#dee5f3, #21232c)"
  focus: "light-dark(#1e5ae1, #8fb0ff)"
  background: "light-dark(#f8f7f4, #12100f)"
  foreground: "light-dark(#1c1917, #f5f2ed)"
  muted: "light-dark(#6c665f, #aaa29a)"
  grid: "light-dark(#dfdcd6, #302b27)"
  line: "light-dark(#b9b3ab, #514a44)"
  surface: "light-dark(#fffefa, #1d1a18)"
  surface-hover: "light-dark(#ebe8e3, #292522)"
  action: "light-dark(#28343e, #eceee6)"
  action-ink: "light-dark(#fffefa, #20211f)"
  action-hover: "light-dark(#3a4c5c, #d6dace)"
  terminal-background: "light-dark(#f3f2ee, #20211f)"
  terminal-ink: "light-dark(#262923, #e8eae5)"
  terminal-muted: "light-dark(#596052, #bfc6b6)"
  terminal-command: "light-dark(#36543d, #c4d9b9)"
typography:
  display:
    fontFamily: '"Instrument Serif", Georgia, serif'
    fontSize: "clamp(2.75rem, 5.1vw, 4rem)"
    fontWeight: 400
    lineHeight: 1.06
    letterSpacing: "-.025em"
  headline:
    fontFamily: '"Instrument Serif", Georgia, serif'
    fontSize: "clamp(2.4rem, 4vw, 3.25rem)"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "-.02em"
  title:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  summary:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.1rem"
    fontWeight: 400
    lineHeight: 1.6
  action:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: ".95rem"
    fontWeight: 500
    lineHeight: 1.4
  label:
    fontFamily: '"Nebula Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: ".8rem"
    fontWeight: 400
    lineHeight: 1.65
  code:
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace'
    fontSize: ".75rem"
    fontWeight: 400
    lineHeight: 1.85
rounded:
  compact: ".375rem"
  control: ".5rem"
  frame: ".875rem"
spacing:
  compact: ".5rem"
  related: ".75rem"
  standard: "1rem"
  inset-mobile: "1.25rem"
  inset: "1.5rem"
  gutter: "2rem"
  group: "2.75rem"
  section-mobile: "3.75rem"
  section: "5rem"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: ".6rem 1.2rem"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: ".6rem 1.2rem"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
  appearance-select:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: ".55rem .45rem"
  option-chip:
    textColor: "{colors.terminal-ink}"
    rounded: "{rounded.compact}"
    padding: ".2rem .6rem"
  request-path:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.frame}"
    padding: "1.8rem 2rem"
  terminal-frame:
    backgroundColor: "{colors.terminal-background}"
    textColor: "{colors.terminal-ink}"
    rounded: "{rounded.frame}"
  copy-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.compact}"
    padding: ".4rem .65rem"
---

# Design System: Sys1

## Overview

**Creative North Star: "Hraness Paper, as used by Peopleblade"**

Sys1 adopts the user-selected Hraness visual family through its actual shared
Paper palette and editorial marketing preset. Warm paper, quiet dividing rules,
regular serif headings, and plain sans-serif controls establish a calm reading
surface. Code and request/answer specimens give developer content a distinct,
legible material without turning every section into a card.

This file records the implemented visual system on 2026-09-19. Its source of
truth is `site/style.css` together with the pinned CSS and fonts under
`site/vendor/`. `docs/DESIGN.md` remains the separate runtime architecture
document. Page strategy and audience order belong in `PRODUCT.md` and
`.impeccable/surfaces/site-index-html.md`.

**Key Characteristics:**

- Warm, paired light and dark Paper colors.
- Instrument Serif headings with Nebula Sans reading and interface text.
- Generous section spacing, quiet rules, and compact controls.
- Muted terminal surfaces with restrained depth for the illustrative specimen.
- Locally served, pinned shared assets and the Hraness attribution footer.

The adoption sources are recorded in [`site/vendor/README.md`](site/vendor/README.md)
and its directory-local provenance manifests. Paper, the marketing preset, and
Nebula Sans come from
[`hraness/design-kit` at `0e089bc`](https://github.com/hraness/design-kit/tree/0e089bc18f9a0409f0e74b1fb7192f468956e386);
Paper and marketing were adopted via
[`hraness/peopleblade` at `900f5bf`](https://github.com/hraness/peopleblade/tree/900f5bfd922d603403c780e8431d76fb1ee7677f).
The footer is
[`hraness/site-footer` v0.15.0 at `3f29aaa`](https://github.com/hraness/site-footer/tree/3f29aaa1116205b86a0a65d779120532aeb2cc5d).
The manifests, licenses, font notices, and documented static-footer adapter
remain part of every adoption or update.

## Colors

Paper combines warm neutrals with a clear blue link/focus accent; specimen
surfaces add muted green text. The frontmatter preserves the source
`light-dark(light, dark)` expressions rather than selecting a single theme.
The sidecar's generated tonal ramps preview each light-branch hue; they are
swatch aids, not additional colors used by the site.

### Primary

- **Paper blue** (`primary`): links and the emphasized routing step.
- **Soft paper blue** (`primary-soft`): selection background.
- **Focus blue** (`focus`): the visible keyboard outline.

### Neutral

- **Warm paper and ink** (`background`, `foreground`): the document and main text.
- **Muted ink** (`muted`): summaries, supporting prose, navigation, and captions.
- **Quiet and structural rules** (`grid`, `line`): section dividers and stronger control/frame borders respectively.
- **Raised paper** (`surface`, `surface-hover`): request-path fill, selected controls, copy controls, and hover feedback.
- **Slate action** (`action`, `action-ink`, `action-hover`): filled calls to action, with pale fill and dark ink in dark mode.
- **Terminal paper and ink** (`terminal-background`, `terminal-ink`, `terminal-muted`, `terminal-command`): specimens, code, and install commands.

**The Paired Appearance Rule.** Keep every shared Paper color paired across
light and dark appearances; inherit the selected color scheme instead of
introducing a fixed-color island.

The root opts in with `data-hraness-theme="paper"`, `data-palette="paper"`, and
`data-hraness-marketing-preset="editorial"`. Without `data-theme`, it follows
the operating system. The appearance control selects System, Light, or Dark;
explicit choices are restored from `sys1-appearance` before styles load.
Storage failures leave the current visit usable. System color changes also
update the browser theme-color metadata. Forced-colors mode maps the Paper
roles to system colors and adds visible specimen/button borders.

## Typography

**Display font:** Instrument Serif, with Georgia and serif fallbacks.
**Body and UI font:** Nebula Sans, followed by the platform sans-serif stack.
**Code font:** the platform monospace stack.

Display and headline roles use the regular serif face. Titles and controls
use the loaded Medium and Semibold sans-serif cuts; body text uses Book.
The frontmatter contains the implemented ramp, tracking, and line heights.
Headline wrapping is balanced. The body inherits the browser's default size
with a one-rem reference size; it does not impose a fixed root pixel size.

Supporting text varies by density: section introductions use 1.0625rem,
navigation uses .9rem, and specimen labels/captions use .75rem. Code is
slightly larger in the specimen (.76rem) and install block (.78rem) than the
reusable integration-code role. The compact screen summary becomes 1rem.
Prose introductions stay within 65ch; wider containers accommodate code and
comparisons rather than long reading lines.

**The Real Font Rule.** Serve the pinned local font files: Instrument Serif
regular 400 and Nebula Sans 400, 500, and 600. Keep editorial serif headings
at 400 instead of synthesizing bold.

Fonts use `font-display: swap`, and the Nebula Book WOFF2 is preloaded. There
is no runtime font CDN. Retain the included SIL Open Font Licenses and font
provenance when moving or updating these assets.

## Layout

The content measure is 70rem; the header has a wider 76rem measure. Both
leave two-rem side gutters on larger screens. Sections have five-rem block
padding and end with a quiet rule. Text introductions are narrower than the
content measure. Related controls wrap within flex rows instead of relying
on fixed viewport widths.

Desktop patterns include a three-column benefits group, two-column
request/answer specimen, an .85fr/1.4fr integration split, a 1fr/1.25fr/2fr
comparison, and a 1fr/1.65fr question section. Their internal gaps range from
1.5rem to 4rem. The specimen, install block, and copy columns retain their own
bounded measures inside the larger section.

At 800px and below, gutters become 1.25rem and section padding becomes
3.75rem. Integration and questions stack; the integration modes temporarily
form three columns. The header hides its first navigation link.

At 560px and below, navigation links are hidden while the brand, start action,
and appearance control remain. Benefits, integration modes, comparison rows,
and the request/answer specimen stack. Request-path arrows rotate with the
vertical flow, the comparison header is hidden, and the example controls
grow to a 2.75rem minimum height. Code wraps with `white-space: pre-wrap` and
`overflow-wrap: anywhere`; it does not require horizontal page scrolling.

The header stays in normal document flow. Anchor scrolling is smooth with a
six-rem offset, reduced to 1.5rem on compact screens. Reduced-motion preference
changes scrolling to `auto`.

## Elevation & Depth

Most surfaces are flat, separated by tonal fills and thin rules. The wide
illustrative specimen alone uses the shared terminal shadow, combining a
subtle inset highlight with soft ambient shadows. Other code/install frames
use a border. Terminal toolbars use the shared light/dark chrome gradient.
The sidecar records the exact shadow in its extensions and chrome in its
component snippets.

**The Specimen Depth Rule.** Reserve the terminal shadow for the featured
request/answer specimen; use borders and tonal separation for ordinary
containers.

The hero uses a flat warm surface in both themes. The vendored marketing
grain, cells, and field gradient remain available upstream assets, but the
current page does not apply the marketing-field class. Do not describe those
textures as visible Sys1 decoration or infer a textured-background requirement.

## Shapes

Use the frontmatter's compact radius for option labels and copy controls,
control radius for buttons and the appearance select, and frame radius for
specimens, code, and the request path. Standard rules and control borders are
one pixel. Corners stay modest; editorial sections remain unboxed.

Interface arrows and disclosures are inline SVGs with current-color strokes,
rounded line ends and joins, and a 1.6 stroke width. Standard icons are 1.2rem;
external-link arrows are .9rem. The disclosure switches from plus to minus by
hiding the vertical path when its native details element opens. Preserve the
shared footer's own SVG paths and styling.

## Components

### Buttons and links

Filled actions use slate/pale paired colors; secondary actions are transparent
with a structural border. Both use the action typography and control radius.
The standard minimum height is 2.875rem, with 2.625rem compact header actions.
Hover changes background over 140ms ease-out without moving the control.
Keyboard focus is a two-pixel focus-color outline offset by four pixels.
Links retain a one-pixel underline treatment with a .2em offset; navigation
and button links receive their component-specific hover treatment.

### Appearance select and navigation

Use a native select with an accessible Appearance label, Paper background,
muted ink, a structural border, and a 2.625rem minimum height. The header's
links remain a simple horizontal row until the responsive rules reduce them.
Keep the skip-to-content link available on keyboard focus.

### Option labels and example selector

Option labels are noninteractive monospace chips with a thin border. The
example selector is a labelled group of ordinary buttons, using
`aria-pressed` for the active choice. The selected state has a Paper surface
and structural border; hover uses the shared hover surface. Selecting a type
updates the question, state, option labels, JSON answer, and type label. The
answer region announces the change politely. These are labelled illustrative
examples held in the page script, with no model call.

### Frames, request path, and code

Frame surfaces share terminal colors, rounded clipping, and a chrome heading
strip. Code uses the monospace stack and preserves intentional line breaks
while allowing wrapping. The request-path container is a flat Paper surface
with a quiet border; routing emphasis uses the primary blue. Preserve the
desktop-to-stacked flow and arrow orientation.

### Copy feedback and disclosure

Copy controls use the compact radius and hover surface. Copying reports a
success message in a status region; clipboard failure gives a manual-copy
instruction. Native `details`/`summary` supplies the disclosure behavior and
keyboard interaction. Its focus outline remains visible.

### Shared footer and progressive enhancement

The pinned shared footer provides Hraness attribution and social links in
normal flow. Use its generated markup with the documented static adapter;
there is no mailing-list form, active consent widget, or external script.
Do not restyle the vendored snapshot to make a product-local adjustment.

Appearance, example switching, and copy buttons are revealed only when
JavaScript is available. The initial illustrative answer, installation text,
links, and native disclosures remain useful without JavaScript. Sidecar
snippets show the implemented visual states; they do not supply application
event handlers for these behaviors.

### Model comparison

`site/compare.html` extends the Paper reading surface with captioned data
tables, contextual evidence rows, native disclosures, and a small cost
calculator. Wide tables scroll within labelled keyboard-focusable regions;
supporting grids stack on compact screens. Numeric columns use tabular figures.
The comparison stylesheet reuses the existing colors, fonts, radii, and
breakpoints, adding local layout and density rules without new system tokens
or assets. The shared header, appearance control, and pinned footer remain
the visual anchors. Surface-specific evidence and interaction rules live in
`.impeccable/surfaces/site-compare-html.md`.

## Agent skills guide

`site/skills.html` extends the same Paper system in a reading layout, using
`site/skills.css` for the shipped workflow, scoped evidence comparison,
research catalog, and installation. A description list explains before/after
behavior. The evidence table keeps result-text replay and completed-diagnosis
units separate, within a labelled keyboard-scrollable region. Ten unboxed
research rows expose their status, proposed payoff, native alternative, and
current evidence gap; they stack at compact widths. Native disclosures keep
calculation and failure-cost detail below the primary decision path. The
shared header, appearance control, copy behavior, code frames, fonts, and
pinned footer are reused. No system tokens or assets were added. Evidence
boundaries, source revision, editorial ownership, and finish review live in
`.impeccable/surfaces/site-skills-html.md`.

## Do's and Don'ts

### Do:

- **Do** inherit the paired Paper palette and test both appearances.
- **Do** use the actual local fonts and regular Instrument Serif headings.
- **Do** keep readable measures, quiet section rules, and wrapping code.
- **Do** preserve native control semantics, visible keyboard focus, and status feedback.
- **Do** retain pinned shared assets, source hashes, licenses, and the footer adapter provenance.

### Don't:

- **Don't** turn unused vendor textures or tokens into a requirement for new surfaces.
- **Don't** apply the specimen shadow to every section or frame.
- **Don't** replace the shared footer's marks with text glyphs or product-local approximations.
- **Don't** make JavaScript essential for reading the example, installation commands, or disclosures.
- **Don't** edit immutable vendor snapshots for a product-local layout or copy change.
