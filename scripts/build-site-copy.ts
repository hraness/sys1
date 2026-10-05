import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import primary from "../portfolio-messaging.generated.json";
import skills from "../portfolio-system-one-skills.generated.json";
import { renderPortfolioCopy } from "./portfolio-copy";
import { checkGuideLinks, renderGuideMarkers } from "./site-docs";
import { socialPageAlt, socialPages } from "./social-cards";

const root = resolve(import.meta.dir, "..");
const check = process.argv.includes("--check");
// Vercel publishes these checked files directly, so every page's shared brand
// identity is rendered and freshness-checked before publication.
const pages = [...socialPages.map(page => page.file.slice("site/".length)), "404.html"];
await checkGuideLinks(root);
for (const name of pages) {
  const snapshot = name === "skills.html" ? skills : primary;
  const card = socialPages.find(page => page.file === `site/${name}`);
  const template = await renderGuideMarkers(await readFile(resolve(root, "site-templates", name), "utf8"), root);
  const generated = renderPortfolioCopy(template, snapshot, primary.messaging.names.name, card === undefined ? undefined : socialPageAlt(card), primary);
  const target = resolve(root, "site", name);
  if (check) {
    if (await readFile(target, "utf8") !== generated) throw new Error(`Stale marketing page ${name}; run bun run build:site-copy.`);
  } else await writeFile(target, generated);
}
console.log(check ? "Canonical website copy is current." : "Generated canonical website copy.");
