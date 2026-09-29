import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkPlatforms, installCommand, SYS1_PLATFORM_BLOCKS } from "../scripts/build-site-platforms.ts";

const root = resolve(import.meta.dir, "..");

test("the install blocks match the recorded design-kit platform marks", async () => {
  await checkPlatforms(root);
  const manifest = JSON.parse(await readFile(join(root, "site/vendor/hraness-platforms/provenance.json"), "utf8"));
  expect(manifest.source.release).toBe("v0.29.2");
});

test("home and docs list macOS, Linux, and Windows in order with the released command", async () => {
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  expect(installCommand).toBe(`npm install --global --allow-scripts=node-llama-cpp https://github.com/hraness/sys1/releases/download/v${version}/hraness-sys1-${version}.tgz`);
  for (const block of SYS1_PLATFORM_BLOCKS) {
    expect(block.targets.map((target) => target.id)).toEqual(["macos", "linux", "windows"]);
    expect(block.targets.map((target) => target.shell)).toEqual(["Terminal", "Terminal", "PowerShell"]);
    const html = await readFile(join(root, block.page), "utf8");
    const tabs = [...html.matchAll(/role="tab" id="[^"]+" aria-controls="[^"]+" aria-selected="(?:true|false)" tabindex="-?\d" data-platform="([a-z]+)"/gu)].map((match) => match[1]);
    expect(tabs).toEqual(["macos", "linux", "windows"]);
    expect(html).toContain('<div class="platform-badges"><span class="platform-badges-label" aria-hidden="true">Runs on</span>');
    expect(html).not.toMatch(/\sstyle=/u);
  }
});
