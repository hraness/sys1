import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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

test("every indexable page shares the committed 1200x630 social card", () => {
  const png = readFileSync(new URL("og.png", site));
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  for (const path of paths) {
    const html = read(fileFor(path));
    expect(meta(html, "property", "og:image")).toBe(`${origin}/og.png`);
    expect(meta(html, "property", "og:image:width")).toBe("1200");
    expect(meta(html, "property", "og:image:height")).toBe("630");
    expect(meta(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "name", "twitter:image")).toBe(`${origin}/og.png`);
    expect(meta(html, "property", "og:site_name")).toBe("Sys1");
  }
});

test("structured data parses and every WebSite reference resolves to the home graph", () => {
  const home = JSON.parse(read("index.html").match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!);
  const nodes = home["@graph"] as { "@id": string; "@type": string }[];
  const ids = new Set(nodes.map((node) => node["@id"]));
  expect(ids.has(`${origin}/#website`)).toBe(true);
  expect(ids.has("https://hraness.com/#organization")).toBe(true);
  for (const path of paths) {
    const html = read(fileFor(path));
    for (const [, block] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const references = [...JSON.stringify(JSON.parse(block!)).matchAll(/"@id":"([^"]+)"/g)].map((match) => match[1]!);
      for (const id of references) expect(new URL(id).origin === origin ? ids.has(id) || id === `${origin}${path === "/" ? "/" : path}` : id === "https://hraness.com/#organization").toBe(true);
    }
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
