import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromiumPolicyArguments, closeSiteBrowser, pinnedChromiumPolicy, verifyProvisionedChromium } from "../scripts/site-browser-policy.ts";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function executable(revision = "1234") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sys1-browser-policy-"));
  fixtures.push(root);
  const path = join(root, `chromium-${revision}`, "browser", "chrome");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fixture, never executed\n");
  chmodSync(path, 0o700);
  return path;
}

test("accepts only an existing executable from the pinned revision", () => {
  const path = executable();
  expect(verifyProvisionedChromium(path, "1234", {})).toBe(realpathSync(path));
  expect(() => verifyProvisionedChromium(path, "9999", {})).toThrow("pinned Playwright revision");
  rmSync(path);
  expect(() => verifyProvisionedChromium(path, "1234", {})).toThrow("system Chrome is never a fallback");
});

test("rejects system Chrome and environment executable overrides", () => {
  expect(() => verifyProvisionedChromium("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "1234", {})).toThrow("System Chrome");
  expect(() => verifyProvisionedChromium("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "1234", {})).toThrow("System Chrome");
  const path = executable();
  for (const name of ["CHROME_PATH", "CHROME_BIN", "CHROMIUM_EXECUTABLE_PATH", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "SYS1_BROWSER_EXECUTABLE_PATH"]) {
    expect(() => verifyProvisionedChromium(path, "1234", { [name]: path })).toThrow("executable overrides");
  }
  expect(verifyProvisionedChromium(path, "1234", { CHROME_BIN: "" })).toBe(realpathSync(path));
  expect(() => verifyProvisionedChromium(path, "1234", { CHROME_BIN: "/private/custom/browser" })).toThrow("unset CHROME_BIN");
  expect(() => verifyProvisionedChromium(path, "1234", { SELENIUM_REMOTE_URL: "https://example.invalid" })).toThrow("Remote browser overrides");
});

test("rejects a symlinked browser directory even when its name has the pinned revision", () => {
  const target = executable();
  const link = executable();
  rmSync(dirname(link), { recursive: true });
  symlinkSync(dirname(target), dirname(link), process.platform === "win32" ? "junction" : "dir");
  expect(() => verifyProvisionedChromium(link, "1234", {})).toThrow("must not be symlinks");
});

test.skipIf(process.platform === "win32")("rejects a symlinked executable within a real browser directory", () => {
  const target = executable();
  const link = executable();
  rmSync(link);
  symlinkSync(target, link);
  expect(() => verifyProvisionedChromium(link, "1234", {})).toThrow("must not be symlinks");
});

test("merges feature switches while keeping Playwright's unrelated defaults", () => {
  const defaults = ["--keep-this-default", "--mute-audio", "--disable-features=OtherFeature,PaintHolding", "--disable-features=SecondFeature"];
  const policy = chromiumPolicyArguments(defaults);
  const effective = [...defaults, ...policy.args!].filter(argument => !(policy.ignoreDefaultArgs as string[]).includes(argument));
  expect(effective).toContain("--keep-this-default");
  expect(effective.filter(argument => argument === "--mute-audio")).toHaveLength(1);
  const disabled = effective.filter(argument => argument.startsWith("--disable-features="));
  expect(disabled).toHaveLength(1);
  expect(new Set(disabled[0]!.split("=")[1]!.split(","))).toEqual(new Set(["OtherFeature", "SecondFeature", "PaintHolding", "MacAppCodeSignClone"]));
});

test("retains already-correct feature switches and mutes defaults that omit the headless switch", () => {
  for (const mute of [[], ["--mute-audio"]]) {
    const defaults = [...mute, "--keep-this-default", "--disable-features=PaintHolding,MacAppCodeSignClone"];
    const options = chromiumPolicyArguments(defaults);
    const effective = [...defaults, ...options.args!].filter(argument => !(options.ignoreDefaultArgs as string[]).includes(argument));
    expect(effective.filter(argument => argument === "--mute-audio")).toHaveLength(1);
    expect(effective.filter(argument => argument.startsWith("--disable-features="))).toHaveLength(1);
    expect(effective).toContain("--keep-this-default");
  }
});

test("the actual pinned Playwright switch list keeps one merged feature switch", () => {
  const policy = pinnedChromiumPolicy();
  expect(policy.playwrightVersion).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).devDependencies["playwright-core"]);
  expect(policy.revision).toMatch(/^\d+$/u);
  expect(policy.browserVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
  const options = chromiumPolicyArguments(policy.defaultArgs);
  const effective = [...policy.defaultArgs, ...options.args!].filter(argument => !(options.ignoreDefaultArgs as string[]).includes(argument));
  expect(effective.filter(argument => argument === "--mute-audio")).toHaveLength(1);
  expect(effective.filter(argument => argument.startsWith("--disable-features="))).toHaveLength(1);
  expect(effective.find(argument => argument.startsWith("--disable-features="))?.split("=")[1]?.split(",")).toContain("MacAppCodeSignClone");
  for (const argument of policy.defaultArgs.filter(argument => !argument.startsWith("--disable-features=") && argument !== "--mute-audio")) expect(effective).toContain(argument);
});

test("cleanup collects every context before the browser and server, including failures", async () => {
  const calls: string[] = [];
  const contextFailure = new Error("context cleanup failed");
  const browserFailure = new Error("browser cleanup failed");
  let failure: unknown;
  try {
    await closeSiteBrowser({
      contexts: () => [
        { async close() { calls.push("context 1"); throw contextFailure; } },
        { async close() { calls.push("context 2"); } },
      ],
      async close() { calls.push("browser"); throw browserFailure; },
    }, { stop(force) { expect(force).toBe(true); calls.push("server"); } });
  } catch (error) { failure = error; }
  expect(calls).toEqual(["context 1", "context 2", "browser", "server"]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([contextFailure, browserFailure]);
  await closeSiteBrowser(undefined, { stop() { calls.push("server without browser"); } });
  expect(calls.at(-1)).toBe("server without browser");
});
