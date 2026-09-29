import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Like the appearance/status snapshots, syntax is rendered from an immutable
// design-kit release. The website serves only HTML and the shared stylesheet.
const root = resolve(import.meta.dir, "..");
const vendor = "site/vendor/hraness-syntax";
const manifestPath = `${vendor}/provenance.json`;
const stylesheetPath = `${vendor}/syntax-highlighting.css`;
const stylesheetLink = '<link rel="stylesheet" href="/vendor/hraness-syntax/syntax-highlighting.css" />';
const entry = "dist/syntax-highlighting.js";
const generator = "scripts/build-site-syntax.ts";
type Language = "shell" | "typescript" | "json";
export const pageLanguages: Record<string, readonly Language[]> = {
  "site/index.html": ["typescript", "shell", "shell", "shell", "shell"],
  "site/docs.html": ["shell", "shell", "shell", "shell", "shell", "shell", "json", "shell", "shell", "shell", "shell", "shell", "json", "typescript"],
  "site/skills.html": ["shell", "shell", "shell", "shell"],
  "site/introducing-sys1.html": ["shell"],
};
type Highlighter = (code: string, language: Language, options: { styles: "classes" }) => { className: string; language: string; html: string };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const receipt = (path: string, bytes: Uint8Array | string) => ({ path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) });
type Receipt = ReturnType<typeof receipt>;
interface BlockReceipt { language: Language; codeSha256: string; markup: Receipt }
interface Manifest {
  schemaVersion: 1;
  source: { repository: string; commit: string; release: string };
  modules: Receipt[];
  dependency: { name: "sugar-high"; version: string; lock: Receipt; files: Receipt[] };
  generator: Receipt;
  stylesheet: Receipt;
  license: Receipt;
  pages: Record<string, BlockReceipt[]>;
}

function codeBlocks(html: string) {
  return [...html.matchAll(/<pre\b([^>]*)><code\b([^>]*)>([\s\S]*?)<\/code><\/pre>/gu)];
}

/** Decode one layer only: literal entity-looking source must survive copying. */
export function codeText(markup: string): string {
  const escaped = markup.replace(/<span\b[^>]*>|<\/span>/gu, "");
  if (/[<>]/u.test(escaped)) throw new Error("Code blocks may contain only escaped code and highlighter spans");
  return escaped.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/gu, (entity) => {
    switch (entity) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;": case "&#39;": case "&#x27;": return "'";
      default: return entity;
    }
  });
}

export function renderCodeBlocks(html: string, languages: readonly Language[], highlightCode: Highlighter): string {
  const blocks = codeBlocks(html);
  if (blocks.length !== languages.length) throw new Error("Code block inventory changed; declare each block's language");
  let index = 0;
  return html.replace(/<pre\b([^>]*)><code\b([^>]*)>([\s\S]*?)<\/code><\/pre>/gu, (_, pre: string, code: string, source: string) => {
    const language = languages[index++]!;
    const text = codeText(source);
    const highlighted = highlightCode(text, language, { styles: "classes" });
    if (highlighted.language !== language || highlighted.className !== `syntax-code language-${language}`
      || /<[^>]*\s(?:style|on[a-z]+)=/iu.test(highlighted.html) || codeText(highlighted.html) !== text) {
      throw new Error("Shared highlighting changed the source or emitted unexpected markup");
    }
    const attributes = code.replace(/\s(?:class|data-language)="[^"]*"/gu, "");
    return `<pre${pre}${/\btabindex=/iu.test(pre) ? "" : ' tabindex="0"'}><code${attributes} class="${highlighted.className}" data-language="${language}">${highlighted.html}</code></pre>`;
  });
}

function assertBytes(bytes: Uint8Array | string, expected: Receipt): void {
  if (Buffer.byteLength(bytes) !== expected.bytes || digest(bytes) !== expected.sha256) throw new Error(`Syntax integrity mismatch: ${expected.path}`);
}

function blockReceipts(page: string, html: string): BlockReceipt[] {
  const languages = pageLanguages[page]!;
  const blocks = codeBlocks(html);
  if (blocks.length !== languages.length) throw new Error(`Code block inventory changed: ${page}`);
  return blocks.map((block, index) => ({ language: languages[index]!, codeSha256: digest(codeText(block[3]!)), markup: receipt(`${page}#code-${index + 1}`, block[0]) }));
}

export async function checkSyntax(rootPath = root): Promise<void> {
  const manifest = JSON.parse(await readFile(join(rootPath, manifestPath), "utf8")) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.source.repository !== "https://github.com/hraness/design-kit"
    || !/^[a-f0-9]{40}$/u.test(manifest.source.commit) || !/^v\d+\.\d+\.\d+$/u.test(manifest.source.release)
    || manifest.generator.path !== generator || manifest.stylesheet.path !== "src/syntax-highlighting.css"
    || manifest.license.path !== "LICENSE" || Object.keys(manifest.pages).sort().join() !== Object.keys(pageLanguages).sort().join()) throw new Error("Invalid syntax provenance");
  assertBytes(await readFile(join(rootPath, generator)), manifest.generator);
  assertBytes(await readFile(join(rootPath, stylesheetPath)), manifest.stylesheet);
  assertBytes(await readFile(join(rootPath, vendor, "LICENSE")), manifest.license);
  for (const page of Object.keys(pageLanguages)) {
    const html = await readFile(join(rootPath, page), "utf8");
    if (!html.includes(stylesheetLink)) throw new Error(`Missing syntax stylesheet: ${page}`);
    if (JSON.stringify(blockReceipts(page, html)) !== JSON.stringify(manifest.pages[page])) throw new Error(`Syntax integrity mismatch: ${page}`);
  }
}

export async function refreshSyntax(repository: string, commit: string, release: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^v\d+\.\d+\.\d+$/u.test(release)) throw new Error("Supply a full commit and stable release tag");
  const git = (args: string[]) => execFileSync("git", ["-C", repository, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (git(["rev-parse", "--verify", `refs/tags/${release}^{commit}`]).toString().trim() !== commit) throw new Error("Release tag does not identify the supplied commit");
  const readGit = (path: string) => git(["show", "--no-textconv", `${commit}:${path}`]);
  const css = readGit("src/syntax-highlighting.css");
  const license = readGit("LICENSE");
  const lock = readGit("bun.lock");
  const locked = /"sugar-high": \["sugar-high@([^"]+)"/u.exec(lock.toString())?.[1];
  const packageBytes = await readFile(join(repository, "node_modules/sugar-high/package.json"));
  if (JSON.parse(packageBytes.toString()).version !== locked || !locked) throw new Error("Install the selected design-kit release's frozen dependencies first");
  const runtime = await mkdtemp(join(tmpdir(), "sys1-shared-syntax-"));
  try {
    const modules: Receipt[] = [];
    const parser = new Bun.Transpiler({ loader: "js" });
    const seen = new Set<string>();
    const copyModule = async (path: string): Promise<void> => {
      if (seen.has(path)) return;
      seen.add(path);
      const bytes = readGit(path);
      modules.push(receipt(path, bytes));
      await mkdir(dirname(join(runtime, path)), { recursive: true });
      await writeFile(join(runtime, path), bytes);
      for (const imported of parser.scanImports(bytes)) {
        if (imported.kind !== "import-statement") throw new Error(`Unexpected highlighter import kind: ${imported.kind}`);
        const specifier = imported.path;
        if (specifier === "sugar-high") continue;
        if (!/^\.\/[A-Za-z0-9_.-]+\.js$/u.test(specifier)) throw new Error(`Unexpected highlighter import: ${specifier}`);
        await copyModule(`dist/${specifier.slice(2)}`);
      }
    };
    await copyModule(entry);
    const dependencyFiles = ["package.json", "lib/index.js"];
    const files: Receipt[] = [];
    for (const file of dependencyFiles) {
      const relative = `node_modules/sugar-high/${file}`;
      const bytes = await readFile(join(repository, relative));
      if (file.endsWith(".js") && parser.scanImports(bytes).length > 0) throw new Error("Review new highlighter dependency imports before refreshing");
      files.push(receipt(relative, bytes));
      await mkdir(dirname(join(runtime, relative)), { recursive: true });
      await writeFile(join(runtime, relative), bytes);
    }
    const { highlightCode } = await import(pathToFileURL(join(runtime, entry)).href) as { highlightCode: Highlighter };
    const pages: Record<string, BlockReceipt[]> = {};
    for (const [page, languages] of Object.entries(pageLanguages)) {
      let html = renderCodeBlocks(await readFile(join(root, page), "utf8"), languages, highlightCode);
      if (!html.includes(stylesheetLink)) html = html.replace('  <link rel="stylesheet" href="/style.css" />', `  ${stylesheetLink}\n  <link rel="stylesheet" href="/style.css" />`);
      if (!html.includes(stylesheetLink)) throw new Error(`Missing product stylesheet anchor: ${page}`);
      pages[page] = blockReceipts(page, html);
      await writeFile(join(root, page), html);
    }
    const manifest: Manifest = {
      schemaVersion: 1, source: { repository: "https://github.com/hraness/design-kit", commit, release },
      modules, dependency: { name: "sugar-high", version: locked, lock: receipt("bun.lock", lock), files },
      generator: receipt(generator, await readFile(join(root, generator))), stylesheet: receipt("src/syntax-highlighting.css", css), license: receipt("LICENSE", license), pages,
    };
    await mkdir(join(root, vendor), { recursive: true });
    await writeFile(join(root, stylesheetPath), css);
    await writeFile(join(root, vendor, "LICENSE"), license);
    await writeFile(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
    await checkSyntax(root);
  } finally { await rm(runtime, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const [operation, repository, commit, release, ...extra] = process.argv.slice(2);
  if (operation === "--refresh" && repository && commit && release && extra.length === 0) await refreshSyntax(resolve(repository), commit, release);
  else if (operation === "--check" && !repository) await checkSyntax();
  else throw new Error("Usage: bun scripts/build-site-syntax.ts --refresh KIT_CHECKOUT FULL_COMMIT vVERSION | --check");
  console.log("Shared syntax markup and stylesheet verified");
}
