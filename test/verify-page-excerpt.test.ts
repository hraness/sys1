import { expect, test } from "bun:test";
import { EVIDENCE_LIMITS, fetchPage } from "../src/verify/evidence.ts";

for (const tag of ["script", "style"]) {
  for (const whitespace of [" ", "\t", "\n", "\r", "\f", " \n\t"]) {
    test(`page excerpt excludes ${tag} with close-tag whitespace ${JSON.stringify(whitespace)}`, async () => {
      const page = await fetchPage("https://example.com", async () => new Response(
        `<p>Visible before.</p><${tag.toUpperCase()} type="text/plain">hidden-evidence-canary</${tag}${whitespace}><p>Visible after.</p>`,
      ));
      expect(page.ok).toBe(true);
      expect(page.excerpt).toBe("Visible before. Visible after.");
    });
  }
  for (const tail of ["/", " ignored", " ignored=\"value\""]) {
    test(`page excerpt retains following text after ${tag} end-tag tail ${tail}`, async () => {
      const page = await fetchPage("https://example.com", async () => new Response(
        `<p>Before.</p><${tag}>hidden-evidence-canary</${tag}${tail}><p>After.</p>`,
      ));
      expect(page.excerpt).toBe("Before. After.");
    });
  }
  test(`page excerpt excludes ${tag} body cut off by the byte cap`, async () => {
    const page = await fetchPage("https://example.com", async () => new Response(
      `<p>Visible.</p><${tag}>` + "hidden-evidence-canary ".repeat(EVIDENCE_LIMITS.maxPageBytes) + `</${tag}>`,
    ));
    expect(page.excerpt).toBe("Visible.");
  });
}

test("similarly named custom elements retain their visible text", async () => {
  const page = await fetchPage("https://example.com", async () => new Response(
    "<script-example>Visible example.</script-example><style-guide>Visible guide.</style-guide>",
  ));
  expect(page.excerpt).toBe("Visible example. Visible guide.");
});
