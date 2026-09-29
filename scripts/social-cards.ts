import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createSocialImageCard,
  defineSocialImageSite,
  socialImageAlt,
  socialImageSiteDetails,
  type SocialImagePage,
} from "@hraness/web-discovery/social-image/card";

// Every sys1.io share image comes from the shared @hraness/web-discovery card
// template, driven by this one site declaration. Pages add copy only; this
// repository draws no card of its own.
const root = resolve(import.meta.dir, "..");
const origin = "https://sys1.io";
const manifestPath = "brand/social-cards.json";

// The browser and home-screen icon (brand:generate) is the finished app icon.
const appIcon = readFileSync(resolve(root, "site/icon.png"));

export const socialSite = defineSocialImageSite({
  name: "Sys1",
  domain: "sys1.io",
  description: "Stop spending big-model tokens on small decisions.",
  icon: { kind: "app", src: `data:image/png;base64,${appIcon.toString("base64")}` },
  // Light-mode Tokyo Night tokens from DESIGN.md.
  theme: { accent: "#1d4e90", background: "#e1e2e7", foreground: "#1c3161", muted: "#414c76" },
});

type SocialPage = Readonly<{
  file: string;
  url: string;
  image: `/${string}.png`;
  /** Card copy for the page, or null for the home page's site card. */
  copy: SocialImagePage | null;
}>;

export const socialPages: readonly SocialPage[] = [
  { file: "site/index.html", url: `${origin}/`, image: "/og.png", copy: null },
  { file: "site/introducing-sys1.html", url: `${origin}/introducing-sys1`, image: "/og/introducing-sys1.png", copy: { eyebrow: "Launch", headline: "Introducing Sys1", description: "Sys1 hands your agent’s small yes-or-no calls to Jev, a fast model." } },
  { file: "site/docs.html", url: `${origin}/docs`, image: "/og/docs.png", copy: { eyebrow: "Docs", headline: "Sys1 documentation", description: "Install the skills, configure a backend, and make your first request." } },
  { file: "site/docs/evaluations.html", url: `${origin}/docs/evaluations`, image: "/og/docs-evaluations.png", copy: { eyebrow: "Docs", headline: "Sys1 evaluations", description: "Our own tests of Jev, local Qwen, and Laya, wrong answers included." } },
  { file: "site/docs/evaluations-history.html", url: `${origin}/docs/evaluations-history`, image: "/og/docs-evaluations-history.png", copy: { eyebrow: "Evaluation history", headline: "The original form-action comparison", description: "Sys1’s first tests: 20 form-action questions across five models." } },
  { file: "site/compare.html", url: `${origin}/compare`, image: "/og/compare.png", copy: { eyebrow: "Compare", headline: "Compare the models Sys1 can use", description: "JevBench scores, where each model runs, and what your workload costs." } },
  { file: "site/skills.html", url: `${origin}/skills`, image: "/og/skills.png", copy: { eyebrow: "Skills", headline: "Skills for reviewing agent work", description: "Code review, completion checks, and compact test output for your agent." } },
];

const escape = (text: string): string => text
  .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** The card copy for one page: the site card for the home page, else page copy. */
export function socialPageCopy(page: SocialPage): SocialImagePage {
  return page.copy ?? {};
}

export function socialPageAlt(page: SocialPage): string {
  return socialImageAlt(socialSite, socialPageCopy(page));
}

function templateVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(root, "node_modules/@hraness/web-discovery/package.json"), "utf8")) as { version: string };
  return manifest.version;
}

/** A stable fingerprint of everything the template receives for one card. */
function inputDigest(page: SocialPage): string {
  return sha256(JSON.stringify({ template: templateVersion(), details: socialImageSiteDetails(socialSite, socialPageCopy(page)) }));
}

/** Replace every og:image / twitter:image tag with the page's template card. */
export function projectSocialMeta(html: string, page: SocialPage): string {
  const alt = escape(socialPageAlt(page));
  const image = new URL(page.image, origin).href;
  const stripped = html.replace(/^[ \t]*<meta (?:property="og:image(?::[^"]+)?"|name="twitter:image(?::[^"]+)?")[^>]*>\r?\n/gmu, "");
  const og = [
    `    <meta property="og:image" content="${image}" />`,
    `    <meta property="og:image:type" content="image/png" />`,
    `    <meta property="og:image:width" content="1200" />`,
    `    <meta property="og:image:height" content="630" />`,
    `    <meta property="og:image:alt" content="${alt}" />`,
  ].join("\n");
  const twitter = [
    `    <meta name="twitter:image" content="${image}" />`,
    `    <meta name="twitter:image:alt" content="${alt}" />`,
  ].join("\n");
  const ogAnchor = /^[ \t]*<meta property="og:url"[^>]*>\r?\n/mu;
  const twitterAnchor = /^[ \t]*<meta name="twitter:description"[^>]*>\r?\n/mu;
  assert.ok(ogAnchor.test(stripped) && twitterAnchor.test(stripped), `${page.file}: missing og:url or twitter:description`);
  return stripped
    .replace(ogAnchor, match => `${match}${og}\n`)
    .replace(twitterAnchor, match => `${match}${twitter}\n`);
}

type Manifest = {
  version: 1;
  template: string;
  cards: { page: string; path: string; input: string; bytes: number; sha256: string }[];
};

async function render(): Promise<void> {
  const [{ default: satori }, { Resvg }] = await Promise.all([import("satori"), import("@resvg/resvg-js")]);
  const cards: Manifest["cards"] = [];
  for (const page of socialPages) {
    const file = resolve(root, page.file);
    const html = await readFile(file, "utf8");
    const card = createSocialImageCard(socialImageSiteDetails(socialSite, socialPageCopy(page)));
    const svg = await satori(card.element, {
      fonts: card.fonts.map(font => ({ data: font.data, name: font.name, style: font.style, weight: font.weight })),
      height: card.height,
      width: card.width,
    });
    const png = new Resvg(svg).render().asPng();
    const path = `site${page.image}`;
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), png);
    await writeFile(file, projectSocialMeta(html, page));
    cards.push({ page: page.url, path, input: inputDigest(page), bytes: png.byteLength, sha256: sha256(png) });
  }
  const manifest: Manifest = { version: 1, template: templateVersion(), cards };
  await writeFile(resolve(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Read-only check: page meta points at the template card, the committed PNG
 * matches the recorded render, and the card inputs have not changed since.
 * Rasters are not re-rendered here, so the check does not depend on
 * identical PNG bytes across platforms.
 */
export async function checkSocialCards(): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), "utf8")) as Manifest;
  assert.equal(manifest.template, templateVersion(), "Social cards were rendered with another template version; run bun run social:generate");
  assert.deepEqual(manifest.cards.map(card => card.page), socialPages.map(page => page.url), "Unexpected social card list");
  for (const [index, page] of socialPages.entries()) {
    const record = manifest.cards[index]!;
    const html = await readFile(resolve(root, page.file), "utf8");
    assert.equal(html, projectSocialMeta(html, page), `${page.file}: social meta is stale; run bun run social:generate`);
    assert.equal(record.input, inputDigest(page), `${page.file}: card copy changed; run bun run social:generate`);
    assert.equal(record.path, `site${page.image}`);
    const png = await readFile(resolve(root, record.path));
    assert.equal(png.byteLength, record.bytes, `${record.path}: size changed`);
    assert.equal(sha256(png), record.sha256, `${record.path}: hash changed`);
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG", `${record.path}: not a PNG`);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], `${record.path}: not 1200x630`);
  }
}

if (import.meta.main) {
  const [mode, ...extra] = process.argv.slice(2);
  if ((mode !== "--write" && mode !== "--check") || extra.length > 0) throw new Error("Usage: bun scripts/social-cards.ts --write|--check");
  if (mode === "--write") await render();
  await checkSocialCards();
  console.log(`Verified ${socialPages.length} Sys1 social cards from the shared template.`);
}
