import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installReviewSkill, REVIEW_SKILL } from "../src/review/install.ts";
import { runRulesCli } from "../src/audit/rules-cli.ts";
import { loadPacks, packRoots } from "../src/audit/pack.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sys1-review-install-"));
  scratch.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  // Match production's canonical root API; Windows sync/native spellings can differ.
  return { root, repo: await realpath(repo), home };
}
describe("project review skill", () => {
  test("preview leaves no directories; setup is idempotent for supported targets", async () => {
    const { repo, home } = await fixture();
    for (const target of ["codex", "claude-code"]) {
      const preview = await installReviewSkill({ repoRoot: repo, target, dryRun: true });
      expect(preview.status).toBe("planned");
      expect(existsSync(join(repo, preview.path))).toBe(false);
      const first = await installReviewSkill({ repoRoot: repo, target });
      expect(first.status).toBe("created");
      expect(readFileSync(join(repo, first.path), "utf8")).toBe(REVIEW_SKILL);
      expect((await installReviewSkill({ repoRoot: repo, target })).status).toBe("unchanged");
    }
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
  });
  test("preserves edited skill and rejects symlink parent or destination", async () => {
    const { repo, root } = await fixture();
    const result = await installReviewSkill({ repoRoot: repo, target: "codex" });
    const destination = join(repo, result.path);
    writeFileSync(destination, "user-maintained instructions\n");
    await expect(installReviewSkill({ repoRoot: repo, target: "codex" })).rejects.toThrow("different content");
    expect(readFileSync(destination, "utf8")).toBe("user-maintained instructions\n");
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".claude"), process.platform === "win32" ? "junction" : "dir");
    await expect(installReviewSkill({ repoRoot: repo, target: "claude-code" })).rejects.toThrow("link");
    expect(existsSync(join(outside, "skills"))).toBe(false);
  });
  test("unknown targets do not produce files", async () => {
    const { repo } = await fixture();
    await expect(installReviewSkill({ repoRoot: repo, target: "toString" })).rejects.toThrow();
    await expect(installReviewSkill({ repoRoot: repo, target: "../outside" })).rejects.toThrow();
  });
});

describe("repository rule authoring", () => {
  const draft = ["draft", "await-success", "--ensure", "Required storage succeeds before reporting success.", "--breaks", "The change reports success while required storage can still fail.", "--source", "AGENTS.md", "--path", "src/**/*.ts"];
  test("draft validates but stays inactive until explicitly moved", async () => {
    const { repo, home } = await fixture();
    const preview = await runRulesCli([...draft, "--dry-run"], home, repo);
    expect(preview).toMatchObject({ status: "planned", active: false, requests: 0 });
    expect(existsSync(join(repo, ".sys1"))).toBe(false);
    const created = await runRulesCli(draft, home, repo);
    expect(created).toMatchObject({ status: "created", active: false });
    expect((await loadPacks(packRoots({ repoRoot: repo }))).rules).toHaveLength(0);
    expect(await runRulesCli(["check", ".sys1/drafts/await-success"], home, repo)).toMatchObject({ valid: true, requests: 0 });
    expect(await runRulesCli(draft, home, repo)).toMatchObject({ status: "unchanged" });
  });
  test("quoted and multiline guide prose cannot inject another rule", async () => {
    const { repo, home } = await fixture();
    const modified = [...draft];
    modified[3] = "Keep 'truth': true\nrules: [injected]\n in documentation examples.";
    await runRulesCli(modified, home, repo);
    const result = await runRulesCli(["check", ".sys1/drafts/await-success"], home, repo);
    expect(result).toMatchObject({ valid: true });
    expect(result.rules).toHaveLength(1);
  });
  test("rejects unknown, duplicate, conflicting and oversized options", async () => {
    const { repo, home } = await fixture();
    for (const args of [
      ["draft", "../escape"], ["draft", "missing-prose"],
      [...draft, "--ensure", "second"], [...draft, "--enable"],
      ["check", "missing", "--dry-run"], ["list", "--source", "AGENTS.md"],
      ["list", "unexpected"], [...draft.slice(0, 3), "x".repeat(5000), ...draft.slice(4)],
    ]) await expect(runRulesCli(args, home, repo)).rejects.toThrow();
    expect(existsSync(join(repo, ".sys1"))).toBe(false);
  });
});
