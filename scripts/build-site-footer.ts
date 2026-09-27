import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { adaptStaticFooter } from "../site/vendor/hraness-site-footer/adapt-static-footer.mjs";

const commit = "4244dc563daf125eadbc66fe2a896311f09afc84";
const root = resolve(import.meta.dir, "..");
const vendor = join(root, "site/vendor/hraness-site-footer");
const repository = process.argv[2];
if (!repository) throw new Error("Usage: bun scripts/build-site-footer.ts /path/to/site-footer-git-checkout");
const source = (path: string) => execFileSync("git", ["-C", resolve(repository), "show", `${commit}:${path}`], { maxBuffer: 2 * 1024 * 1024 });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const renderer = source("dist/index.js");
const directory = await mkdtemp(join(tmpdir(), "sys1-footer-"));
try {
  const file = join(directory, "renderer.mjs");
  await writeFile(file, renderer);
  const { renderHranessSiteFooter } = await import(pathToFileURL(file).href);
  const options = { mailingList: { kind: "none" } };
  const html = adaptStaticFooter(renderHranessSiteFooter(options));
  const files: Record<string, { path: string; sha256: string; bytes: number }> = {};
  for (const name of ["stylex.css", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const path = name === "stylex.css" ? "dist/stylex.css" : name;
    const bytes = source(path);
    await writeFile(join(vendor, name), bytes);
    files[name] = { path, sha256: hash(bytes), bytes: bytes.length };
  }
  for await (const relative of new Bun.Glob("**/*.html").scan(join(root, "site"))) {
    const path = join(root, "site", relative);
    const before = await readFile(path, "utf8");
    const pattern = /<footer\b[^>]*class="hraness-site-footer[^>]*>[\s\S]*?<\/footer>/g;
    if ([...before.matchAll(pattern)].length !== 1) throw new Error(`Expected one footer: ${relative}`);
    await writeFile(path, before.replace(pattern, html));
  }
  const adapter = await readFile(join(vendor, "adapt-static-footer.mjs"));
  await writeFile(join(vendor, "provenance.json"), JSON.stringify({
    schemaVersion: 1,
    source: { repository: "https://github.com/hraness/site-footer", commit, version: "0.20.0" },
    files,
    renderer: { path: "dist/index.js", sha256: hash(renderer), options,
      output: { sha256: hash(html), bytes: Buffer.byteLength(html) },
      adapter: { path: "adapt-static-footer.mjs", sha256: hash(adapter), removes: '[data-slot="hraness-cookie-consent"]', reason: "No consent runtime is configured on the static site; omit its inactive action and copy." },
    },
  }, null, 2) + "\n");
  console.log("Footer refreshed from immutable 0.20.0 with normal document flow.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
