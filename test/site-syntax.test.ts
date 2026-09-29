import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkSyntax, codeText, pageLanguages, renderCodeBlocks } from "../scripts/build-site-syntax";

const root = resolve(import.meta.dir, "..");

test("site code and styles match the immutable shared-highlighter snapshot", async () => {
  await checkSyntax(root);
  for (const [page, languages] of Object.entries(pageLanguages)) {
    const html = await readFile(join(root, page), "utf8");
    const matches = [...html.matchAll(/<pre\b([^>]*)><code\b([^>]*)>([\s\S]*?)<\/code><\/pre>/gu)];
    expect(matches).toHaveLength(languages.length);
    for (const [index, block] of matches.entries()) {
      expect(block[1]).toContain('tabindex="0"');
      expect(block[2]).toContain(`class="syntax-code language-${languages[index]}"`);
      expect(block[3]).toMatch(/class="(?:syntax-token|sh__token--)/u);
      expect(block[3]).not.toMatch(/<[^>]*\sstyle=/u);
    }
  }
});

test("rendering preserves literal entities, escapes, copy ids, and accessible labels", () => {
  const html = '<pre aria-label="Example"><code id="copy-me">&lt;tag&gt; &amp;lt; &quot;quote&quot; &#39;\r\n</code></pre>';
  let received = "";
  const rendered = renderCodeBlocks(html, ["shell"], (code, language, options) => {
    received = code;
    expect(options.styles).toBe("classes");
    return { className: `syntax-code language-${language}`, language, html: '<span class="syntax-token syntax-token--string">&lt;tag&gt; &amp;lt; &quot;quote&quot; &#39;\r\n</span>' };
  });
  expect(received).toBe('<tag> &lt; "quote" \'\r\n');
  expect(rendered).toContain('aria-label="Example" tabindex="0"');
  expect(rendered).toContain('id="copy-me" class="syntax-code language-shell"');
  expect(codeText('&amp;lt; &lt; &amp; &gt;')).toBe('&lt; < & >');
});

test("rendering rejects undeclared blocks, changed text, and executable markup", () => {
  const html = '<pre><code>sys1 doctor</code></pre>';
  const changed = () => ({ className: "syntax-code language-shell", language: "shell", html: "sys1 setup" });
  expect(() => renderCodeBlocks(html, [], changed)).toThrow("inventory");
  expect(() => renderCodeBlocks(html, ["shell"], changed)).toThrow("changed the source");
  expect(() => codeText('<script>bad()</script>')).toThrow("escaped code");
  expect(() => renderCodeBlocks(html, ["shell"], () => ({ className: "syntax-code language-shell", language: "shell", html: '<span onclick="bad()">sys1 doctor</span>' }))).toThrow("unexpected markup");
});

test("the check catches an edited code block or stylesheet", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "sys1-syntax-test-"));
  try {
    const files = [...Object.keys(pageLanguages), "scripts/build-site-syntax.ts", "site/vendor/hraness-syntax"];
    for (const file of files) {
      await mkdir(dirname(join(temporary, file)), { recursive: true });
      await cp(join(root, file), join(temporary, file), { recursive: true });
    }
    await checkSyntax(temporary);
    const page = join(temporary, "site/index.html");
    const html = await readFile(page, "utf8");
    await writeFile(page, html.replace('id="install-command-macos"', 'id="changed-command"'));
    await expect(checkSyntax(temporary)).rejects.toThrow("site/index.html");
    await writeFile(page, html);
    const css = join(temporary, "site/vendor/hraness-syntax/syntax-highlighting.css");
    await writeFile(css, `${await readFile(css, "utf8")}\n/* drift */`);
    await expect(checkSyntax(temporary)).rejects.toThrow("syntax-highlighting.css");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
