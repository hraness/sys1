import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright-core";

// Exercise the shipped static files with Vercel's clean URLs and security headers.
const site = resolve(import.meta.dir, "../site");
const config = await Bun.file(resolve(import.meta.dir, "../vercel.json")).json();
const headers = Object.fromEntries(config.headers[0].headers.map((item: { key: string; value: string }) => [item.key, item.value]));
const artifacts = resolve(process.env.SYS1_BROWSER_ARTIFACTS ?? "/tmp/sys1-site-browser");
await mkdir(artifacts, { recursive: true });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response("Bad path", { status: 400 }); }
    const clean = pathname.endsWith("/") ? `${pathname}index.html` : /\.[^/]+$/u.test(pathname) ? pathname : `${pathname}.html`;
    const path = resolve(site, `.${clean}`);
    if (!path.startsWith(`${site}${sep}`)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file, { headers }) : new Response(Bun.file(resolve(site, "404.html")), { status: 404, headers });
  },
});
const pages = [...new Bun.Glob("**/*.html").scanSync(site)].sort();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: { route: string; width: number; theme: string }[] = [];
try {
  browser = await chromium.launch();
  for (const width of [360, 390, 1440]) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width, height: width === 360 ? 740 : width === 390 ? 844 : 900 }, colorScheme: theme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      for (const file of pages) {
        const route = file === "index.html" ? "/" : `/${file.replace(/\.html$/u, "")}`;
        const response = await page.goto(new URL(route, server.url).href);
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
            smallHeaderTargets: innerWidth > 600 ? [] : [...document.querySelectorAll<HTMLElement>("header a, header button")].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && (box.width < 43.5 || box.height < 43.5); }).map(element => element.textContent?.trim() || element.getAttribute("aria-label")),
          };
        });
        await page.screenshot({ path: resolve(artifacts, `${width}-${theme}-${file.replaceAll("/", "_")}.png`), fullPage: true });
        assert.ok(!state.overflow, `${route} ${width} ${theme}: horizontal overflow`);
        assert.ok(state.title && state.footer, `${route}: missing heading/footer`);
        assert.ok(state.footerPositions.every(position => position === "static" || position === "relative"), `${route}: footer outside document flow`);
        assert.deepEqual(state.smallHeaderTargets, [], `${route}: phone targets below44px`);
        assert.deepEqual(errors, [], `${route}: browser errors`);
        results.push({ route, width, theme });
      }
      await page.goto(server.url.href);
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
} finally {
  try { await browser?.close(); }
  finally { await server.stop(true); }
}
await writeFile(resolve(artifacts, "results.json"), JSON.stringify({ cleanup: "browser and server closed", results }, null, 2) + "\n");
console.log(`Verified ${results.length} route/viewport/theme combinations.`);
