import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { launchMedia as media } from "../media/sys1-launch/site-media.ts";

const root = resolve(import.meta.dir, "..");
const begin = "    <!-- sys1-launch-media:start -->";
const end = "    <!-- sys1-launch-media:end -->";
const url = (path: string): string => new URL(path, "https://sys1.io").href;
const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const json = (value: unknown): string => JSON.stringify(value, null, 2).replaceAll("<", "\\u003c");
const assetIdentity = z.object({
  path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().positive(),
});
const imageIdentity = assetIdentity.extend({ width: z.number().int().positive(), height: z.number().int().positive() });
const provenanceSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  assets: z.object({
    poster: imageIdentity, social: imageIdentity,
    video: imageIdentity.extend({ durationSeconds: z.number().positive() }),
    captions: assetIdentity, transcript: assetIdentity,
  }),
});

function imageObject() {
  return {
    "@type": "ImageObject", url: url(media.poster.src), contentUrl: url(media.poster.src),
    width: media.poster.width, height: media.poster.height, caption: media.poster.alt,
    creditText: media.credit,
  };
}

function videoObject(page: typeof media.pages[number]) {
  const pageUrl = page.url;
  return {
    "@context": "https://schema.org", "@type": "VideoObject", "@id": `${pageUrl}#launch-film`,
    name: media.name, description: media.description, thumbnailUrl: url(media.poster.src),
    contentUrl: url(media.video.src), uploadDate: media.published,
    duration: `PT${media.video.durationSeconds}S`, width: media.video.width, height: media.video.height,
    inLanguage: "en", creditText: media.credit,
    caption: { "@type": "MediaObject", contentUrl: url(media.captions.src), encodingFormat: media.captions.contentType, inLanguage: "en" },
    associatedMedia: { "@type": "MediaObject", name: "Visual transcript", contentUrl: url(media.transcript.src), encodingFormat: media.transcript.contentType, inLanguage: "en" },
    isPartOf: { "@id": page.article ? `${pageUrl}#article` : url("/#website") },
    about: { "@id": url("/#software") },
    publisher: { "@id": "https://hraness.com/#organization" },
  };
}

function projectPage(source: string, page: typeof media.pages[number]): string {
  const split = source.indexOf("</head>");
  assert.ok(split >= 0, `${page.file}: missing head`);
  let head = source.slice(0, split);
  const body = source.slice(split);
  assert.ok(head.includes(`<link rel="canonical" href="${page.url}"`), `${page.file}: canonical differs from media record`);
  head = head.replace(/    <!-- sys1-launch-media:start -->[\s\S]*?    <!-- sys1-launch-media:end -->\n/gu, "")
    // Registered pages use the reviewed film crop instead of the site's generic card.
    .replace(/^[ \t]*<meta (?:property="og:image(?::[^"]+)?"|name="twitter:image(?::[^"]+)?")[^>]*>\r?\n/gmu, "")
    .replace(/(<meta name="twitter:card" content=")[^"]+("\s*\/>)/u, "$1summary_large_image$2");
  assert.ok(head.includes('name="twitter:card" content="summary_large_image"'), `${page.file}: missing Twitter card`);
  if (page.article) {
    let found = false;
    head = head.replace(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/gu, (original, content: string) => {
      const value: unknown = JSON.parse(content);
      if (typeof value !== "object" || value === null || !("@type" in value) || value["@type"] !== "BlogPosting") return original;
      assert.ok(!found, "Duplicate BlogPosting");
      found = true;
      return `<script type="application/ld+json">\n${json({ ...value, image: imageObject(), isPartOf: { "@id": url("/#website") }, video: { "@id": `${page.url}#launch-film` } })}\n    </script>`;
    });
    assert.ok(found, `${page.file}: missing BlogPosting`);
  }
  const block = [
    begin,
    `    <meta property="og:image" content="${url(media.social.src)}" />`,
    `    <meta property="og:image:type" content="${media.social.contentType}" />`,
    `    <meta property="og:image:width" content="${media.social.width}" />`,
    `    <meta property="og:image:height" content="${media.social.height}" />`,
    `    <meta property="og:image:alt" content="${escape(media.social.alt)}" />`,
    `    <meta name="twitter:image" content="${url(media.social.src)}" />`,
    `    <meta name="twitter:image:alt" content="${escape(media.social.alt)}" />`,
    `    <script type="application/ld+json" data-sys1-launch-video>\n${json(videoObject(page))}\n    </script>`,
    end,
  ].join("\n");
  // Insert before the icon without changing reviewed body, navigation, or copy.
  assert.ok(head.includes('    <link rel="icon"'), `${page.file}: missing insertion point`);
  return head.replace('    <link rel="icon"', `${block}\n    <link rel="icon"`) + body;
}

function projectSitemap(source: string): string {
  const blocks = [...source.matchAll(/  <url>[\s\S]*?<\/url>/gu)].map(match => match[0])
    // The legacy route redirects to /docs/evaluations-history.
    .filter(block => !block.includes("<loc>https://sys1.io/compare-history</loc>"));
  assert.ok(blocks.length > 0, "Missing sitemap routes");
  const locations = blocks.map(block => /<loc>(.*?)<\/loc>/u.exec(block)?.[1]);
  assert.ok(locations.every(Boolean) && new Set(locations).size === locations.length, "Invalid or duplicate sitemap routes");
  for (const page of media.pages) {
    const block = `  <url>
    <loc>${escape(page.url)}</loc>
    <image:image><image:loc>${url(media.poster.src)}</image:loc></image:image>
    <video:video>
      <video:thumbnail_loc>${url(media.poster.src)}</video:thumbnail_loc>
      <video:title>${escape(media.name)}</video:title>
      <video:description>${escape(media.description)}</video:description>
      <video:content_loc>${url(media.video.src)}</video:content_loc>
      <video:duration>${media.video.durationSeconds}</video:duration>
      <video:publication_date>${media.published}</video:publication_date>
    </video:video>
  </url>`;
    const index = locations.indexOf(page.url);
    if (index < 0) blocks.push(block);
    else blocks[index] = block;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${blocks.join("\n")}
</urlset>\n`;
}

async function sync(mode: "--write" | "--check"): Promise<void> {
  const stale: string[] = [];
  for (const file of [...media.pages.map(page => page.file), "site/sitemap.xml"]) {
    const path = resolve(root, file);
    const original = await readFile(path, "utf8");
    const page = media.pages.find(item => item.file === file);
    const projected = page ? projectPage(original, page) : projectSitemap(original);
    if (original === projected) continue;
    if (mode === "--write") await writeFile(path, projected);
    else stale.push(file);
  }
  assert.deepEqual(stale, [], "Launch media metadata is stale; run bun scripts/sync-launch-media.ts --write");
}

/** Read-only, local checks. No browser, provider, rendering, or network work. */
export async function checkLaunchMedia(): Promise<void> {
  await sync("--check");
  assert.ok(media.provenance.reviewedBy, "Launch media still needs recorded visual review");
  const receipt = provenanceSchema.parse(JSON.parse(await readFile(resolve(root, media.provenance.receipt), "utf8")) as unknown);
  assert.equal(media.published, receipt.createdAt, "Media timestamp differs from the recorded artifact creation time");
  const assets = { poster: media.poster, social: media.social, video: media.video, captions: media.captions, transcript: media.transcript };
  for (const key of Object.keys(assets) as (keyof typeof assets)[]) {
    const asset = assets[key];
    assert.ok(asset.sha256 && /^[a-f0-9]{64}$/u.test(asset.sha256), `${asset.src}: identity pending`);
    assert.ok(asset.bytes !== null && asset.bytes > 0, `${asset.src}: byte size pending`);
    const bytes = await readFile(resolve(root, `site${asset.src}`));
    assert.equal(bytes.byteLength, asset.bytes, `${asset.src}: size changed`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `${asset.src}: hash changed`);
    const recorded = receipt.assets[key];
    assert.deepEqual([recorded.path, recorded.bytes, recorded.sha256], [`site${asset.src}`, asset.bytes, asset.sha256], `${asset.src}: provenance identity differs`);
  }
  for (const key of ["poster", "social"] as const) {
    const asset = media[key];
    const metadata = await sharp(resolve(root, `site${asset.src}`)).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [asset.width, asset.height, "jpeg"], `${asset.src}: image dimensions or type differ`);
    assert.deepEqual([receipt.assets[key].width, receipt.assets[key].height], [asset.width, asset.height], `${asset.src}: provenance dimensions differ`);
  }
  assert.deepEqual([receipt.assets.video.width, receipt.assets.video.height, receipt.assets.video.durationSeconds], [media.video.width, media.video.height, media.video.durationSeconds], "Video provenance dimensions or duration differ");
  for (const page of media.pages) {
    const html = await readFile(resolve(root, page.file), "utf8");
    const video = /<video\b[^>]*>[\s\S]*?<\/video>/u.exec(html)?.[0];
    assert.ok(video, `${page.file}: visible film missing`);
    assert.ok(video.includes(`poster="${media.poster.src}"`) && video.includes(`src="${media.video.src}"`), `${page.file}: visible film differs`);
    assert.ok(video.includes(`width="${media.video.width}"`) && video.includes(`height="${media.video.height}"`), `${page.file}: visible dimensions differ`);
    assert.ok(video.includes(`src="${media.captions.src}"`) && html.includes(`href="${media.transcript.src}"`), `${page.file}: captions or transcript missing`);
    assert.equal([...html.matchAll(/property="og:image"/gu)].length, 1, `${page.file}: duplicate or missing social image`);
    assert.equal([...html.matchAll(/name="twitter:image"/gu)].length, 1, `${page.file}: duplicate or missing Twitter image`);
    assert.equal([...html.matchAll(/"@type": "VideoObject"/gu)].length, 1, `${page.file}: duplicate or missing video schema`);
  }
  // Documentation may keep the generic brand card without inheriting editorial media.
  const docs = await readFile(resolve(root, "site/docs.html"), "utf8");
  assert.ok(!/sys1-launch-media:start|\/media\/sys1-launch|"@type"\s*:\s*"(?:ImageObject|VideoObject)"/u.test(docs), "Documentation must not inherit launch media");
  for (const [, src] of docs.matchAll(/<meta (?:property="og:image"|name="twitter:image") content="([^"]+)"/gu)) {
    assert.equal(src, url("/og.png"), "Documentation may only use its generic brand card");
  }
}

if (import.meta.main) {
  const [mode, ...extra] = process.argv.slice(2);
  if ((mode !== "--write" && mode !== "--check") || extra.length > 0) throw new Error("Usage: bun scripts/sync-launch-media.ts --write|--check");
  if (mode === "--check") await checkLaunchMedia();
  else await sync(mode);
  console.log(mode === "--check" ? "Launch media metadata and reviewed artifacts match." : "Launch media metadata synchronized; run --check after recording reviewed artifacts.");
}
