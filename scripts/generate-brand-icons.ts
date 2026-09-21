import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";

// Compact path-only marks and black-background app icons follow the same
// 160-unit, 12.5%-inset recipe as the Hraness brand asset compositor.
const root = resolve(import.meta.dir, "..");
const sourceBytes = await readFile(resolve(root, "brand/sys1.source.json"));
const generatorBytes = await readFile(import.meta.filename);
const path = z.string().regex(/^[MLHVQZ0-9 .-]+$/u);
const color = z.string().regex(/^#[0-9a-f]{6}$/u);
const source = z.strictObject({
  version: z.literal(1), name: z.literal("Sys1"), inspiration: z.string(),
  viewBox: z.literal("0 0 160 160"), box: path, one: path,
  palette: z.strictObject({mark: color, primary: color, secondary: color, background: color}),
  recipe: z.strictObject({iconInset: z.literal(0.125), webIconSize: z.literal(512), appleTouchSize: z.literal(180)}),
}).parse(JSON.parse(sourceBytes.toString()));
const check = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Only --check is supported");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const svg = (size: number, content: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n${content}\n</svg>\n`;
const markPath = `  <path fill="${source.palette.mark}" fill-rule="evenodd" d="${source.box} ${source.one}"/>`;
const mark = svg(160, markPath);
const duotonePaths = `  <path d="${source.box}" fill="${source.palette.secondary}"/>\n  <path d="${source.one}" fill="${source.palette.primary}"/>`;
const artifacts = new Map<string, Uint8Array>([
  ["site/marks/sys1.svg", Buffer.from(mark)],
  ["brand/sys1.duotone.svg", Buffer.from(svg(160, duotonePaths))],
  ["brand/sys1.illustration.svg", Buffer.from(svg(192, markPath.replace("<path ", '<path transform="translate(16 16)" ')))],
]);

// Prove that the defining numeral remains transparent in the compact mark,
// with enough visual mass at the shared 16/32px review sizes.
for (const size of [16, 32]) {
  const {data, info} = await sharp(Buffer.from(mark)).resize(size,size).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let visible = 0;
  for (let i=3;i<data.length;i+=info.channels) if(data[i]!>=24) visible++;
  const coverage = visible / (size*size);
  if(coverage<0.12 || coverage>0.76) throw new Error(`Mark coverage failed at ${size}px: ${coverage}`);
  const x = Math.floor(size*0.54), y = Math.floor(size*0.52);
  if(data[(y*size+x)*info.channels+3]!>24) throw new Error(`Numeral cutout lost at ${size}px`);
}

for (const [file,size] of [["icon.png",512],["apple-icon.png",180],["favicon-32.png",32],["favicon-16.png",16]] as const) {
  const inset = size * source.recipe.iconInset;
  const scale = size * (1-2*source.recipe.iconInset) / 160;
  const composed = svg(size, `  <rect width="${size}" height="${size}" fill="${source.palette.background}"/>\n  <g transform="translate(${inset} ${inset}) scale(${scale})">\n${duotonePaths}\n  </g>`);
  artifacts.set(`site/${file}`, await sharp(Buffer.from(composed)).flatten({background:source.palette.background}).png({adaptiveFiltering:false,compressionLevel:9}).toBuffer());
}
// PNG-backed ICO directory for older browsers, using those same two sizes.
const icons = [16,32].map(size=>({size,data:artifacts.get(`site/favicon-${size}.png`)!}));
const directory=Buffer.alloc(6+16*icons.length); directory.writeUInt16LE(1,2); directory.writeUInt16LE(icons.length,4);
let offset=directory.length;
icons.forEach(({size,data},index)=>{
  const start=6+index*16; directory[start]=size; directory[start+1]=size;
  directory.writeUInt16LE(1,start+4); directory.writeUInt16LE(32,start+6);
  directory.writeUInt32LE(data.length,start+8); directory.writeUInt32LE(offset,start+12); offset+=data.length;
});
artifacts.set("site/favicon.ico",Buffer.concat([directory,...icons.map(x=>Buffer.from(x.data))]));
const manifest = {
  version:1, identity:"Sys1", inspiration:source.inspiration,
  origin:"Authored path geometry; no font, emoji raster, or model runtime required.",
  source:{path:"brand/sys1.source.json",sha256:hash(sourceBytes)},
  generator:{path:"scripts/generate-brand-icons.ts",sha256:hash(generatorBytes)},
  recipe:source.recipe, palette:source.palette,
  toolchain:{sharp:sharp.versions.sharp,vips:sharp.versions.vips,rsvg:sharp.versions.rsvg},
  artifacts:[...artifacts].map(([path,data])=>({path,bytes:data.length,sha256:hash(data)})),
};
artifacts.set("brand/manifest.json",Buffer.from(`${JSON.stringify(manifest,null,2)}\n`));
if (check) {
  // Native raster libraries can produce different PNG bytes across platforms.
  // Verify the committed render's provenance, dimensions and exact hashes;
  // only path-only SVGs must equal a fresh render on every platform.
  const digest = z.string().regex(/^[a-f0-9]{64}$/u);
  const provenance = z.strictObject({path:z.string(),sha256:digest});
  const saved = z.strictObject({
    version:z.literal(1), identity:z.literal("Sys1"), inspiration:z.string(), origin:z.string(),
    source:provenance, generator:provenance,
    recipe:z.record(z.string(),z.number()), palette:z.record(z.string(),color),
    toolchain:z.strictObject({sharp:z.string(),vips:z.string(),rsvg:z.string()}),
    artifacts:z.array(z.strictObject({path:z.string(),bytes:z.number().int().nonnegative(),sha256:digest})),
  }).parse(JSON.parse(await readFile(resolve(root,"brand/manifest.json"),"utf8")));
  for (const field of ["inspiration","origin","source","generator","recipe","palette"] as const) {
    if(JSON.stringify(saved[field])!==JSON.stringify(manifest[field])) throw new Error(`Stale brand provenance: ${field}`);
  }
  if(JSON.stringify(saved.artifacts.map(x=>x.path))!==JSON.stringify(manifest.artifacts.map(x=>x.path))) throw new Error("Unexpected brand asset list");
  const committed = new Map<string,Buffer>();
  for (const asset of saved.artifacts) {
    const data = await readFile(resolve(root,asset.path));
    if(data.length!==asset.bytes || hash(data)!==asset.sha256) throw new Error(`Brand asset integrity failed: ${asset.path}`);
    if(asset.path.endsWith(".svg") && !data.equals(Buffer.from(artifacts.get(asset.path)!))) throw new Error(`Stale SVG: ${asset.path}`);
    committed.set(asset.path,data);
  }
  for (const [file,size] of [["icon.png",512],["apple-icon.png",180],["favicon-32.png",32],["favicon-16.png",16]] as const) {
    const metadata = await sharp(committed.get(`site/${file}`)!).metadata();
    if(metadata.format!=="png" || metadata.width!==size || metadata.height!==size) throw new Error(`Invalid icon dimensions: ${file}`);
  }
  console.log("Verified 9 Sys1 brand assets: source/generator provenance, SVG geometry, raster dimensions and committed hashes.");
  process.exit(0);
}
for (const [path,data] of artifacts) {
  const target=resolve(root,path);
  await mkdir(resolve(target,".."),{recursive:true});
  await writeFile(target,data);
}
console.log(`Generated ${artifacts.size} Sys1 brand assets; 16px and 32px mark geometry passed.`);
