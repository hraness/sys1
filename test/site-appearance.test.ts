import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppearance, rebuildAppearance, refreshAppearance } from "../scripts/build-site-appearance.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sys1-appearance-test-"));
  temporary.push(directory);
  const root = join(directory, "site-owner");
  const upstream = join(directory, "kit");
  const browser = join(upstream, "dist/browser/index.js");
  const vendor = join(root, "site/vendor/hraness-appearance");
  await Promise.all([mkdir(join(root, "scripts"), { recursive: true }), mkdir(join(root, "site"), { recursive: true }), mkdir(join(upstream, "src"), { recursive: true }), mkdir(join(upstream, "dist/browser"), { recursive: true })]);
  // Immutable artifact bytes must survive Git restore on Windows as well as Unix.
  await writeFile(join(upstream, ".gitattributes"), "* -text\n");
  await writeFile(join(root, "scripts/site-appearance.js"), 'import { install } from "@hraness/design-kit/browser"; install();\n');
  await writeFile(browser, 'export function install() { document.documentElement.dataset.ready = "yes"; }\n');
  await writeFile(join(upstream, "src/appearance-menu.css"), ".menu { display: grid; }\n");
  await writeFile(join(upstream, "src/palette-bridge.css"), '@import "./palette-system.css";\n');
  await writeFile(join(upstream, "src/palette-system.css"), '[data-palette="tokyo-night"] { --background: #e1e2e7; }\n');
  await writeFile(join(upstream, "LICENSE"), "Fixture license\n");
  await writeFile(join(upstream, "bun.lock"), '{"lockfileVersion":1}\n');
  const git = (...argv: string[]) => execFileSync("git", ["-C", upstream, ...argv], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture");
  const commit = git("rev-parse", "HEAD");
  git("tag", "v1.2.3");
  return { root, upstream, browser, vendor, commit };
}

test("refresh binds both palette files, bootstrap, browser and bundle to an immutable release", async () => {
  const f = await fixture();
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  await checkAppearance(f.root);
  const manifest = JSON.parse(await readFile(join(f.vendor, "provenance.json"), "utf8"));
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.source.commit).toBe(f.commit);
  expect(Object.keys(manifest.files).sort()).toEqual(["LICENSE", "appearance-menu.css", "palette-bridge.css", "palette-system.css"]);
  expect(await readFile(join(f.vendor, "palette-bridge.css"), "utf8")).toContain('@import "./palette-system.css"');
  expect(manifest.bootstrap.path).toBe("scripts/site-appearance.js");
  const before = await readFile(join(f.vendor, "provenance.json"), "utf8");
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  expect(await readFile(join(f.vendor, "provenance.json"), "utf8")).toBe(before);
  const legacy = JSON.parse(before);
  legacy.schemaVersion = 1;
  delete legacy.bootstrap;
  await writeFile(join(f.vendor, "provenance.json"), JSON.stringify(legacy));
  await rebuildAppearance(f.root, f.browser);
  expect(JSON.parse(await readFile(join(f.vendor, "provenance.json"), "utf8")).schemaVersion).toBe(1);
  await expect(checkAppearance(f.root)).rejects.toThrow("refresh from the immutable release");
});

test("refresh rejects mismatched release, browser or lock before publishing", async () => {
  const f = await fixture();
  const browserBytes = await readFile(f.browser);
  await expect(refreshAppearance(f.root, f.upstream, "a".repeat(40), "v1.2.3")).rejects.toThrow("Release tag");
  await writeFile(f.browser, "altered browser\n");
  await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("integrity mismatch");
  expect(await Bun.file(join(f.vendor, "provenance.json")).exists()).toBe(false);
  execFileSync("git", ["-C", f.upstream, "restore", "dist/browser/index.js"]);
  expect(await readFile(f.browser)).toEqual(browserBytes);
  await writeFile(f.browser, browserBytes.toString().replaceAll("\n", "\r\n"));
  await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("dist/browser/index.js");
  execFileSync("git", ["-C", f.upstream, "restore", "dist/browser/index.js"]);
  await writeFile(join(f.upstream, "bun.lock"), "altered lock\n");
  await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("bun.lock");
  expect(await Bun.file(join(f.vendor, "provenance.json")).exists()).toBe(false);
});

test("check rejects palette or authored-bootstrap drift; refresh uses Git CSS bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.upstream, "src/palette-system.css"), "uncommitted local CSS\n");
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  expect(await readFile(join(f.vendor, "palette-system.css"), "utf8")).not.toContain("uncommitted");
  await writeFile(join(f.vendor, "palette-system.css"), "damaged CSS\n");
  await expect(checkAppearance(f.root)).rejects.toThrow("palette-system.css");
  await expect(rebuildAppearance(f.root, f.browser)).rejects.toThrow("palette-system.css");
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  await writeFile(join(f.root, "scripts/site-appearance.js"), "document.body.dataset.changed = 'true';\n");
  await expect(checkAppearance(f.root)).rejects.toThrow("scripts/site-appearance.js");
  await rebuildAppearance(f.root, f.browser);
  await checkAppearance(f.root);
  await writeFile(f.browser, "wrong artifact\n");
  await expect(rebuildAppearance(f.root, f.browser)).rejects.toThrow("dist/browser/index.js");
});

test("check rejects an incomplete inventory, unknown receipt fields and modified output", async () => {
  const f = await fixture();
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  const path = join(f.vendor, "provenance.json");
  const original = await readFile(path, "utf8");
  const manifest = JSON.parse(original);
  delete manifest.files["palette-system.css"];
  await writeFile(path, JSON.stringify(manifest));
  await expect(checkAppearance(f.root)).rejects.toThrow("Invalid appearance manifest");
  const extra = JSON.parse(original);
  extra.browser.unchecked = true;
  await writeFile(path, JSON.stringify(extra));
  await expect(checkAppearance(f.root)).rejects.toThrow("Invalid appearance receipt");
  await writeFile(path, original);
  await writeFile(join(f.root, "site/appearance.js"), "modified bundle\n");
  await expect(checkAppearance(f.root)).rejects.toThrow("site/appearance.js");
});

test("linked output directories and ancestors cannot redirect refresh, rebuild or check", async () => {
  for (const target of ["site/vendor/hraness-appearance", "site/vendor"]) {
    const f = await fixture();
    await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
    const original = await readFile(join(f.vendor, "provenance.json"), "utf8");
    const external = join(f.upstream, "external");
    await mkdir(external);
    await writeFile(join(external, "sentinel"), "untouched\n");
    const output = join(f.root, target);
    const retained = `${output}-retained`;
    await rename(output, retained);
    await symlink(external, output, "dir");
    await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("physical directory");
    await expect(rebuildAppearance(f.root, f.browser)).rejects.toThrow("physical directory");
    await expect(checkAppearance(f.root)).rejects.toThrow("physical directory");
    expect(await readdir(external)).toEqual(["sentinel"]);
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("untouched\n");
    const oldReceipt = target.endsWith("hraness-appearance") ? join(retained, "provenance.json") : join(retained, "hraness-appearance/provenance.json");
    expect(await readFile(oldReceipt, "utf8")).toBe(original);
  }
});

test("linked and non-regular owned files are rejected before changing the old receipt", async () => {
  const f = await fixture();
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  const original = await readFile(join(f.vendor, "provenance.json"), "utf8");
  const external = join(f.upstream, "sentinel");
  await writeFile(external, "untouched\n");
  const output = join(f.root, "site/appearance.js");
  await rm(output);
  await symlink(external, output);
  await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("regular file");
  await expect(checkAppearance(f.root)).rejects.toThrow("regular file");
  expect(await readFile(external, "utf8")).toBe("untouched\n");
  expect(await readFile(join(f.vendor, "provenance.json"), "utf8")).toBe(original);
  await rm(output);
  await mkdir(output);
  await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("regular file");
  expect(await readFile(join(f.vendor, "provenance.json"), "utf8")).toBe(original);
  await rm(output, { recursive: true });
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  const manifestPath = join(f.vendor, "provenance.json");
  await rename(manifestPath, `${manifestPath}-retained`);
  await symlink(external, manifestPath);
  await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("regular file");
  await expect(rebuildAppearance(f.root, f.browser)).rejects.toThrow("regular file");
  expect(await readFile(external, "utf8")).toBe("untouched\n");
  expect(await readFile(`${manifestPath}-retained`, "utf8")).toBe(original);
});

test("a directory replaced during compilation cannot receive published files or a new receipt", async () => {
  const f = await fixture();
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  const original = await readFile(join(f.vendor, "provenance.json"), "utf8");
  const retained = `${f.vendor}-retained`;
  const external = join(f.upstream, "external");
  await mkdir(external);
  await writeFile(join(external, "sentinel"), "untouched\n");
  const build = Bun.build;
  const replacement = spyOn(Bun, "build").mockImplementation(async (options) => {
    const result = await build(options);
    await rename(f.vendor, retained);
    await symlink(external, f.vendor, "dir");
    return result;
  });
  try {
    await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("directory identity changed");
  } finally { replacement.mockRestore(); }
  expect(await readdir(external)).toEqual(["sentinel"]);
  expect(await readFile(join(external, "sentinel"), "utf8")).toBe("untouched\n");
  expect(await readFile(join(retained, "provenance.json"), "utf8")).toBe(original);
});

test("a different physical directory at the same path cannot replace the captured output owner", async () => {
  const f = await fixture();
  await refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3");
  const original = await readFile(join(f.vendor, "provenance.json"), "utf8");
  const retained = `${f.vendor}-retained`;
  const build = Bun.build;
  const replacement = spyOn(Bun, "build").mockImplementation(async (options) => {
    const result = await build(options);
    await rename(f.vendor, retained);
    await mkdir(f.vendor);
    return result;
  });
  try {
    await expect(refreshAppearance(f.root, f.upstream, f.commit, "v1.2.3")).rejects.toThrow("directory identity changed");
  } finally { replacement.mockRestore(); }
  expect(await readdir(f.vendor)).toEqual([]);
  expect(await readFile(join(retained, "provenance.json"), "utf8")).toBe(original);
});

test("all static routes point palette and Lantern styles at their distinct owners", async () => {
  for (const page of ["index", "docs", "skills", "compare", "compare-history", "docs/evaluations", "docs/evaluations-history"]) {
    const html = await readFile(new URL(`../site/${page}.html`, import.meta.url), "utf8");
    expect(html).toContain('href="/vendor/hraness-appearance/palette-bridge.css"');
    expect(html).toContain('href="/vendor/hraness-lantern/lantern-material.css"');
    expect(html).not.toContain("/vendor/hraness-paper/palette-");
    expect(html).not.toContain("/vendor/hraness-marketing/lantern-");
  }
});
