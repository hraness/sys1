import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactAssets,
  bunVersion,
  changelogSection,
  parseReleaseBody,
  PRODUCT_NAME,
  releaseTitle,
  renderIdentity,
  renderNotes,
  renderReleaseBody,
  verifyReleaseBody,
  type ReleaseRecord,
} from "../scripts/release-notes.ts";

const root = join(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

const CHANGELOG = `# Changelog

Intro text.

## 1.2.3 - 2026-09-26

Sys1 does a new thing.

- \`sys1 thing\` now prints the result.
- Limits are enforced.

## v1.2.2

Earlier release.

- Older change.
`;

const record: ReleaseRecord = {
  repository: "hraness/sys1",
  tag: "v1.2.3",
  commit: "0123456789abcdef0123456789abcdef01234567",
  assets: [
    { name: "hraness-sys1-1.2.3.tgz", digest: `sha256:${"a".repeat(64)}` },
    { name: "SHA256SUMS", digest: `sha256:${"b".repeat(64)}` },
  ],
  bunVersion: "1.3.14",
};

describe("changelog sections", () => {
  test("extracts the summary and bullets for a version, with or without v and date", () => {
    expect(changelogSection(CHANGELOG, "v1.2.3")).toEqual({
      summary: "Sys1 does a new thing.",
      changes: "- `sys1 thing` now prints the result.\n- Limits are enforced.",
    });
    expect(changelogSection(CHANGELOG, "v1.2.2")).toEqual({ summary: "Earlier release.", changes: "- Older change." });
  });

  test("fails when the section is missing", () => {
    expect(() => changelogSection(CHANGELOG, "v9.9.9")).toThrow("no section for 9.9.9");
  });

  test("fails when the section is empty", () => {
    expect(() => changelogSection("## 1.2.3\n\n\n## 1.2.2\n\nx\n\n- y\n", "v1.2.3")).toThrow("is empty");
  });

  test("fails when the section says Unreleased", () => {
    expect(() => changelogSection("## 1.2.3\n\nUnreleased.\n\n- y\n", "v1.2.3")).toThrow("Unreleased");
    expect(() => changelogSection("## Unreleased\n\nx\n\n- y\n", "v1.2.3")).toThrow("no section");
  });

  test("fails without a summary, without bullets, or with a duplicate section", () => {
    expect(() => changelogSection("## 1.2.3\n\n- y\n", "v1.2.3")).toThrow("no summary");
    expect(() => changelogSection("## 1.2.3\n\nOnly prose.\n", "v1.2.3")).toThrow("no change bullets");
    expect(() => changelogSection("## 1.2.3\n\nx\n\n- y\n\n## v1.2.3\n\nx\n\n- y\n", "v1.2.3")).toThrow("more than one");
  });

  test("the repository changelog has a complete section for the current package version", () => {
    const section = changelogSection(readFileSync(join(root, "CHANGELOG.md"), "utf8"), `v${packageJson.version}`);
    expect(section.summary.length).toBeGreaterThan(0);
    expect(section.changes.startsWith("- ")).toBe(true);
  });
});

describe("release page", () => {
  test("titles the page with the product name from the README and the tag", () => {
    expect(readFileSync(join(root, "README.md"), "utf8").split("\n")[0]).toBe(`# ${PRODUCT_NAME}`);
    expect(releaseTitle("v1.2.3")).toBe("Sys1 v1.2.3");
    expect(() => releaseTitle("latest")).toThrow();
  });

  test("renders summary, Changes, Install, Verify, then the identity record as the final bytes", () => {
    const body = renderReleaseBody(changelogSection(CHANGELOG, "v1.2.3"), record);
    const headings = body.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## Changes", "## Install", "## Verify"]);
    expect(body.startsWith("Sys1 does a new thing.\n\n## Changes\n\n- `sys1 thing`")).toBe(true);
    expect(body).toContain("https://github.com/hraness/sys1/releases/download/v1.2.3/hraness-sys1-1.2.3.tgz");
    expect(body).toContain("Requires Bun 1.3.14 or newer.");
    expect(body).toContain(`\`${"a".repeat(64)}\``);
    expect(body).toContain("shasum -a 256 -c SHA256SUMS");
    expect(body).toContain(`[\`${record.commit}\`](https://github.com/hraness/sys1/commit/${record.commit})`);
    expect(body).toContain("https://github.com/hraness/sys1/blob/v1.2.3/README.md#releases");
    expect(body).not.toMatch(/latest|What's Changed|Full Changelog|Generated with|Automated|Canonical GitHub release/i);
    expect(body.endsWith(" -->")).toBe(true);
    const visible = body.slice(0, body.lastIndexOf("<!--"));
    expect(visible).not.toContain(record.assets[1]!.digest);
    expect(body.split("<!--").length).toBe(2);
  });

  test("the identity record still parses and verifies", () => {
    const section = changelogSection(CHANGELOG, "v1.2.3");
    const body = renderReleaseBody(section, record);
    const parsed = parseReleaseBody(body);
    expect(parsed.identity).toEqual({ schema: 1, repository: record.repository, tag: record.tag, commit: record.commit, assets: record.assets });
    expect(parsed.notes).toBe(renderNotes(section, record));
    expect(verifyReleaseBody(body, section, record)).toEqual(parsed.identity);
  });

  test("reads the identity from the last marker", () => {
    const section = changelogSection(CHANGELOG, "v1.2.3");
    const identity = renderIdentity(parseReleaseBody(renderReleaseBody(section, record)).identity);
    const forged = identity.replace(record.commit, "f".repeat(40));
    const body = `${renderNotes(section, record)}\n\n${forged}\n\n${identity}`;
    expect(parseReleaseBody(body).identity.commit).toBe(record.commit);
    expect(() => verifyReleaseBody(body, section, record)).toThrow("release notes differ");
  });

  test("detects tampered notes, identity, and trailing bytes", () => {
    const section = changelogSection(CHANGELOG, "v1.2.3");
    const body = renderReleaseBody(section, record);
    expect(() => verifyReleaseBody(body.replace("prints the result", "prints results"), section, record)).toThrow("release notes differ");
    expect(() => verifyReleaseBody(body.replace(record.commit, "f".repeat(40)), section, record)).toThrow();
    expect(() => verifyReleaseBody(body.replace(`${"a".repeat(64)}"`, `${"c".repeat(64)}"`), section, record)).toThrow("identity record does not match");
    expect(() => verifyReleaseBody(`${body}\n`, section, record)).toThrow("does not end with the identity record");
    expect(() => verifyReleaseBody(renderNotes(section, record), section, record)).toThrow();
    expect(() => parseReleaseBody(body.replace('"schema":1', '"schema":2'))).toThrow("schema");
    expect(() => verifyReleaseBody(body, changelogSection(CHANGELOG, "v1.2.2"), { ...record, tag: "v1.2.2" })).toThrow();
  });

  test("reads asset digests from an artifact directory and Bun from engines", () => {
    const directory = mkdtempSync(join(tmpdir(), "sys1-release-notes-"));
    try {
      writeFileSync(join(directory, "hraness-sys1-1.2.3.tgz"), "tarball");
      writeFileSync(join(directory, "SHA256SUMS"), "sums");
      const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
      expect(artifactAssets(directory)).toEqual([
        { name: "hraness-sys1-1.2.3.tgz", digest: digest("tarball") },
        { name: "SHA256SUMS", digest: digest("sums") },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(bunVersion({ engines: { bun: ">=1.3.14" } })).toBe("1.3.14");
    expect(() => bunVersion({ engines: {} })).toThrow();
  });
});
