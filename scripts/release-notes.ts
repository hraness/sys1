// Renders and verifies the GitHub Release page for one tag, following the
// Hraness release page standard: title "<Product> <tag>", then a summary and
// `## Changes` copied from CHANGELOG.md, generated `## Install` and `## Verify`,
// and the machine identity record as a trailing HTML comment.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PRODUCT_NAME = "Sys1";
export const IDENTITY_MARKER = "<!-- sys1-release ";
const IDENTITY_END = " -->";

const TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ASSET_NAME = /^[A-Za-z0-9_.-]+$/;

export interface ReleaseAsset {
  name: string;
  digest: string;
}

export interface ReleaseIdentity {
  schema: 1;
  repository: string;
  tag: string;
  commit: string;
  assets: ReleaseAsset[];
}

export interface ChangelogSection {
  summary: string;
  changes: string;
}

export interface ReleaseRecord {
  repository: string;
  tag: string;
  commit: string;
  /** Asset names and digests in upload order: the tarball, then SHA256SUMS. */
  assets: ReleaseAsset[];
  /** Minimum Bun version, from package.json engines. */
  bunVersion: string;
}

export class ReleaseNotesError extends Error {}

function fail(message: string): never {
  throw new ReleaseNotesError(message);
}

export function releaseTitle(tag: string): string {
  if (!TAG.test(tag)) fail(`release tag is not a stable version: ${tag}`);
  return `${PRODUCT_NAME} ${tag}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the summary and change bullets of the `## X.Y.Z` or `## vX.Y.Z`
 * section (optional ` - YYYY-MM-DD`). Fails when the section is missing,
 * duplicated, empty, lacks a summary or bullets, or says Unreleased.
 */
export function changelogSection(changelog: string, tag: string): ChangelogSection {
  if (!TAG.test(tag)) fail(`release tag is not a stable version: ${tag}`);
  const version = tag.slice(1);
  const heading = new RegExp(`^## v?${escapeRegExp(version)}(?: - [0-9]{4}-[0-9]{2}-[0-9]{2})?$`);
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const starts = lines.flatMap((line, index) => (heading.test(line.trimEnd()) ? [index] : []));
  if (starts.length === 0) fail(`CHANGELOG.md has no section for ${version}`);
  if (starts.length > 1) fail(`CHANGELOG.md has more than one section for ${version}`);
  const start = starts[0]!;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##? /.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).map((line) => line.trimEnd());
  const text = body.join("\n").trim();
  if (text === "") fail(`CHANGELOG.md section for ${version} is empty`);
  if (/\bunreleased\b/i.test(text)) fail(`CHANGELOG.md section for ${version} still says Unreleased`);
  const firstBullet = body.findIndex((line) => line.startsWith("- "));
  if (firstBullet === -1) fail(`CHANGELOG.md section for ${version} has no change bullets`);
  const summary = body.slice(0, firstBullet).join("\n").trim();
  const changes = body.slice(firstBullet).join("\n").trim();
  if (summary === "") fail(`CHANGELOG.md section for ${version} has no summary paragraph`);
  if (/^#/m.test(summary) || /^#/m.test(changes)) fail(`CHANGELOG.md section for ${version} contains a heading`);
  return { summary, changes };
}

function validateRecord(record: ReleaseRecord): void {
  if (!REPOSITORY.test(record.repository)) fail("release repository is invalid");
  if (!TAG.test(record.tag)) fail("release tag is invalid");
  if (!COMMIT.test(record.commit)) fail("release commit is not a full SHA-1");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(record.bunVersion)) fail("Bun version is invalid");
  const names = record.assets.map((asset) => asset.name);
  const tarballs = names.filter((name) => name.endsWith(".tgz"));
  if (record.assets.length !== 2 || tarballs.length !== 1 || !names.includes("SHA256SUMS")) {
    fail("release must carry one tarball and SHA256SUMS");
  }
  for (const asset of record.assets) {
    if (!ASSET_NAME.test(asset.name) || !DIGEST.test(asset.digest)) fail(`release asset is invalid: ${asset.name}`);
  }
}

export function releaseIdentity(record: ReleaseRecord): ReleaseIdentity {
  validateRecord(record);
  return {
    schema: 1,
    repository: record.repository,
    tag: record.tag,
    commit: record.commit,
    assets: record.assets.map(({ name, digest }) => ({ name, digest })),
  };
}

/** The visible page: summary, Changes, Install and Verify, without the identity record. */
export function renderNotes(section: ChangelogSection, record: ReleaseRecord): string {
  validateRecord(record);
  const tarball = record.assets.find((asset) => asset.name.endsWith(".tgz"))!;
  const base = `https://github.com/${record.repository}`;
  const url = `${base}/releases/download/${record.tag}/${tarball.name}`;
  return [
    section.summary,
    "",
    "## Changes",
    "",
    section.changes,
    "",
    "## Install",
    "",
    `Requires Bun ${record.bunVersion} or newer. Install this release's package file with npm:`,
    "",
    "```sh",
    "npm install --global --allow-scripts=node-llama-cpp \\",
    `  ${url}`,
    "```",
    "",
    "For an application that only calls a running gateway, skip the optional native runtime:",
    "",
    "```sh",
    `npm install --omit=optional ${url}`,
    "```",
    "",
    "## Verify",
    "",
    `\`SHA256SUMS\` on this release lists the SHA-256 of \`${tarball.name}\`, which is \`${tarball.digest.slice("sha256:".length)}\`. Download both files into one folder and run:`,
    "",
    "```sh",
    "shasum -a 256 -c SHA256SUMS",
    "```",
    "",
    `Built from commit [\`${record.commit}\`](${base}/commit/${record.commit}). [How releases are built and checked](${base}/blob/${record.tag}/README.md#releases).`,
  ].join("\n");
}

export function renderIdentity(identity: ReleaseIdentity): string {
  const json = JSON.stringify(identity);
  if (json.includes("--")) fail("identity record cannot be embedded in an HTML comment");
  return `${IDENTITY_MARKER}${json}${IDENTITY_END}`;
}

/** The complete release body. It ends with the identity comment and no newline. */
export function renderReleaseBody(section: ChangelogSection, record: ReleaseRecord): string {
  return `${renderNotes(section, record)}\n\n${renderIdentity(releaseIdentity(record))}`;
}

function parseIdentity(value: unknown): ReleaseIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("identity record is not an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "assets,commit,repository,schema,tag") fail("identity record has unexpected fields");
  if (record["schema"] !== 1) fail("identity record schema is unsupported");
  const { repository, tag, commit, assets } = record;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) fail("identity repository is invalid");
  if (typeof tag !== "string" || !TAG.test(tag)) fail("identity tag is invalid");
  if (typeof commit !== "string" || !COMMIT.test(commit)) fail("identity commit is invalid");
  if (!Array.isArray(assets)) fail("identity assets are invalid");
  const parsedAssets = assets.map((asset: unknown) => {
    if (asset === null || typeof asset !== "object" || Array.isArray(asset)) fail("identity asset is invalid");
    const entry = asset as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "digest,name") fail("identity asset has unexpected fields");
    const { name, digest } = entry;
    if (typeof name !== "string" || !ASSET_NAME.test(name)) fail("identity asset name is invalid");
    if (typeof digest !== "string" || !DIGEST.test(digest)) fail("identity asset digest is invalid");
    return { name, digest };
  });
  return { schema: 1, repository, tag, commit, assets: parsedAssets };
}

/**
 * Splits a release body into its visible notes and identity record. The
 * record is read from the last identity marker and must be the final bytes.
 */
export function parseReleaseBody(body: string): { notes: string; identity: ReleaseIdentity } {
  if (!body.endsWith("-->")) fail("release body does not end with the identity record");
  const start = body.lastIndexOf(IDENTITY_MARKER);
  if (start === -1) fail("release body has no identity record");
  if (!body.endsWith(IDENTITY_END)) fail("identity record is malformed");
  const json = body.slice(start + IDENTITY_MARKER.length, body.length - IDENTITY_END.length);
  if (json.includes("-->")) fail("identity record is malformed");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    fail("identity record is not JSON");
  }
  const before = body.slice(0, start);
  if (!before.endsWith("\n\n")) fail("identity record is not separated from the notes");
  return { notes: before.slice(0, -2), identity: parseIdentity(value) };
}

/** Fails unless the body is exactly the rendered notes plus the expected identity. */
export function verifyReleaseBody(body: string, section: ChangelogSection, record: ReleaseRecord): ReleaseIdentity {
  const expected = releaseIdentity(record);
  const { notes, identity } = parseReleaseBody(body);
  if (JSON.stringify(identity) !== JSON.stringify(expected)) fail("release identity record does not match the release");
  if (notes !== renderNotes(section, record)) fail("release notes differ from the rendered changelog and release record");
  if (body !== renderReleaseBody(section, record)) fail("release body is not in canonical form");
  return identity;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Reads the tarball and SHA256SUMS digests from a release artifact directory. */
export function artifactAssets(directory: string): ReleaseAsset[] {
  const names = readdirSync(directory).sort();
  const tarballs = names.filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1 || !names.includes("SHA256SUMS")) fail("artifact directory needs one tarball and SHA256SUMS");
  return [tarballs[0]!, "SHA256SUMS"].map((name) => ({ name, digest: sha256(join(directory, name)) }));
}

export function bunVersion(packageJson: unknown): string {
  const engines = (packageJson as { engines?: { bun?: unknown } } | null)?.engines;
  const range = engines?.bun;
  const match = typeof range === "string" ? /^>=([0-9]+\.[0-9]+\.[0-9]+)$/.exec(range) : null;
  if (match === null) fail("package.json engines.bun must be >=X.Y.Z");
  return match[1]!;
}

function flags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined || result.has(key)) fail("invalid arguments");
    result.set(key.slice(2), value);
  }
  return result;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined) fail(`--${key} is required`);
  return value;
}

const USAGE = `usage:
  release-notes.ts title TAG
  release-notes.ts check TAG [--changelog FILE]
  release-notes.ts render --tag TAG --commit SHA --repository OWNER/NAME --artifacts DIR [--changelog FILE] [--package FILE]
  release-notes.ts verify --body-file FILE --tag TAG --commit SHA --repository OWNER/NAME --artifacts DIR [--changelog FILE] [--package FILE]`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "title" && rest.length === 1) {
    process.stdout.write(`${releaseTitle(rest[0]!)}\n`);
    return;
  }
  if (command === "check" && rest.length >= 1) {
    const options = flags(rest.slice(1));
    changelogSection(readFileSync(options.get("changelog") ?? "CHANGELOG.md", "utf8"), rest[0]!);
    process.stderr.write(`CHANGELOG.md has a release section for ${rest[0]}\n`);
    return;
  }
  if (command === "render" || command === "verify") {
    const options = flags(rest);
    const tag = required(options, "tag");
    const section = changelogSection(readFileSync(options.get("changelog") ?? "CHANGELOG.md", "utf8"), tag);
    const record: ReleaseRecord = {
      repository: required(options, "repository"),
      tag,
      commit: required(options, "commit"),
      assets: artifactAssets(required(options, "artifacts")),
      bunVersion: bunVersion(JSON.parse(readFileSync(options.get("package") ?? "package.json", "utf8"))),
    };
    if (command === "render") {
      process.stdout.write(renderReleaseBody(section, record));
      return;
    }
    verifyReleaseBody(readFileSync(required(options, "body-file"), "utf8"), section, record);
    process.stderr.write(`release body for ${tag} matches CHANGELOG.md and the release record\n`);
    return;
  }
  fail(USAGE);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
