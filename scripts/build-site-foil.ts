import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Supply src/product-marketing.css from the pinned checkout. The shared foil
// contract is one contiguous section inside the union stylesheet; Sys1 extracts
// exactly that section so the static site keeps its light preset stack without
// inheriting unrelated marketing grammar. The slice is byte-exact upstream CSS.
const root = resolve(import.meta.dir, "..");
const manifestPath = resolve(root, "site/vendor/hraness-foil/provenance.json");
const manifest = await Bun.file(manifestPath).json();
const artifactPath = process.argv[2];
if (!artifactPath) throw new Error("Usage: bun scripts/build-site-foil.ts <pinned-product-marketing-css>");
const sourcePath = resolve(artifactPath);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
if (hash(source) !== manifest.sourceFile.sha256) {
  throw new Error("Shared product-marketing stylesheet does not match the pinned digest");
}

const text = await readFile(sourcePath, "utf8");
const start = text.indexOf("/* Shared foil contract");
const end = text.indexOf("/* Hero */");
if (start === -1 || end === -1 || end <= start) {
  throw new Error("Pinned product-marketing foil section boundaries changed");
}
const extracted = text.slice(start, end);
const required = [
  ".hraness-foil,",
  ".hraness-foil-text,",
  ".hraness-foil-mark {",
  ".hraness-foil-mark__image",
  ".hraness-foil-mark__paint",
  "@supports (mask-image: linear-gradient(black, black))",
  "@media (forced-colors: active)",
  "@media (hover: hover)",
  "@media (prefers-color-scheme: dark)",
];
for (const marker of required) {
  if (!extracted.includes(marker)) {
    throw new Error(`Extracted foil section is missing ${marker}`);
  }
}

const output = `${extracted.trimEnd()}\n`;
const outputDir = resolve(root, "site/vendor/hraness-foil");
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "foil.css"), output);
const digest = hash(new TextEncoder().encode(output));
if (manifest.foil.sha256 !== digest) {
  throw new Error(`Extracted foil.css digest ${digest} does not match the manifest ${manifest.foil.sha256}`);
}
console.log(`hraness-foil: extracted ${output.length} bytes, sha256 ${digest}`);
