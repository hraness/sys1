import { statSync } from "node:fs";
import { posix, resolve } from "node:path";

// Repository guides the website renders as pages. Their templates hold a
// marker that build-site-copy.ts replaces with the guide's contents and body,
// so `check:site-copy` fails when a guide changes without its page.
const REPOSITORY = "https://github.com/hraness/sys1";
const ORIGIN = "https://sys1.io";

/** Repository guides and the site pages that publish them. */
export const SITE_GUIDES = {
  "docs/runtime.md": "/docs/runtime",
  "docs/review.md": "/docs/review",
} as const satisfies Record<string, `/${string}`>;
export type SiteGuide = keyof typeof SITE_GUIDES;

/** README sections with an equivalent site section. Other README links stay on GitHub. */
const README_SECTIONS: Readonly<Record<string, string>> = {
  install: "/docs#getting-started",
};

const MARKER = /<!-- sys1:guide (contents|body) (docs\/[a-z0-9-]+\.md) -->/gu;

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function decodeText(html: string): string {
  let text = html;
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/<[^<>]*>/gu, "");
  }
  return text.replaceAll("<", "").replaceAll(">", "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

/** GitHub's heading fragment for the visible heading text. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}\s_-]/gu, "").replace(/\s/gu, "-");
}

function addHeadingIds(html: string): string {
  const seen = new Map<string, number>();
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/gu, (_, level: string, body: string) => {
    const base = headingSlug(decodeText(body));
    if (base === "") throw new Error("A guide heading has no stable fragment");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `<h${level} id="${count === 0 ? base : `${base}-${count}`}">${body}</h${level}>`;
  });
}

/** Heading fragments a rendered guide defines. */
export function guideFragments(html: string): ReadonlySet<string> {
  return new Set(Array.from(html.matchAll(/<h[1-6] id="([^"]+)">/gu), ([, id]) => id ?? ""));
}

function isDirectory(root: string, path: string): boolean {
  try { return statSync(resolve(root, path)).isDirectory(); } catch { return false; }
}

/** The site or GitHub address for a link in a guide. */
function rewriteTarget(target: string, guide: SiteGuide, root: string): string {
  if (target.startsWith("#")) return target;
  if (target.startsWith(`${ORIGIN}/`)) return target.slice(ORIGIN.length);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
    if (!/^(?:https?|mailto):/iu.test(target)) throw new Error(`${guide} links to a disallowed scheme: ${target}`);
    return target;
  }
  if (target.startsWith("/")) throw new Error(`${guide} uses a site-absolute path: ${target}`);
  const hash = target.indexOf("#");
  const relative = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? undefined : target.slice(hash + 1);
  const path = posix.normalize(posix.join(posix.dirname(guide), relative));
  if (path === ".." || path.startsWith("../")) throw new Error(`${guide} links outside the repository: ${target}`);
  const page = (SITE_GUIDES as Readonly<Record<string, string>>)[path];
  if (page !== undefined) return path === guide ? `#${fragment ?? ""}` : `${page}${fragment === undefined ? "" : `#${fragment}`}`;
  if (path === "README.md" && fragment !== undefined && README_SECTIONS[fragment] !== undefined) return README_SECTIONS[fragment];
  const kind = isDirectory(root, path) ? "tree" : "blob";
  return `${REPOSITORY}/${kind}/main/${path}${fragment === undefined ? "" : `#${fragment}`}`;
}

/** Scrollable, labeled table regions, matching the site's comparison tables. */
function wrapTables(html: string): string {
  let heading = "Reference table";
  return html.replace(/<h[23] id="[^"]+">([\s\S]*?)<\/h[23]>|<table>([\s\S]*?)<\/table>/gu, (match, title: string | undefined, table: string | undefined) => {
    if (title !== undefined) { heading = decodeText(title); return match; }
    return `<div class="table-scroll" role="region" aria-label="${escapeText(heading)}" tabindex="0"><table class="comparison-table">${table ?? ""}</table></div>`;
  });
}

export interface RenderedGuide {
  readonly html: string;
  readonly sections: readonly { readonly id: string; readonly label: string }[];
}

/** One guide as page HTML: the title line is left to the template. */
export function renderGuide(markdown: string, guide: SiteGuide, root: string): RenderedGuide {
  const withoutTitle = markdown.replace(/^# [^\n]*\n+/u, "");
  const rendered = Bun.markdown.html(withoutTitle, { noHtmlBlocks: true, noHtmlSpans: true, tagFilter: true });
  const linked = addHeadingIds(rendered).replace(/href="([^"]*)"/gu, (_, target: string) => `href="${rewriteTarget(target, guide, root)}"`);
  if (/\ssrc="/u.test(linked)) throw new Error(`${guide} embeds an image; the site serves only its own assets`);
  const html = wrapTables(linked).replace(/<pre><code/gu, '<pre tabindex="0"><code').trim();
  const ids = guideFragments(html);
  for (const [, fragment] of html.matchAll(/href="#([^"]*)"/gu)) {
    if (!ids.has(fragment ?? "")) throw new Error(`${guide} links to a missing heading #${fragment}`);
  }
  const sections = Array.from(html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/gu), ([, id, body]) => ({ id: id ?? "", label: decodeText(body ?? "") }));
  return { html, sections };
}

/** Replace a template's guide markers with the rendered contents list and body. */
export async function renderGuideMarkers(template: string, root: string): Promise<string> {
  const rendered = new Map<SiteGuide, RenderedGuide>();
  for (const [, , path] of template.matchAll(MARKER)) {
    if (path === undefined || !(path in SITE_GUIDES)) throw new Error(`Unknown guide marker: ${path}`);
    const guide = path as SiteGuide;
    if (!rendered.has(guide)) rendered.set(guide, renderGuide(await Bun.file(resolve(root, guide)).text(), guide, root));
  }
  return template.replace(MARKER, (_, part: "contents" | "body", path: SiteGuide) => {
    const guide = rendered.get(path)!;
    return part === "body"
      ? guide.html
      : guide.sections.map(section => `<a href="#${section.id}">${escapeText(section.label)}</a>`).join("\n            ");
  });
}

/** Links from one guide into another must land on a heading that exists. */
export async function checkGuideLinks(root: string): Promise<void> {
  const guides = await Promise.all((Object.keys(SITE_GUIDES) as SiteGuide[]).map(async guide =>
    [guide, renderGuide(await Bun.file(resolve(root, guide)).text(), guide, root)] as const));
  const fragments = new Map(guides.map(([guide, rendered]) => [SITE_GUIDES[guide] as string, guideFragments(rendered.html)]));
  for (const [guide, rendered] of guides) {
    for (const [, page, fragment] of rendered.html.matchAll(/href="(\/docs\/[a-z-]+)#([^"]+)"/gu)) {
      const ids = fragments.get(page ?? "");
      if (ids !== undefined && !ids.has(fragment ?? "")) throw new Error(`${guide} links to a missing heading ${page}#${fragment}`);
    }
  }
}
