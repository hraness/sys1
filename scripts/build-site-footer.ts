import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dir, "..");
const vendor = join(root, "site/vendor/hraness-site-footer");
const repository = process.argv[2];
if (!repository) throw new Error("Usage: bun scripts/build-site-footer.ts /path/to/site-footer-git-checkout");
const specification = JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies["@hraness/site-footer"] as string;
const artifactVersion = /^https:\/\/github\.com\/hraness\/site-footer\/releases\/download\/v(\d+\.\d+\.\d+)\/hraness-site-footer-\1\.tgz$/u.exec(specification)?.[1];
const release = artifactVersion ? `v${artifactVersion}` : /^github:hraness\/site-footer#(v\d+\.\d+\.\d+)$/u.exec(specification)?.[1];
if (!release) throw new Error("Footer dependency must pin an immutable release tag");
const commit = execFileSync("git", ["-C", resolve(repository), "rev-parse", `${release}^{commit}`], { encoding: "utf8" }).trim();
const source = (path: string) => execFileSync("git", ["-C", resolve(repository), "show", `${commit}:${path}`], { maxBuffer: 2 * 1024 * 1024 });
const version = JSON.parse(source("package.json").toString()).version as string;
if (`v${version}` !== release) throw new Error("Footer tag and package version disagree");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const renderer = source("dist/index.js");
const directory = await mkdtemp(join(tmpdir(), "sys1-footer-"));
try {
  const file = join(directory, "renderer.mjs");
  await writeFile(file, renderer);
  const { renderHranessSiteFooter } = await import(pathToFileURL(file).href);
  const options = { mailingList: { kind: "none" } };
  const html = renderHranessSiteFooter(options);
  const mark = html.match(/<svg\b(?=[^>]*\bclass="hraness-site-footer__mark(?:\s|"))[^>]*>([\s\S]*?)<\/svg>/);
  if (!mark) throw new Error("Shared footer lost its canonical inline mark");
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark[1]}</svg>\n`;
  await writeFile(join(vendor, "mark.svg"), mask);
  const files: Record<string, { path: string; sha256: string; bytes: number }> = {};
  for (const name of ["stylex.css", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const path = name === "stylex.css" ? "dist/stylex.css" : name;
    const bytes = source(path);
    await writeFile(join(vendor, name), bytes);
    files[name] = { path, sha256: hash(bytes), bytes: bytes.length };
  }
  for await (const relative of new Bun.Glob("**/*.html").scan(join(root, "site-templates"))) {
    const path = join(root, "site-templates", relative);
    const before = await readFile(path, "utf8");
    const pattern = /<footer\b[^>]*class="hraness-site-footer[^>]*>[\s\S]*?<\/footer>/g;
    if ([...before.matchAll(pattern)].length !== 1) throw new Error(`Expected one footer: ${relative}`);
    await writeFile(path, before.replace(pattern, html));
  }
  execFileSync(process.execPath, ["scripts/build-site-copy.ts"], { cwd: root, stdio: "inherit" });
  await writeFile(join(vendor, "provenance.json"), JSON.stringify({
    schemaVersion: 1,
    source: { repository: "https://github.com/hraness/site-footer", commit, version },
    files,
    mask: { path: "mark.svg", sha256: hash(mask), bytes: Buffer.byteLength(mask), source: "renderer inline mark", reason: "Same-origin mask preserves the site's image CSP." },
    renderer: { path: "dist/index.js", sha256: hash(renderer), options,
      output: { sha256: hash(html), bytes: Buffer.byteLength(html) },
    },
  }, null, 2) + "\n");
  console.log(`Footer refreshed from immutable ${release} with shared regional consent.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
