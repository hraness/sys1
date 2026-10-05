import { expect, test } from "bun:test";
import primary from "../portfolio-messaging.generated.json";

const pages = ["index.html", "introducing-sys1.html", "docs.html", "docs/evaluations.html", "docs/evaluations-history.html", "docs/runtime.html", "docs/review.html", "compare.html", "skills.html", "404.html"];

for (const page of pages) {
  test(`${page} renders the canonical product name, not its command or domain`, async () => {
    const html = await Bun.file(new URL(`../site/${page}`, import.meta.url)).text();
    const text: string[] = [];
    await new HTMLRewriter().on("a.wordmark", {
      text(chunk) { text.push(chunk.text); },
    }).transform(new Response(html)).text();
    expect(text.join("").trim()).toBe(primary.messaging.names.name);
    expect(html).toContain(`aria-label="${primary.messaging.names.name} home"`);
  });
}
