import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { closeSiteBrowser, siteBrowserLaunchPlan } from "./site-browser-policy.ts";
import { checkLaunchMedia } from "./sync-launch-media.ts";

// Exercise the shipped static files with Vercel's clean URLs and security headers.
await checkLaunchMedia();
const site = resolve(import.meta.dir, "../site");
const config = await Bun.file(resolve(import.meta.dir, "../vercel.json")).json();
const headers = Object.fromEntries(config.headers[0].headers.map((item: { key: string; value: string }) => [item.key, item.value]));
const artifacts = resolve(process.env.SYS1_BROWSER_ARTIFACTS ?? "/tmp/sys1-site-browser");
await mkdir(artifacts, { recursive: true });
const production = process.argv.includes("--production");
assert.ok(process.argv.slice(2).every(argument => argument === "--production"), "Unknown argument");
const launch = siteBrowserLaunchPlan();
const server = production ? undefined : Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response("Bad path", { status: 400 }); }
    const redirect = config.redirects?.find((item: { source: string }) => item.source === pathname);
    if (redirect) return new Response(null, { status: redirect.permanent ? 308 : 307, headers: { ...headers, location: redirect.destination } });
    const clean = pathname.endsWith("/") ? `${pathname}index.html` : /\.[^/]+$/u.test(pathname) ? pathname : `${pathname}.html`;
    const path = resolve(site, `.${clean}`);
    if (!path.startsWith(`${site}${sep}`)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file, { headers }) : new Response(Bun.file(resolve(site, "404.html")), { status: 404, headers });
  },
});
const pages = [...new Bun.Glob("**/*.html").scanSync(site)].sort();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const origin = new URL(production ? "https://sys1.io" : server!.url);
const results: { route: string; width: number; theme: string }[] = [];
let browserVersion: string | undefined;
try {
  for (const redirect of config.redirects ?? []) {
    const response = await fetch(new URL(redirect.source, origin), { redirect: "manual" });
    assert.equal(response.status, redirect.permanent ? 308 : 307);
    assert.equal(new URL(response.headers.get("location")!, origin).pathname, redirect.destination);
  }
  browser = await chromium.launch(launch.options);
  browserVersion = browser.version();
  console.log(`Browser: ${launch.executablePath}\nVersion: ${browserVersion}; Playwright ${launch.playwrightVersion}`);
  assert.equal(browserVersion, launch.expectedVersion, "Launched browser differs from the pinned Playwright version");
  for (const width of [360, 390, 768, 820, 1440]) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width, height: width === 360 ? 740 : width === 390 ? 844 : 900 }, colorScheme: theme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      const movieRequests: string[] = [];
      page.on("request", request => { if (new URL(request.url()).pathname.endsWith(".mp4")) movieRequests.push(request.url()); });
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      for (const file of pages) {
        const route = file === "index.html" ? "/" : `/${file.replace(/\.html$/u, "")}`;
        const response = await page.goto(new URL(route, origin).href);
        assert.equal(response?.status(), 200, route);
        await page.evaluate(() => document.fonts.ready);
        await page.locator("main").waitFor();
        const state = await page.evaluate(() => {
          const footer = document.querySelector<HTMLElement>("#hraness-site-footer");
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            title: document.querySelector("h1")?.textContent?.trim(),
            footer: footer !== null,
            footerPositions: [footer, footer?.querySelector(".hraness-site-footer__inner")].filter((element): element is HTMLElement => element instanceof HTMLElement).map(element => getComputedStyle(element).position),
            smallHeaderTargets: innerWidth > 600 ? [] : [...document.querySelectorAll<HTMLElement>(".site-header a, .site-header button")].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && (box.width < 43.5 || box.height < 43.5); }).map(element => element.textContent?.trim() || element.getAttribute("aria-label")),
          };
        });
        await page.screenshot({ path: resolve(artifacts, `${width}-${theme}-${file.replaceAll("/", "_")}.png`), fullPage: true });
        assert.ok(!state.overflow, `${route} ${width} ${theme}: horizontal overflow`);
        assert.ok(state.title && state.footer, `${route}: missing heading/footer`);
        assert.ok(state.footerPositions.every(position => position === "static" || position === "relative"), `${route}: footer outside document flow`);
        assert.deepEqual(state.smallHeaderTargets, [], `${route}: navigation targets below 44px`);
        assert.deepEqual(errors, [], `${route}: browser errors`);
        results.push({ route, width, theme });
      }
      await page.goto(origin.href);
      const demo = page.locator("[data-decision-demo]");
      for (const [type, answer] of [["noul", '"noul": 0.94'], ["choice", '"choice": "configuration"'], ["score", '"score": 1.8']] as const) {
        const control = demo.locator(`[data-question-type="${type}"]`);
        await control.focus();
        await page.keyboard.press("Enter");
        assert.equal(await control.getAttribute("aria-pressed"), "true");
        assert.equal(await demo.locator('[aria-pressed="true"]').count(), 1);
        assert.equal(await demo.locator("[data-demo-answer]").textContent(), answer);
      }
      const video = page.locator("video");
      assert.equal(await video.getAttribute("preload"), "none");
      assert.equal(await video.getAttribute("autoplay"), null);
      assert.equal(await video.locator('track[kind="captions"][srclang="en"]').count(), 1);
      assert.deepEqual(movieRequests, [], "Page loaded video bytes before playback was requested");
      if (width === 1440 && theme === "light") {
        // Decode real shipped media once; page controls and the full transcript
        // remain usable without our illustrative interaction script.
        await video.evaluate(async element => {
          const player = element as HTMLVideoElement;
          player.muted = true;
          await player.play();
        });
        await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 0);
        const media = await video.evaluate(element => {
          const player = element as HTMLVideoElement;
          player.pause();
          return { width: player.videoWidth, height: player.videoHeight, duration: player.duration, error: player.error?.message };
        });
        assert.equal(media.width, 1920);
        assert.equal(media.height, 1080);
        assert.ok(Math.abs(media.duration - 52) < 0.5, "Film duration differs from published metadata");
        assert.equal(media.error, undefined);
      }
      await page.getByRole("button", { name: /^Appearance:/u }).click();
      const targetTheme = theme === "light" ? "dark" : "light";
      await page.getByRole("menuitemradio", { name: targetTheme, exact: false }).click();
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, targetTheme);
      await page.reload();
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, targetTheme);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Docs", exact: true }).click();
      assert.equal(new URL(page.url()).pathname, "/docs");
      assert.deepEqual(errors, [], "Browser errors after appearance and navigation interactions");
    } finally { await context.close(); }
  }
  const reduced = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const page = await reduced.newPage();
    await page.goto(origin.href);
    assert.equal(await page.locator("html").evaluate(element => getComputedStyle(element).scrollBehavior), "auto");
    assert.equal(await page.locator("[data-question-type]").first().evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  } finally { await reduced.close(); }
  const plain = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false, reducedMotion: "reduce" });
  try {
    const page = await plain.newPage();
    for (const route of ["/", "/introducing-sys1"]) {
      await page.goto(new URL(route, origin).href);
      assert.ok(await page.locator("h1").isVisible());
      assert.ok(await page.getByRole("link", { name: /transcript/iu }).first().isVisible());
      assert.equal(await page.locator("video").getAttribute("autoplay"), null);
      if (route === "/") {
        assert.ok(await page.locator("[data-demo-answer]").isVisible());
        assert.ok(!await page.locator("[data-question-type]").first().isVisible());
      } else {
        assert.ok(await page.locator("#measured").isVisible());
        assert.equal(await page.locator(".launch-beat").count(), 3);
        assert.ok(await page.locator(".launch-article-footer").getByRole("link", { name: "Install a project skill" }).isVisible());
      }
      await page.screenshot({ path: resolve(artifacts, `390-no-js-${route === "/" ? "home" : "launch"}.png`), fullPage: true });
    }
  } finally { await plain.close(); }
} finally {
  await closeSiteBrowser(browser, server);
}
await writeFile(resolve(artifacts, "results.json"), JSON.stringify({ origin: origin.href, production, source: process.env.GITHUB_SHA ?? null, capturedAt: new Date().toISOString(), browser: { executable: launch.executablePath, version: browserVersion, playwrightVersion: launch.playwrightVersion }, cleanup: "browser and server closed", results }, null, 2) + "\n");
console.log(`Verified ${results.length} route/viewport/theme combinations.`);
