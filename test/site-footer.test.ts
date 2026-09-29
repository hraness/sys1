import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

test("the metallic footer mask preserves the shared silhouette under the same-origin image policy", async () => {
  const [html, css, mask, provenanceText, configText] = await Promise.all([
    read("site/index.html"), read("site/style.css"), read("site/vendor/hraness-site-footer/mark.svg"),
    read("site/vendor/hraness-site-footer/provenance.json"), read("vercel.json"),
  ]);
  const inline = html.match(/<svg\b(?=[^>]*\bclass="hraness-site-footer__mark(?:\s|"))[^>]*>([\s\S]*?)<\/svg>/);
  expect(inline).not.toBeNull();
  expect(mask).toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${inline![1]}</svg>\n`);
  expect(JSON.parse(provenanceText).mask.sha256).toBe(createHash("sha256").update(mask).digest("hex"));
  expect(css).toContain('.hraness-site-footer__mark-paint { mask-image: url("/vendor/hraness-site-footer/mark.svg"); }');
  const policy = JSON.parse(configText).headers.flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers)
    .find((header: { key: string }) => header.key === "Content-Security-Policy").value;
  expect(policy.match(/(?:^|;\s*)img-src ([^;]+)/)?.[1]).toBe("'self'");
});
