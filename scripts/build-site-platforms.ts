import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codeText } from "./build-site-syntax.ts";

// The install blocks on the home page and docs draw the same platform marks
// as design-kit's PlatformInstall. The marks and labels come from one tagged
// design-kit release (src/platforms.ts, read from Git objects at the tag);
// --refresh vendors that module and renders the blocks between markers, and
// --check (run by the tests) re-renders them from the vendored module. The
// shared syntax step highlights the commands afterwards, so the check compares
// each command's text rather than its highlight spans.
const root = resolve(import.meta.dir, "..");
const vendor = "site/vendor/hraness-platforms";
const manifestFile = `${vendor}/provenance.json`;
const upstreamFiles = {
  "platforms.ts": "src/platforms.ts",
  LICENSE: "LICENSE",
  "marks-LICENSE": "vendor/platform-marks/LICENSE",
  "UPSTREAM.md": "vendor/platform-marks/UPSTREAM.md",
} as const;
type UpstreamName = keyof typeof upstreamFiles;

type PlatformId = "macos" | "linux" | "windows";
interface Target { id: PlatformId; command?: string; shell: string; note?: string; unavailableNote?: string }
interface Block { page: string; prefix: string; badges: readonly (PlatformId | { id: PlatformId; note: string })[]; targets: readonly Target[] }

const releaseUrl = "https://github.com/hraness/sys1/releases/download/v0.19.0/hraness-sys1-0.19.0.tgz";
/** One line so it pastes into PowerShell as well as a POSIX shell. */
export const installCommand = `npm install --global --allow-scripts=node-llama-cpp ${releaseUrl}`;
const note = "Requires Bun 1.3.14+";
// The release workflow installs this exact package on ubuntu-24.04, macos-15,
// and windows-2025 before publishing, so all three are native targets.
const targets: readonly Target[] = [
  { id: "macos", command: installCommand, shell: "Terminal", note },
  { id: "linux", command: installCommand, shell: "Terminal", note },
  { id: "windows", command: installCommand, shell: "PowerShell", note },
];
export const SYS1_PLATFORM_BLOCKS: readonly Block[] = [
  { page: "site/index.html", prefix: "install", badges: ["macos", "linux", "windows"], targets },
  { page: "site/docs.html", prefix: "docs-install", badges: ["macos", "linux", "windows"], targets },
];

const START = "<!-- hraness-platform-install:start -->";
const END = "<!-- hraness-platform-install:end -->";

interface PlatformsModule {
  platformMark(id: string): { path: string; viewBox: string };
  platformLabel(id: string): string;
}

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const receipt = (path: string, bytes: Uint8Array | string) => ({ path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) });
type Receipt = ReturnType<typeof receipt>;
interface Manifest {
  schemaVersion: 1;
  source: { repository: string; commit: string; release: string };
  files: Record<UpstreamName, Receipt>;
}

const escapeHtml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

// Like design-kit's PlatformInstall (v0.30.2), each mark is defined once per
// block as an id-scoped <symbol> and drawn by reference, so the badges, tabs,
// and no-script panel names do not repeat the full paths (Tux is several KB).
const markId = (prefix: string, id: PlatformId) => `${prefix}-mark-${id}`;

function markSymbols(platforms: PlatformsModule, prefix: string, ids: readonly PlatformId[]): string {
  const symbols = [...new Set(ids)].map((id) => {
    const mark = platforms.platformMark(id);
    return `<symbol id="${markId(prefix, id)}" viewBox="${mark.viewBox}"><path d="${mark.path}"/></symbol>`;
  }).join("");
  return `<svg class="platform-marks" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`;
}

function icon(platforms: PlatformsModule, prefix: string, id: PlatformId): string {
  return `<svg class="platform-icon" aria-hidden="true" focusable="false" viewBox="${platforms.platformMark(id).viewBox}" fill="currentColor"><use href="#${markId(prefix, id)}"/></svg>`;
}

/** Static markup for one "Runs on" row and one tabbed install block. */
export function renderBlock(platforms: PlatformsModule, block: Block): string {
  const p = block.prefix;
  const ids = [...block.badges.map((entry) => typeof entry === "string" ? entry : entry.id), ...block.targets.map((target) => target.id)];
  const badges = block.badges.map((entry) => {
    const { id, note: badgeNote } = typeof entry === "string" ? { id: entry, note: undefined } : entry;
    return `<li>${icon(platforms, p, id)}<span>${escapeHtml(platforms.platformLabel(id))}</span>${badgeNote === undefined ? "" : `<span class="platform-badge-note">${escapeHtml(badgeNote)}</span>`}</li>`;
  }).join("");
  const tabs = block.targets.map((target, index) => {
    const label = escapeHtml(platforms.platformLabel(target.id));
    return `<button type="button" role="tab" id="${p}-tab-${target.id}" aria-controls="${p}-panel-${target.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-platform="${target.id}">${icon(platforms, p, target.id)}<span class="platform-tab-label">${label}</span></button>`;
  }).join("\n");
  const panels = block.targets.map((target) => {
    const label = platforms.platformLabel(target.id);
    const command = target.command === undefined ? "" : `
<div class="code-frame">
<div class="code-heading"><span>${escapeHtml(target.shell)}</span><button type="button" class="copy-button js-only" data-copy="${p}-command-${target.id}" data-copy-status="${p}-status" data-copy-subject="${escapeHtml(label)} install command">Copy</button></div>
<pre class="platform-pre" tabindex="0"><code id="${p}-command-${target.id}" class="syntax-code language-shell" data-language="shell">${escapeHtml(target.command)}</code></pre>
</div>`;
    const unavailable = target.unavailableNote === undefined ? "" : `\n<p class="platform-unavailable">${escapeHtml(target.unavailableNote)}</p>`;
    const qualifier = target.note === undefined ? "" : `\n<p class="platform-note">${escapeHtml(target.note)}</p>`;
    return `<div class="platform-panel" role="tabpanel" id="${p}-panel-${target.id}" aria-labelledby="${p}-tab-${target.id}" data-platform="${target.id}">
<p class="platform-panel-name">${icon(platforms, p, target.id)}<span>${escapeHtml(label)}</span></p>${unavailable}${command}${qualifier}
</div>`;
  }).join("\n");
  return `
${markSymbols(platforms, p, ids)}
<div class="platform-badges"><span class="platform-badges-label" aria-hidden="true">Runs on</span><ul aria-label="Runs on">${badges}</ul></div>
<div class="platform-install" data-platform-install>
<div class="platform-tabs js-only" role="tablist" aria-label="Platform">
${tabs}
</div>
${panels}
<p id="${p}-status" class="copy-status" role="status"></p>
</div>
`;
}

function region(html: string, page: string): string {
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start < 0 || end < start || html.indexOf(START, start + 1) >= 0) throw new Error(`${page} needs exactly one platform install marker pair`);
  return html.slice(start + START.length, end);
}

/** Replace highlighted command markup with its escaped text, so highlighting does not count as drift. */
function withPlainCode(markup: string): string {
  return markup.replace(/(<code\b[^>]*>)([\s\S]*?)(<\/code>)/gu, (_, open: string, body: string, close: string) => `${open}${escapeHtml(codeText(body))}${close}`);
}

function assertBytes(value: Uint8Array | string, expected: Receipt): void {
  if (Buffer.byteLength(value) !== expected.bytes || digest(value) !== expected.sha256) throw new Error(`Platform install integrity mismatch: ${expected.path}`);
}

async function loadPlatforms(rootPath: string): Promise<PlatformsModule> {
  return await import(pathToFileURL(resolve(rootPath, vendor, "platforms.ts")).href) as PlatformsModule;
}

export async function refreshPlatforms(repository: string, commit: string, release: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^v\d+\.\d+\.\d+$/u.test(release)) throw new Error("Supply a full commit and stable release tag");
  const git = (argv: string[]) => execFileSync("git", ["-C", repository, ...argv], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  if (git(["rev-parse", "--verify", `refs/tags/${release}^{commit}`]).toString().trim() !== commit) throw new Error("Release tag does not identify the supplied commit");
  const files = Object.fromEntries(Object.entries(upstreamFiles).map(([name, path]) => [name, git(["show", "--no-textconv", `${commit}:${path}`])])) as Record<UpstreamName, Buffer>;
  await mkdir(resolve(root, vendor), { recursive: true });
  for (const name of Object.keys(upstreamFiles) as UpstreamName[]) await writeFile(resolve(root, vendor, name), files[name]);
  const manifest: Manifest = {
    schemaVersion: 1,
    source: { repository: "https://github.com/hraness/design-kit", commit, release },
    files: Object.fromEntries(Object.entries(upstreamFiles).map(([name, path]) => [name, receipt(path, files[name as UpstreamName])])) as Manifest["files"],
  };
  await writeFile(resolve(root, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  const platforms = await loadPlatforms(root);
  for (const block of SYS1_PLATFORM_BLOCKS) {
    const path = resolve(root, block.page);
    const html = await readFile(path, "utf8");
    const current = region(html, block.page);
    await writeFile(path, html.replace(`${START}${current}${END}`, () => `${START}${renderBlock(platforms, block)}${END}`));
  }
}

export async function checkPlatforms(rootPath: string = root): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(rootPath, manifestFile), "utf8")) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.source?.repository !== "https://github.com/hraness/design-kit"
    || !/^[a-f0-9]{40}$/u.test(manifest.source.commit) || !/^v\d+\.\d+\.\d+$/u.test(manifest.source.release)
    || Object.keys(manifest.files ?? {}).sort().join() !== Object.keys(upstreamFiles).sort().join()) {
    throw new Error("Invalid platform install manifest; refresh from the immutable release first");
  }
  for (const name of Object.keys(upstreamFiles) as UpstreamName[]) assertBytes(await readFile(resolve(rootPath, vendor, name)), manifest.files[name]);
  const platforms = await loadPlatforms(rootPath);
  for (const block of SYS1_PLATFORM_BLOCKS) {
    const html = await readFile(join(rootPath, block.page), "utf8");
    if (withPlainCode(region(html, block.page)) !== renderBlock(platforms, block)) throw new Error(`Platform install integrity mismatch: ${block.page}`);
  }
}

if (import.meta.main) {
  const [operation, repository, commit, release, ...extra] = process.argv.slice(2);
  if (operation === "--refresh" && repository && commit && release && extra.length === 0) await refreshPlatforms(resolve(repository), commit, release);
  else if (operation === "--check" && repository === undefined) await checkPlatforms(root);
  else throw new Error("Usage: bun scripts/build-site-platforms.ts --refresh KIT_CHECKOUT FULL_COMMIT vVERSION | --check");
  console.log("Shared platform install blocks verified");
}
