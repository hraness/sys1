import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const vendor = "site/vendor/hraness-appearance";
const upstreamFiles = {
  "appearance-menu.css": "src/appearance-menu.css",
  "palette-bridge.css": "src/palette-bridge.css",
  "palette-system.css": "src/palette-system.css",
  LICENSE: "LICENSE",
} as const;
const entry = "scripts/site-appearance.js";
const bundle = "site/appearance.js";
const browser = "dist/browser/index.js";
const manifestFile = `${vendor}/provenance.json`;
const ownedFiles = [entry, bundle, ...Object.keys(upstreamFiles).map((name) => `${vendor}/${name}`), manifestFile];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const receipt = (path: string, bytes: Uint8Array) => ({ path, sha256: digest(bytes), bytes: bytes.length });
const bytes = (path: string) => readFile(path);
type Receipt = ReturnType<typeof receipt>;
interface Manifest {
  schemaVersion: 2;
  source: { repository: string; commit: string; release: string };
  files: Record<keyof typeof upstreamFiles, Receipt>;
  browser: Receipt;
  entry: typeof entry;
  bootstrap: Receipt;
  bundle: Receipt & { bunVersion: string };
  dependencyLock: Receipt;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join() === [...keys].sort().join();
}
function checkedReceipt(value: unknown, path: string, extraKeys: string[] = []): asserts value is Receipt {
  if (!object(value) || value.path !== path || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.bytes)
    || (value.bytes as number) < 1 || !onlyKeys(value, ["path", "sha256", "bytes", ...extraKeys])) throw new Error(`Invalid appearance receipt: ${path}`);
}
function parseManifest(value: unknown): Manifest {
  if (!object(value) || !onlyKeys(value, ["schemaVersion", "source", "files", "browser", "entry", "bootstrap", "bundle", "dependencyLock"])
    || value.schemaVersion !== 2 || !object(value.source) || !onlyKeys(value.source, ["repository", "commit", "release"])
    || value.source.repository !== "https://github.com/hraness/design-kit"
    || typeof value.source.commit !== "string" || !/^[a-f0-9]{40}$/u.test(value.source.commit)
    || typeof value.source.release !== "string" || !/^v\d+\.\d+\.\d+$/u.test(value.source.release)
    || !object(value.files) || Object.keys(value.files).sort().join() !== Object.keys(upstreamFiles).sort().join()
    || value.entry !== entry) throw new Error("Invalid appearance manifest; refresh from the immutable release first");
  for (const [name, path] of Object.entries(upstreamFiles)) checkedReceipt(value.files[name], path);
  checkedReceipt(value.browser, browser);
  checkedReceipt(value.bootstrap, entry);
  const bunVersion = object(value.bundle) ? value.bundle.bunVersion : undefined;
  checkedReceipt(value.bundle, bundle, ["bunVersion"]);
  checkedReceipt(value.dependencyLock, "bun.lock");
  if (bunVersion !== "1.3.14") throw new Error("Unsupported appearance build toolchain");
  return value as unknown as Manifest;
}
function assertBytes(value: Uint8Array, expected: Receipt): void {
  if (value.length !== expected.bytes || digest(value) !== expected.sha256) throw new Error(`Appearance integrity mismatch: ${expected.path}`);
}
function git(repository: string, argv: string[]): Buffer {
  return execFileSync("git", ["-C", repository, ...argv], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
}
async function build(rootPath: string, sourcePath: string): Promise<Uint8Array> {
  if (Bun.version !== "1.3.14") throw new Error("Use Bun 1.3.14 for the appearance bundle");
  const result = await Bun.build({
    entrypoints: [resolve(rootPath, entry)], target: "browser", format: "iife", minify: true,
    plugins: [{ name: "pinned-appearance", setup(build) {
      build.onResolve({ filter: /^@hraness\/design-kit\/browser$/ }, () => ({ path: sourcePath }));
    } }],
  });
  if (!result.success || result.outputs.length !== 1) throw new Error(`Appearance build failed: ${result.logs.join("\n")}`);
  return new Uint8Array(await result.outputs[0]!.arrayBuffer());
}

/** Bind the physical output tree once, then reject redirection before every read/write. */
async function ownedTree(rootPath: string, create: boolean) {
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Appearance root must be a physical directory");
  const canonicalRoot = await realpath(rootPath);
  const identity = (stat: { dev: number | bigint; ino: number | bigint }) => `${stat.dev}:${stat.ino}`;
  const directories = new Map<string, string>([[canonicalRoot, identity(rootStat)]]);
  async function revalidate(): Promise<void> {
    for (const [path, expected] of directories) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected || await realpath(path) !== path) {
        throw new Error(`Appearance directory identity changed: ${path}`);
      }
    }
  }
  for (const name of ["scripts", "site", "site/vendor", vendor]) {
    await revalidate();
    const path = resolve(canonicalRoot, name);
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if (!object(error) || error.code !== "ENOENT" || !create || name === "scripts") throw error;
      await mkdir(path); // Never follow a recursive mkdir through an unverified ancestor.
      stat = await lstat(path);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error(`Appearance ancestor must be a physical directory: ${name}`);
    directories.set(path, identity(stat));
  }
  async function regular(name: string, required: boolean) {
    if (!ownedFiles.includes(name)) throw new Error(`Unowned appearance path: ${name}`);
    await revalidate();
    try {
      const stat = await lstat(resolve(canonicalRoot, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Appearance path must be a regular file: ${name}`);
      return stat;
    } catch (error) {
      if (!required && object(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  // Reject every redirected output before the first publication, preserving the old receipt.
  for (const name of ownedFiles) await regular(name, !create || name === entry);
  return {
    root: canonicalRoot,
    async read(name: string): Promise<Buffer> {
      const before = await regular(name, true);
      const handle = await open(resolve(canonicalRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || before === undefined || identity(opened) !== identity(before)) throw new Error(`Appearance file identity changed: ${name}`);
        const content = await handle.readFile();
        await revalidate();
        return content;
      } finally { await handle.close(); }
    },
    async publish(name: string, content: Uint8Array | string): Promise<void> {
      await regular(name, false);
      const path = resolve(canonicalRoot, name);
      const staged = `${path}.next-${crypto.randomUUID()}`;
      await writeFile(staged, content, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW });
      // Recheck the original directory identities and the destination, including the receipt.
      await regular(name, false);
      await rename(staged, path);
      await revalidate();
    },
  };
}

/** CSS and browser authority come from one immutable Git object, never copied local edits. */
export async function refreshAppearance(rootPath: string, repository: string, commit: string, release: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^v\d+\.\d+\.\d+$/u.test(release)) throw new Error("Supply a full commit and stable release tag");
  if (git(repository, ["rev-parse", "--verify", `refs/tags/${release}^{commit}`]).toString().trim() !== commit) throw new Error("Release tag does not identify the supplied commit");
  const tree = await ownedTree(rootPath, true);
  const readGit = (path: string) => git(repository, ["show", "--no-textconv", `${commit}:${path}`]);
  const artifacts = Object.fromEntries(Object.entries(upstreamFiles).map(([name, path]) => [name, readGit(path)])) as Record<keyof typeof upstreamFiles, Buffer>;
  const source = readGit(browser);
  const lock = readGit("bun.lock");
  const sourcePath = resolve(repository, browser);
  // The bundler resolves external peers beside this artifact. Require its checkout
  // bytes and lock to match the immutable source; install those peers frozen first.
  assertBytes(await bytes(sourcePath), receipt(browser, source));
  assertBytes(await bytes(resolve(repository, "bun.lock")), receipt("bun.lock", lock));
  const bootstrap = await tree.read(entry);
  const output = await build(tree.root, sourcePath);
  // Reject input changes during compilation before publishing any output.
  assertBytes(await bytes(sourcePath), receipt(browser, source));
  assertBytes(await bytes(resolve(repository, "bun.lock")), receipt("bun.lock", lock));
  assertBytes(await tree.read(entry), receipt(entry, bootstrap));
  const manifest: Manifest = {
    schemaVersion: 2, source: { repository: "https://github.com/hraness/design-kit", commit, release },
    files: Object.fromEntries(Object.entries(upstreamFiles).map(([name, path]) => [name, receipt(path, artifacts[name as keyof typeof upstreamFiles])])) as Manifest["files"],
    browser: receipt(browser, source), entry, bootstrap: receipt(entry, bootstrap),
    bundle: { ...receipt(bundle, output), bunVersion: Bun.version }, dependencyLock: receipt("bun.lock", lock),
  };
  for (const name of Object.keys(upstreamFiles) as (keyof typeof upstreamFiles)[]) await tree.publish(`${vendor}/${name}`, artifacts[name]);
  await tree.publish(bundle, output);
  // Publish the receipt last: partial writes cannot pass the integrity check.
  await tree.publish(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await checkAppearance(tree.root);
}

export async function checkAppearance(rootPath: string): Promise<void> {
  const tree = await ownedTree(rootPath, false);
  const manifest = parseManifest(JSON.parse((await tree.read(manifestFile)).toString()));
  for (const name of Object.keys(upstreamFiles) as (keyof typeof upstreamFiles)[]) assertBytes(await tree.read(`${vendor}/${name}`), manifest.files[name]);
  assertBytes(await tree.read(entry), manifest.bootstrap);
  assertBytes(await tree.read(bundle), manifest.bundle);
}

/** Preserve the existing digest-checked bundle-only command for the recorded source. */
export async function rebuildAppearance(rootPath: string, sourcePath: string): Promise<void> {
  const tree = await ownedTree(rootPath, true);
  const manifest: unknown = JSON.parse((await tree.read(manifestFile)).toString());
  if (!object(manifest)) throw new Error("Invalid appearance manifest");
  checkedReceipt(manifest.browser, browser);
  const source = await bytes(sourcePath);
  assertBytes(source, manifest.browser);
  let dependencyLock: Receipt | undefined;
  if (manifest.schemaVersion === 2) {
    const parsed = parseManifest(manifest);
    for (const name of Object.keys(upstreamFiles) as (keyof typeof upstreamFiles)[]) assertBytes(await tree.read(`${vendor}/${name}`), parsed.files[name]);
    dependencyLock = parsed.dependencyLock;
    assertBytes(await bytes(resolve(sourcePath, "../../..", "bun.lock")), dependencyLock);
  }
  else if (manifest.schemaVersion !== 1) throw new Error("Unsupported appearance manifest");
  const bootstrap = await tree.read(entry);
  const output = await build(tree.root, sourcePath);
  assertBytes(await bytes(sourcePath), receipt(browser, source));
  if (dependencyLock) assertBytes(await bytes(resolve(sourcePath, "../../..", "bun.lock")), dependencyLock);
  assertBytes(await tree.read(entry), receipt(entry, bootstrap));
  manifest.bundle = { ...receipt(bundle, output), bunVersion: Bun.version };
  if (manifest.schemaVersion === 2) manifest.bootstrap = receipt(entry, bootstrap);
  await tree.publish(bundle, output);
  await tree.publish(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  const [operation, repository, commit, release, ...extra] = process.argv.slice(2);
  if (operation === "--refresh" && repository && commit && release && extra.length === 0) await refreshAppearance(root, resolve(repository), commit, release);
  else if (operation === "--check" && repository === undefined) await checkAppearance(root);
  else if (operation && !operation.startsWith("--") && repository === undefined) await rebuildAppearance(root, resolve(operation));
  else throw new Error("Usage: bun scripts/build-site-appearance.ts --refresh KIT_CHECKOUT FULL_COMMIT vVERSION | --check | PINNED_BROWSER_ARTIFACT");
  console.log(operation === "--refresh" || operation === "--check" ? "Shared appearance assets verified" : "Shared appearance bundle rebuilt from the pinned digest");
}
