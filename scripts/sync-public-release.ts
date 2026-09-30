import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Current release identity and guides. Historical reports and changelog entries
// retain their original version and evidence identity.
const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length !== 1 || !["--check", "--write"].includes(args[0]!)) {
  throw new Error("Usage: bun scripts/sync-public-release.ts --check|--write");
}
const manifest: unknown = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (typeof manifest !== "object" || manifest === null || !("version" in manifest)
  || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
  throw new Error("Expected a stable package.json version");
}
const version = manifest.version;
const files = ["src/gateway.ts", "README.md", "site/index.html", "site/docs.html", "site/llms.txt", "scripts/build-site-platforms.ts", "site/introducing-sys1.html", "kb/launch/social-kit.md", "site-templates/index.html", "site-templates/docs.html", "site-templates/introducing-sys1.html"];
const stale: string[] = [];
for (const file of files) {
  const path = resolve(root, file);
  const source = await readFile(path, "utf8");
  const updated = source
    .replace(/(export const SYS1_VERSION = ")\d+\.\d+\.\d+(")/gu, `$1${version}$2`)
    .replace(/https:\/\/github\.com\/hraness\/sys1\/releases\/download\/v\d+\.\d+\.\d+\/hraness-sys1-\d+\.\d+\.\d+\.tgz/gu,
      `https://github.com/hraness/sys1/releases/download/v${version}/hraness-sys1-${version}.tgz`)
    .replace(/Latest release: v\d+\.\d+\.\d+/gu, `Latest release: v${version}`)
    .replace(/(<p class="hero-note">)v\d+\.\d+\.\d+/gu, `$1v${version}`)
    .replace(/(<span>Sys1 )\d+\.\d+\.\d+(<\/span>)/gu, `$1${version}$2`)
    .replace(/("softwareVersion"\s*:\s*")\d+\.\d+\.\d+(")/gu, `$1${version}$2`);
  if (updated === source) continue;
  stale.push(file);
  if (args[0] === "--write") await writeFile(path, updated);
}
if (stale.length > 0 && args[0] === "--check") {
  console.error(`Public release references are stale: ${stale.join(", ")}. Run bun run release:sync.`);
  process.exitCode = 1;
} else {
  console.log(`Public release references match v${version}${stale.length > 0 ? ` (${stale.length} files updated)` : ""}.`);
}
