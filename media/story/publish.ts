/**
 * Publishes the delivered story film into site/media and records its exact
 * identities in media/sys1-launch/site-media.ts and receipts/provenance.json.
 * Then run `bun scripts/sync-launch-media.ts --write`.
 *   bun publish.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir, repo = join(here, "../..");
const out = (name: string) => join(here, "out", name);
const site = (name: string) => join(repo, "site/media", name);
copyFileSync(out("sys1-launch-1080p.mp4"), site("sys1-launch.mp4"));
copyFileSync(out("sys1-launch-1x1.mp4"), site("sys1-launch-square.mp4"));
copyFileSync(out("sys1-launch-poster.jpg"), site("sys1-launch-poster.jpg"));
copyFileSync(out("sys1-launch-social.jpg"), site("sys1-launch-share.jpg"));
copyFileSync(out("sys1-launch.en.vtt"), site("sys1-launch.vtt"));
// The visual transcript: every on-screen line, in order, from the caption cues.
const vtt = readFileSync(site("sys1-launch.vtt"), "utf8");
const cues = [...vtt.matchAll(/(\d{2}:\d{2}:\d{2})\.\d{3} --> [^\n]+\n([\s\S]*?)(?:\n\n|\n?$)/gu)].map((m) => `[${m[1]}] ${m[2]!.trim().replaceAll("\n", " / ")}`);
writeFileSync(site("sys1-launch-transcript.txt"), `Introducing Sys1: visual transcript\n\nThe film has no narration or sound. Every on-screen line follows, in order.\n\n${cues.join("\n")}\n`);
const timeline = JSON.parse(readFileSync(join(here, "build/timeline.json"), "utf8")) as { seconds: number };
const id = (path: string) => { const bytes = readFileSync(path); return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }; };
const seconds = Math.round(timeline.seconds);
const created = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
const assets = {
  video: { path: "site/media/sys1-launch.mp4", ...id(site("sys1-launch.mp4")), width: 1920, height: 1080, durationSeconds: seconds },
  poster: { path: "site/media/sys1-launch-poster.jpg", ...id(site("sys1-launch-poster.jpg")), width: 1920, height: 1080 },
  social: { path: "site/media/sys1-launch-share.jpg", ...id(site("sys1-launch-share.jpg")), width: 1200, height: 630 },
  captions: { path: "site/media/sys1-launch.vtt", ...id(site("sys1-launch.vtt")) },
  transcript: { path: "site/media/sys1-launch-transcript.txt", ...id(site("sys1-launch-transcript.txt")) },
};
const sources = ["story.config.ts", "story.html", "build.ts", "render.ts", "deliver.sh"].map((file) => ({ path: `media/story/${file}`, ...id(join(here, file)) }));
const ffmpeg = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split(" ")[2];
writeFileSync(join(repo, "media/sys1-launch/receipts/provenance.json"), `${JSON.stringify({
  schemaVersion: 1, createdAt: created, title: "Introducing Sys1", assets,
  toolchain: { engine: "story-film 1.0.0", renderer: "playwright-core 1.58.2 Chromium", ffmpeg, bun: Bun.version },
  authoredSources: sources,
}, null, 2)}\n`);
const mediaFile = join(repo, "media/sys1-launch/site-media.ts");
let ts = readFileSync(mediaFile, "utf8");
const set = (key: "poster" | "social" | "captions" | "transcript" | "video", value: { bytes: number; sha256: string }) => {
  ts = ts.replace(new RegExp(`(  ${key}: \\{[\\s\\S]*?bytes: )\\d+(, sha256: ")[0-9a-f]{64}(")`, "u"), `$1${value.bytes}$2${value.sha256}$3`);
};
for (const key of ["poster", "social", "video", "captions", "transcript"] as const) set(key, assets[key]);
ts = ts.replace(/durationSeconds: \d+,/u, `durationSeconds: ${seconds},`)
  .replace(/  published: "[^"]+",/u, `  published: "${created}",`)
  .replace(/  description: "[^"]+",/u, `  description: "A ${seconds}-second introduction to Sys1: a coding agent's completion claim, each claim checked against Git, pull requests and live pages, the compact-output skill, and how to ask your agent to install Sys1. English captions and a visual transcript accompany the film.",`)
  .replace(/  credit: "[^"]+",/u, `  credit: "Original motion graphics, rendered for Sys1 with the Hraness story-film engine.",`)
  .replace(/reviewedBy: "[^"]+"/u, `reviewedBy: "Devin launch-film agent: contact-sheet review of every act and the delivered frames; not an independent review. Scope in receipts/review.json"`);
writeFileSync(mediaFile, ts);
console.log(JSON.stringify({ seconds, created, video: assets.video.bytes }));
