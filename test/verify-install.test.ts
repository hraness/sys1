import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installVerifySkill, VERIFY_SKILL } from "../src/verify/install.ts";
import { renderVerify, runVerifyCli, verifyExitCode } from "../src/verify/cli.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sys1-verify-install-"));
  scratch.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const init = Bun.spawn(["git", "init", "--quiet", repo], { stdout: "ignore", stderr: "pipe" });
  expect(await init.exited).toBe(0);
  return { root, repo: await realpath(repo), home: join(root, "home") };
}

describe("project verify skill", () => {
  test("CLI preview writes nothing and supported targets install idempotently", async () => {
    const { repo, home } = await fixture();
    const paths: Record<string, string> = {
      codex: ".agents/skills/sys1-verify/SKILL.md",
      "claude-code": ".claude/skills/sys1-verify/SKILL.md",
      devin: ".devin/skills/sys1-verify/SKILL.md",
    };
    for (const [target, path] of Object.entries(paths)) {
      const preview = await runVerifyCli(["--json", "setup", target, "--dry-run"], home, repo);
      expect(preview).toMatchObject({ command: "setup", status: "planned", path, target });
      expect(existsSync(join(repo, path.split("/")[0]!))).toBe(false);
      const installed = await runVerifyCli(["setup", target], home, repo);
      expect(installed).toMatchObject({ status: "created", path });
      expect(readFileSync(join(repo, path), "utf8")).toBe(VERIFY_SKILL);
      expect(await runVerifyCli(["setup", target], home, repo)).toMatchObject({ status: "unchanged" });
      expect(verifyExitCode(installed)).toBe(0);
      expect(renderVerify(installed)).toContain(path);
    }
    expect(existsSync(home)).toBe(false);
    for (const path of [".claude/settings.json", ".devin/hooks.v1.json", ".devin/config.json"]) {
      expect(existsSync(join(repo, path))).toBe(false);
    }
  });

  test("preserves user edits and refuses linked destinations", async () => {
    const { root, repo } = await fixture();
    const result = await installVerifySkill({ repoRoot: repo, target: "codex" });
    const destination = join(repo, result.path);
    writeFileSync(destination, "my project instructions\n");
    for (const dryRun of [true, false]) {
      await expect(installVerifySkill({ repoRoot: repo, target: "codex", dryRun })).rejects.toThrow("different content");
    }
    expect(readFileSync(destination, "utf8")).toBe("my project instructions\n");
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".claude"), process.platform === "win32" ? "junction" : "dir");
    await expect(installVerifySkill({ repoRoot: repo, target: "claude-code" })).rejects.toThrow("link");
    expect(existsSync(join(outside, "skills"))).toBe(false);
  });

  test("setup rejects unknown targets and options before writing", async () => {
    const { repo, home } = await fixture();
    for (const args of [
      ["setup"], ["setup", "toString"], ["setup", "../outside"], ["setup", "codex", "extra"],
      ["setup", "codex", "--model", "fake/model"], ["setup", "codex", "--unknown"],
      ["setup", "codex", "--dry-run=true"], ["setup", "codex", "--dry-run", "--dry-run"],
      ["setup", "codex", "--message", "private.txt"],
    ]) await expect(runVerifyCli(args, home, repo)).rejects.toThrow();
    expect(existsSync(join(repo, ".agents"))).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  test("existing message evaluation still supports a file named setup", async () => {
    const { repo, home } = await fixture();
    const message = join(repo, "setup");
    writeFileSync(message, "The work is complete.");
    const result = await runVerifyCli(["--message", message, "--model", "fake/model", "--dry-run"], home, repo);
    expect(result).toMatchObject({ status: "planned", message_source: "file", requests: 0 });
    expect(existsSync(home)).toBe(false);
  });
});
