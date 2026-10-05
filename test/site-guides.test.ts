import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkGuideLinks, guideFragments, renderGuide, SITE_GUIDES } from "../scripts/site-docs.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");

test("each repository guide is published at its site page from the same Markdown", () => {
  for (const [guide, page] of Object.entries(SITE_GUIDES)) {
    const html = read(`site${page}.html`);
    const rendered = renderGuide(read(guide), guide as keyof typeof SITE_GUIDES, root);
    expect(html).toContain(rendered.html);
    expect(html).toContain(`<link rel="canonical" href="https://sys1.io${page}" />`);
    expect(html).toContain(`href="https://github.com/hraness/sys1/blob/main/${guide}"`);
    for (const section of rendered.sections) expect(html).toContain(`<a href="#${section.id}">`);
  }
});

test("the runtime page carries the endpoint table, request example, and response headers", () => {
  const html = read("site/docs/runtime.html");
  const endpoint = html.slice(html.indexOf('<h2 id="the-endpoint">'), html.indexOf('<h2 id="routing">'));
  for (const route of ["POST /v1/systemone", "GET /v1/models", "GET /healthz"]) expect(endpoint).toContain(`<code>${route}</code>`);
  expect(endpoint).toContain('id="request-example"');
  expect(endpoint).toContain("<code>x-sys1-backend</code>");
  expect(endpoint).toContain('<div class="table-scroll" role="region" aria-label="The endpoint" tabindex="0">');
});

test("the review page keeps its status table and troubleshooting, and the local-route limit", () => {
  const html = read("site/docs/review.html");
  expect(guideFragments(html).has("troubleshooting")).toBe(true);
  expect(html).toContain("<code>superseded</code>");
  const body = text(html);
  expect(body).toContain("review currently rejects the bundled local Qwen routes");
  expect(body).toContain("Review state is busy; retry this command");
  expect(body).not.toContain("For an already installed local model");
});

test("links between guides land on headings that exist", async () => {
  await checkGuideLinks(root);
});

test("site pages and the agent map send guide readers to the site, not GitHub", () => {
  const guideLinks = (page: string) => page.match(/github\.com\/hraness\/sys1\/blob\/main\/docs\/(?:runtime|review)\.md[#")]/gu) ?? [];
  for (const file of ["site/llms.txt", "site/docs.html", "site/skills.html"]) expect(guideLinks(read(file))).toEqual([]);
  // Each guide links its own source once, from the page header.
  for (const [guide, page] of Object.entries(SITE_GUIDES)) {
    expect(guideLinks(read(`site${page}.html`))).toEqual([`github.com/hraness/sys1/blob/main/${guide}"`]);
  }
  const llms = read("site/llms.txt");
  expect(llms).toContain("[Runtime reference](https://sys1.io/docs/runtime)");
  expect(llms).toContain("[Review guide](https://sys1.io/docs/review)");
  const docs = read("site/docs.html");
  expect(docs).toContain('href="/docs/review"');
  expect(docs).toContain('href="/docs/runtime#the-endpoint"');
});

test("the skills page dates its Claude Code and RTK notes and keeps the replay's sessions", () => {
  const html = read("site/skills.html");
  const claude = text(html.slice(html.indexOf('<div id="claude-code"'), html.indexOf('<div id="rtk"')));
  expect(claude).toContain("checked on October 4, 2026");
  expect(claude).toContain("BASH_MAX_OUTPUT_LENGTH");
  expect(html).toContain('href="https://code.claude.com/docs/en/tools-reference#output-limits"');
  // The Claude Code trial and the Codex/Devin replay are separate measurements.
  expect(claude).toContain("Claude Code with Sonnet 5.5 never called the skill");
  expect(claude).toContain("no measurable token or time saving");
  expect(html).toContain('href="https://github.com/hraness/system-one-skills/blob/main/docs/WHOLE-TASK-RESULT-2026-09.md"');
  expect(claude).toContain("used Codex and Devin sessions only.");
  expect(claude).not.toContain("no Claude Code sessions have been measured");
  const rtk = text(html.slice(html.indexOf('<div id="rtk"'), html.indexOf("</section>", html.indexOf('<div id="rtk"'))));
  expect(rtk).toContain("at v0.51.0 on October 4, 2026");
  expect(html).toContain('href="https://github.com/rtk-ai/rtk"');
  expect(html).toContain('<a href="#claude-code">Claude Code and RTK</a>');
  expect(html).not.toContain("You can also choose an experimental local model");
});

test("rendered guides follow the public copy rules", () => {
  for (const page of Object.values(SITE_GUIDES)) {
    const html = read(`site${page}.html`);
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    expect(main).not.toContain("—");
    expect(text(main)).not.toMatch(/\b(?:admission|custody|bounded|seamless|robust|powerful|leverage)\b/iu);
  }
});
