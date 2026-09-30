import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { chromium, type LaunchOptions } from "playwright-core";
import { z } from "zod";
import { pinnedChromiumDefinition } from "./owned-browser.mjs";

const require = createRequire(import.meta.url);
const executableOverrides = [
  "CHROME_PATH", "CHROME_BIN", "CHROME_EXECUTABLE_PATH", "CHROMIUM_PATH",
  "CHROMIUM_EXECUTABLE_PATH", "PLAYWRIGHT_CHROME_EXECUTABLE_PATH",
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "PUPPETEER_EXECUTABLE_PATH",
  "BROWSER_EXECUTABLE_PATH", "SYS1_BROWSER_EXECUTABLE_PATH",
];

export function verifyProvisionedChromium(executable: string, revision: string, environment: NodeJS.ProcessEnv = process.env): string {
  const overrides = executableOverrides.filter(name => environment[name]);
  assert.ok(overrides.length === 0, `Browser executable overrides are not supported; unset ${overrides.join(", ")} and use the pinned Playwright browser`);
  assert.ok(!environment.SELENIUM_REMOTE_URL, "Remote browser overrides are not supported for owned browser checks");
  const candidate = resolve(executable);
  const portable = candidate.replaceAll("\\", "/").toLowerCase();
  assert.ok(!/google chrome(?: beta| dev| canary)?\.app(?:\/|$)|\/google\/chrome(?: sxs)?\/application(?:\/|$)|\/opt\/google\/chrome(?:\/|$)/u.test(portable), "System Chrome is not allowed for owned browser checks");
  assert.ok(candidate.split(sep).includes(`chromium-${revision}`), "Browser executable does not match the pinned Playwright revision");
  let actual: string;
  try {
    actual = realpathSync(candidate);
    assert.ok(statSync(actual).isFile(), "Browser executable must be a regular file");
    accessSync(actual, constants.X_OK);
  } catch (error) {
    throw new Error("Pinned Chromium is unavailable. Run ./node_modules/.bin/playwright-core install chromium; system Chrome is never a fallback.", { cause: error });
  }
  const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  assert.equal(normalize(actual), normalize(candidate), "Browser executable and its parent directories must not be symlinks");
  return actual;
}

export function chromiumPolicyArguments(defaultArgs: readonly string[]): Pick<LaunchOptions, "args" | "ignoreDefaultArgs"> {
  const disabled = defaultArgs.filter(argument => argument.startsWith("--disable-features="));
  const features = new Set(disabled.flatMap(argument => argument.slice("--disable-features=".length).split(",")).filter(Boolean));
  features.add("PaintHolding");
  features.add("MacAppCodeSignClone");
  const merged = `--disable-features=${[...features].join(",")}`;
  const unchanged = disabled.length === 1 && disabled[0] === merged;
  return {
    // Playwright filters user arguments together with its defaults. Preserve
    // an existing mute switch instead of filtering the replacement out too.
    ignoreDefaultArgs: unchanged ? [] : disabled,
    args: [...(defaultArgs.includes("--mute-audio") ? [] : ["--mute-audio"]), ...(unchanged ? [] : [merged])],
  };
}

export function pinnedChromiumPolicy() {
  const root = dirname(require.resolve("playwright-core/package.json"));
  const declared = z.object({ devDependencies: z.object({ "playwright-core": z.string().regex(/^\d+\.\d+\.\d+$/u) }) })
    .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).devDependencies["playwright-core"];
  const installed = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version;
  assert.equal(installed, declared, "Install the repository's pinned Playwright version before running browser checks");
  const manifest = z.object({ browsers: z.array(z.object({ name: z.string(), revision: z.string(), browserVersion: z.string().optional() })) })
    .parse(JSON.parse(readFileSync(join(root, "browsers.json"), "utf8")));
  const browser = manifest.browsers.find(item => item.name === "chromium");
  assert.ok(browser?.browserVersion, "Pinned Playwright must declare its Chromium version");
  // Reconcile the package's complete headless defaults, including mute-audio.
  const { defaultArgs } = pinnedChromiumDefinition();
  assert.ok(Array.isArray(defaultArgs) && defaultArgs.every(argument => typeof argument === "string"), "Unrecognized pinned Playwright launch arguments");
  return { playwrightVersion: installed, revision: browser.revision, browserVersion: browser.browserVersion, defaultArgs: defaultArgs as string[] };
}

export function siteBrowserLaunchPlan() {
  const policy = pinnedChromiumPolicy();
  const executablePath = verifyProvisionedChromium(chromium.executablePath(), policy.revision);
  const options: LaunchOptions = {
    // This channel is Playwright's own Chromium, not an installed Chrome channel.
    channel: "chromium", headless: true,
    ...chromiumPolicyArguments(policy.defaultArgs),
  };
  return { executablePath, playwrightVersion: policy.playwrightVersion, expectedVersion: policy.browserVersion, options };
}

type OwnedBrowser = { contexts(): { close(): Promise<void> }[]; close(): Promise<void> };
type OwnedServer = { stop(closeActiveConnections: boolean): void | Promise<void> };

export async function closeSiteBrowser(browser?: OwnedBrowser, server?: OwnedServer): Promise<void> {
  const errors: unknown[] = [];
  if (browser) {
    try {
      const contexts = await Promise.allSettled(browser.contexts().map(context => Promise.resolve().then(() => context.close())));
      for (const result of contexts) if (result.status === "rejected") errors.push(result.reason);
    } catch (error) { errors.push(error); }
    try { await browser.close(); } catch (error) { errors.push(error); }
  }
  try { await server?.stop(true); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Owned browser cleanup failed");
}
