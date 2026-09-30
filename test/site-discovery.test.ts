import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { socialImageFit, socialImageSiteDetails } from "@hraness/web-discovery/social-image/card";
import { checkSocialCards, socialPageAlt, socialPageCopy, socialPages, socialSite } from "../scripts/social-cards.ts";

const site = new URL("../site/", import.meta.url);
const origin = "https://sys1.io";
const read = (path: string) => readFileSync(new URL(path, site), "utf8");
const fileFor = (path: string) => (path === "/" ? "index.html" : `${path.slice(1)}.html`);
const escapeRegExp = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const meta = (html: string, attribute: "name" | "property", key: string) =>
  html.match(new RegExp(`<meta ${attribute}="${escapeRegExp(key)}" content="([^"]*)"`))?.[1];

const sitemap = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
const paths = sitemap.map((loc) => {
  const url = new URL(loc);
  expect(url.origin).toBe(origin);
  return url.pathname;
});
const vercel = JSON.parse(read("../vercel.json")) as { redirects?: { source: string; destination: string; permanent: boolean }[] };

test("every sitemap URL is an indexable page whose canonical, og:url, and titles agree", () => {
  expect(new Set(sitemap).size).toBe(sitemap.length);
  for (const [index, path] of paths.entries()) {
    const html = read(fileFor(path));
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    expect(html).toContain(`<link rel="canonical" href="${sitemap[index]}" />`);
    expect(meta(html, "property", "og:url")).toBe(sitemap[index]);
    expect(meta(html, "property", "og:title")).toBe(title);
    expect(meta(html, "name", "twitter:title")).toBe(title);
    expect(meta(html, "property", "og:description")).toBe(meta(html, "name", "description"));
    expect(meta(html, "name", "twitter:description")).toBe(meta(html, "name", "description"));
    expect(html).not.toMatch(/<meta name="robots" content="[^"]*noindex/);
  }
});

test("every indexable page uses its shared-template social card", () => {
  expect(socialPages.map(page => page.url).sort()).toEqual([...sitemap].sort());
  expect(socialSite.name).toBe("Sys1");
  expect(socialSite.domain).toBe("sys1.io");
  expect(socialSite.icon?.kind).toBe("mark");
  expect(socialSite.icon?.src).toBe(`data:image/svg+xml;base64,${readFileSync(new URL("marks/sys1.svg", site)).toString("base64")}`);
  for (const page of socialPages) {
    const html = read(page.file.replace(/^site\//, ""));
    const card = new URL(page.image, origin).href;
    const png = readFileSync(new URL(page.image.slice(1), site));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect([...html.matchAll(/<meta property="og:image" /g)]).toHaveLength(1);
    expect([...html.matchAll(/<meta name="twitter:image" /g)]).toHaveLength(1);
    expect(meta(html, "property", "og:image")).toBe(card);
    expect(meta(html, "property", "og:image:type")).toBe("image/png");
    expect(meta(html, "property", "og:image:width")).toBe("1200");
    expect(meta(html, "property", "og:image:height")).toBe("630");
    expect(meta(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "name", "twitter:image")).toBe(card);
    expect(meta(html, "property", "og:site_name")).toBe("Sys1");
    const alt = socialPageAlt(page).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    expect(meta(html, "property", "og:image:alt")).toBe(alt);
    expect(meta(html, "name", "twitter:image:alt")).toBe(alt);
  }
});

test("every social card's copy fits the template as written", () => {
  for (const page of socialPages) {
    const copy = socialPageCopy(page);
    const details = socialImageSiteDetails(socialSite, copy);
    const fit = socialImageFit(details);
    // Not strict: this also fails on the review findings (a reduced
    // description, a missing or repeated eyebrow, a repeated tagline).
    expect({ page: page.url, findings: fit.findings }).toEqual({ page: page.url, findings: [] });
    // Every page card draws the eyebrow it declares or derives from its path.
    expect({ page: page.url, eyebrow: fit.eyebrow }).toEqual({ page: page.url, eyebrow: details.eyebrow });
    if (page.copy !== null) expect({ page: page.url, eyebrow: fit.eyebrow ?? "" }).not.toEqual({ page: page.url, eyebrow: "" });
    // Page cards carry their own summary, never the home tagline.
    if (page.copy !== null) expect(copy.description).not.toBe(socialSite.description);
  }
});

test("social cards match their recorded template render", async () => {
  await checkSocialCards();
});

test("structured data parses and entity references resolve across the site", () => {
  const objects: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value === null || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    objects.push(object);
    Object.values(object).forEach(walk);
  };
  for (const path of paths) {
    const blocks = [...read(fileFor(path)).matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, block] of blocks) walk(JSON.parse(block!));
  }
  const definitions = new Set(objects.filter(object => typeof object["@type"] === "string").map(object => object["@id"]).filter((id): id is string => typeof id === "string"));
  for (const id of [`${origin}/#website`, `${origin}/#software`, "https://hraness.com/#organization", `${origin}/introducing-sys1#article`, `${origin}/#launch-film`, `${origin}/introducing-sys1#launch-film`]) expect(definitions.has(id)).toBe(true);
  for (const object of objects) {
    if (typeof object["@id"] !== "string") continue;
    const id = object["@id"];
    expect(new URL(id).protocol).toBe("https:");
    expect(definitions.has(id)).toBe(true);
  }
});

test("redirected paths have no page, stay out of the sitemap, and land on a sitemap URL", () => {
  for (const redirect of vercel.redirects ?? []) {
    expect(redirect.permanent).toBe(true);
    expect(existsSync(new URL(fileFor(redirect.source), site))).toBe(false);
    expect(paths).not.toContain(redirect.source);
    expect(paths).toContain(redirect.destination);
  }
});

test("the IndexNow key file serves exactly its own key", () => {
  const keys = readdirSync(site).filter((name) => /^[0-9a-f]{32}\.txt$/.test(name));
  expect(keys).toHaveLength(1);
  expect(read(keys[0]!)).toBe(keys[0]!.slice(0, 32));
});
