#!/usr/bin/env bun
// Renders the launch beats, homepage mockups and social kit into the static
// site from one source: scripts/launch/{facts,beats,mockups}. Pages keep their
// hand-written HTML; only the text between the launch markers is generated.
//
//   bun scripts/launch/build.tsx --write   regenerate
//   bun scripts/launch/build.tsx --check   fail when a generated region is stale
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLaunchBeats, assertLaunchKit, buildSocialKit, LAUNCH_LIMITS, type LaunchBeat, type SocialKit } from "@hraness/design-kit/launch";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolvedBeats } from "./beats.ts";
import { CANONICAL_URL, launchFacts, launchMessaging, launchRelease } from "./facts.ts";
import { LaunchMockup, type LaunchMockupId } from "./mockups.tsx";

const root = resolve(import.meta.dir, "../..");
const kitRoot = resolve(root, "node_modules/@hraness/design-kit");
const kitVersion = (JSON.parse(readFileSync(resolve(kitRoot, "package.json"), "utf8")) as { version: string }).version;

export const socialKit: SocialKit = buildSocialKit(resolvedBeats, launchMessaging, launchRelease, CANONICAL_URL);
assertLaunchKit(resolvedBeats, socialKit, {
  status: launchRelease.status,
  publicInstall: true,
  tagline: launchMessaging.tagline,
  canonicalUrl: CANONICAL_URL,
  forbiddenNames: ["gstack", "pstack", "Superpowers", "RTK"],
});

function Scorecard(): ReactElement {
  const { compactPairs, pairs, reviewCorrectRequired, reviewCorrectWithout } = launchFacts;
  return (
    <div className="launch-scorecard">
      <table>
        <caption>Whole-task tests, September 2026</caption>
        <thead><tr><th scope="col">Skill</th><th scope="col">Tasks</th><th scope="col">What happened</th></tr></thead>
        <tbody>
          <tr><th scope="row">Review, available</th><td>{pairs.value}</td><td>Never called. No change.</td></tr>
          <tr><th scope="row">Review, required</th><td>{pairs.value}</td><td>More tokens and time; {reviewCorrectRequired.value} of {pairs.value} correct against {reviewCorrectWithout.value} without it.</td></tr>
          <tr><th scope="row">Compact check output</th><td>{compactPairs.value}</td><td>Never called. No token or time change.</td></tr>
        </tbody>
      </table>
      <p>Source: <code>docs/proof-roadmap-2026-09.md</code>. The next step is accuracy on real inputs.</p>
    </div>
  );
}

function renderVisual(beat: LaunchBeat): ReactElement {
  switch (beat.visual.kind) {
    case "mockup":
      return <LaunchMockup id={beat.visual.id as LaunchMockupId} />;
    case "clip":
      return <img alt="" decoding="async" height={720} loading="lazy" src={`/media/launch/beat-${beat.id}.jpg`} width={1280} />;
    case "diagram":
      return <Scorecard />;
  }
}

// Same structure as design-kit's <LaunchBeats> (react entry), which needs the
// private @hraness/ui peer; this public repository must build without it.
function launchBeatAnchor(beat: Pick<LaunchBeat, "id">): string {
  return `beat-${beat.id}`;
}

const figureKind = { mockup: "illustration", clip: "recording", diagram: "diagram" } as const;
const figureLabel = { mockup: "Illustration", clip: "Film still", diagram: "Chart" } as const;

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function LaunchBeats({ beats }: Readonly<{ beats: readonly LaunchBeat[] }>): ReactElement {
  assertLaunchBeats(beats);
  return (
    <div className="launch-beats" data-hraness-launch-beats="">
      {beats.map((beat) => {
        const anchor = launchBeatAnchor(beat);
        return (
          <section aria-labelledby={`${anchor}-heading`} className="launch-beat" data-part={beat.part} id={anchor} key={beat.id}>
            <h3 id={`${anchor}-heading`}>{beat.headline}</h3>
            <p>{beat.post}</p>
            <figure className="launch-beat-figure" data-figure-kind={figureKind[beat.visual.kind]}>
              <div className="launch-beat-visual">{renderVisual(beat)}</div>
              <figcaption><span className="launch-beat-kind">{figureLabel[beat.visual.kind]}.</span> {sentenceCase(beat.alt.replace(/^Illustration: /u, ""))}</figcaption>
            </figure>
            {beat.detailHref === undefined ? null : (
              <p className="launch-beat-detail"><a href={beat.detailHref}>More on this</a></p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function markup(element: ReactElement): string {
  const html = renderToStaticMarkup(element);
  // The site's CSP is style-src 'self'; inline style attributes would be dropped.
  if (/\sstyle="/u.test(html)) throw new Error("Generated launch markup must not carry inline styles.");
  return html;
}

function region(file: string, name: string, body: string): { path: string; next: string; current: string } {
  const path = resolve(root, file);
  const current = readFileSync(path, "utf8");
  const start = `<!-- launch:${name}:start (generated by scripts/launch/build.tsx) -->`;
  const end = `<!-- launch:${name}:end -->`;
  const from = current.indexOf(start);
  const to = current.indexOf(end);
  if (from < 0 || to < from) throw new Error(`${file} is missing the ${name} launch markers.`);
  return { path, current, next: `${current.slice(0, from + start.length)}\n${body}\n${current.slice(to)}` };
}

function kitSection(kit: SocialKit): string {
  const esc = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const list = (label: string, posts: readonly string[]) =>
    `<h3>${label}</h3><ol>${posts.map((post) => `<li><pre>${esc(post)}</pre></li>`).join("")}</ol>`;
  return [
    `<details class="launch-social-kit" id="social-kit"><summary>Social kit: posts cut from this article</summary>`,
    `<p>Each post is one section above, sized for its channel and linking back here. The full kit, with the fact sheet for Show HN and Product Hunt, is <a href="https://github.com/hraness/sys1/blob/main/kb/launch/social-kit.md">in the repository</a>.</p>`,
    list(`X thread (${kit.x.length} posts)`, kit.x),
    list(`Bluesky thread (${kit.bluesky.length} posts)`, kit.bluesky),
    list(`Threads (${kit.threads.length} posts)`, kit.threads),
    `<h3>LinkedIn</h3><pre>${esc(kit.linkedin)}</pre>`,
    `</details>`,
  ].join("");
}

function kitMarkdown(kit: SocialKit): string {
  const thread = (title: string, posts: readonly string[], limit: number) =>
    [`## ${title}`, "", `Limit: ${limit} characters a post.`, "", ...posts.flatMap((post, index) => [`### ${index + 1} of ${posts.length}`, "", "```text", post, "```", ""])].join("\n");
  return [
    "# Sys1 launch social kit",
    "",
    "Generated by `bun scripts/launch/build.tsx --write` from `scripts/launch/beats.ts` and",
    "`scripts/launch/facts.ts`. Do not edit by hand; change the beats and regenerate.",
    `Canonical post: ${CANONICAL_URL}. Every post links to its section as \`#beat-<id>\`.`,
    "",
    thread("X", kit.x, LAUNCH_LIMITS.x),
    thread("Bluesky", kit.bluesky, LAUNCH_LIMITS.bluesky),
    thread("Threads", kit.threads, LAUNCH_LIMITS.threads),
    "## LinkedIn",
    "",
    "```text",
    kit.linkedin,
    "```",
    "",
    "## Product Hunt",
    "",
    `- Tagline: ${kit.productHunt.tagline}`,
    `- Tags: ${kit.productHunt.tags.join(", ")}`,
    "",
    "```text",
    kit.productHunt.description,
    "```",
    "",
    "## Fact sheet for Show HN and a first comment",
    "",
    "Write the Show HN post and first comment yourself; use only these facts.",
    "",
    ...kit.showHnFacts.map((fact) => `- ${fact}`),
    "",
    "## Media",
    "",
    "- Landscape film (52 s, captions): https://sys1.io/media/sys1-launch.mp4",
    "- Square cut for feeds: https://sys1.io/media/sys1-launch-square.mp4",
    "- Captions: https://sys1.io/media/sys1-launch.vtt",
    "",
    "## Sources",
    "",
    ...Object.entries(kit.sources).map(([key, source]) => `- \`${key}\`: ${source}`),
    "",
  ].join("\n");
}

const beatsHtml = markup(<LaunchBeats beats={resolvedBeats} />);
const beatNav = resolvedBeats.map((beat) => `<li><a href="#${launchBeatAnchor(beat)}">${beat.headline}</a></li>`).join("");

const homeHtml = markup(
  <div className="launch-home-mockups">
    <figure className="launch-home-figure"><LaunchMockup id="agent-review" /><figcaption>Illustration: an agent reviews its own change with <code>sys1-review</code>.</figcaption></figure>
    <figure className="launch-home-figure"><LaunchMockup id="verify" /><figcaption>Illustration: <code>sys1 verify</code> catches a push that never happened.</figcaption></figure>
  </div>,
);

const mockupsCss = readFileSync(resolve(kitRoot, "src/mockups.css"), "utf8");
const provenance = `${JSON.stringify(
  {
    source: "@hraness/design-kit/mockups.css",
    version: kitVersion,
    sha256: createHash("sha256").update(mockupsCss).digest("hex"),
    note: "Unmodified copy. Regenerate with bun scripts/launch/build.tsx --write after a design-kit bump.",
  },
  null,
  2,
)}\n`;

const outputs: { path: string; current: string; next: string }[] = [
  region("site/introducing-sys1.html", "beats", `${`<h2 id="short-version">The short version</h2><p class="launch-short-intro">Nine short pieces, one idea each. Each one is also a post in the launch thread.</p><nav class="launch-beats-nav" aria-label="The short version"><ol>${beatNav}</ol></nav>`}\n${beatsHtml}\n${kitSection(socialKit)}`),
  region("site/index.html", "mockups", homeHtml),
];
for (const [file, next] of [
  ["kb/launch/social-kit.md", kitMarkdown(socialKit)],
  ["site/vendor/hraness-mockups/mockups.css", mockupsCss],
  ["site/vendor/hraness-mockups/provenance.json", provenance],
] as const) {
  const path = resolve(root, file);
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  outputs.push({ path, current, next });
}

const mode = process.argv[2];
if (mode === "--write") {
  for (const output of outputs) if (output.current !== output.next) writeFileSync(output.path, output.next);
  console.log(`Launch assets written (${outputs.length} files).`);
} else if (mode === "--check") {
  const stale = outputs.filter((output) => output.current !== output.next).map((output) => output.path.slice(root.length + 1));
  if (stale.length > 0) {
    console.error(`Launch assets are stale: ${stale.join(", ")}. Run bun scripts/launch/build.tsx --write.`);
    process.exit(1);
  }
  console.log("Launch assets are current.");
} else if (import.meta.main) {
  console.error("Usage: bun scripts/launch/build.tsx --write|--check");
  process.exit(2);
}
