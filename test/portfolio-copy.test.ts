import { expect, test } from "bun:test";
import { renderPortfolioCopy } from "../scripts/portfolio-copy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("comparison distinguishes the active Clef route from historical Jev measurements", () => {
  const html = readFileSync(resolve(root, "site-templates/compare.html"), "utf8");
  const routes = /<section id="routes"[\s\S]*?<\/section>/.exec(html)?.[0];
  expect(routes).toContain("<dt>Cloudflare Clef");
  expect(routes).not.toContain("<dt>Jev");
  expect(html).toContain('data-accuracy="74.0909090909091"');
  expect(html).toContain('data-key="jev-1.13.0"');
  const cost = /<section id="cost"[\s\S]*?<\/section>/.exec(html)?.[0];
  expect(cost).toMatch(/September 2026/);
  expect(readFileSync(resolve(root, "site/compare.js"), "utf8")).not.toMatch(/Jev bills/);
});

test("a hosted product page uses its own description and preserves page-specific titles", () => {
  const site = { canonicalUrl: "https://example.test", messaging: { names: { name: "Host" }, meta: "Host description." } };
  const snapshot = {
    canonicalUrl: "https://example.test/skills",
    messaging: {
      names: { name: "Skills" }, category: "Tools", tagline: "Run checks.", short: "Checks.",
      meta: 'Skills save "full logs" & protect <script> text.',
      hero: { heading: "Run checks once.", summary: "Read the result." }, headings: {},
    },
  };
  const records = [
    { "@type": "WebPage", url: snapshot.canonicalUrl, name: "Agent skills · Host" },
    { "@type": "WebSite", url: site.canonicalUrl, name: "Old host", description: "Old host description." },
    { "@type": "WebPage", url: "https://example.test/docs", name: "Docs", description: "Page-specific docs." },
  ];
  const html = `<meta name="description" content="{{PORTFOLIO_META}}"><script type="application/ld+json">${JSON.stringify(records)}</script>`;
  const output = renderPortfolioCopy(html, snapshot, site.messaging.names.name, undefined, site);
  const json = output.match(/<script type="application\/ld\+json">([\s\S]+)<\/script>/u)?.[1];
  expect(json).toBeDefined();
  expect(JSON.parse(json!)).toEqual([
    { ...records[0], description: snapshot.messaging.meta },
    { ...records[1], name: site.messaging.names.name, description: site.messaging.meta },
    records[2],
  ]);
  expect(json).not.toContain("<script>");
  expect(output).toContain("Skills save &quot;full logs&quot; &amp; protect &lt;script&gt; text.");
});
