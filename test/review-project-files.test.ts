import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectFile } from "../src/review/project-files.ts";
import { runRulesCli } from "../src/audit/rules-cli.ts";

const scratch: string[] = [];
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sys1-review-files-"));
  scratch.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  // Match production's canonical root API; Windows sync/native spellings can differ.
  return { root, repo: await realpath(repo), home: join(root, "home") };
}

describe("bounded project files", () => {
  test("caps UTF-8 bytes before creating directories and admits the exact boundary", async () => {
    const { repo } = await fixture();
    await expect(writeProjectFile(repo, "new/oversized.txt", "é".repeat(32_769), false)).rejects.toThrow("size limit");
    expect(existsSync(join(repo, "new"))).toBe(false);
    const text = "é".repeat(32_768);
    expect(await writeProjectFile(repo, "exact.txt", text, false)).toBe("created");
    expect(await writeProjectFile(repo, "exact.txt", text, false)).toBe("unchanged");
    expect(readFileSync(join(repo, "exact.txt"), "utf8")).toBe(text);
  });

  test("rejects final file symlinks and hardlinks without changing either target", async () => {
    const { root, repo } = await fixture();
    const target = join(root, "owned.txt"); writeFileSync(target, "keep this\n");
    // File symlink creation needs a Windows privilege; hardlink coverage runs everywhere.
    if (process.platform !== "win32") {
      symlinkSync(target, join(repo, "linked.txt"));
      await expect(writeProjectFile(repo, "linked.txt", "replacement", false)).rejects.toThrow("regular file");
      await expect(writeProjectFile(repo, "linked.txt", "replacement", true)).rejects.toThrow("regular file");
    }
    linkSync(target, join(repo, "hardlinked.txt"));
    await expect(writeProjectFile(repo, "hardlinked.txt", "replacement", false)).rejects.toThrow("regular file");
    expect(readFileSync(target, "utf8")).toBe("keep this\n");
    expect(readFileSync(join(repo, "hardlinked.txt"), "utf8")).toBe("keep this\n");
  });

  test("rejects traversal and non-directory parents without adding files", async () => {
    const { root, repo } = await fixture();
    for (const path of ["../outside", "a/../outside", "a/./file", "a//file", "a\0file"]) {
      await expect(writeProjectFile(repo, path, "content", false)).rejects.toThrow("destination");
    }
    writeFileSync(join(repo, "file"), "keep this\n");
    await expect(writeProjectFile(repo, "file/child", "content", false)).rejects.toThrow("non-directory");
    expect(readFileSync(join(repo, "file"), "utf8")).toBe("keep this\n");
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  test("rule provenance quotes stay data and oversized names remain inert", async () => {
    const { repo, home } = await fixture();
    const source = 'docs/the "quoted" guide.md';
    const flags = ["--ensure", "Errors remain visible.", "--breaks", "Errors disappear.", "--source", source, "--path", "src/**/*.ts"];
    await expect(runRulesCli(["draft", "a".repeat(65), ...flags], home, repo)).rejects.toThrow("kebab-case");
    expect(existsSync(join(repo, ".sys1"))).toBe(false);
    await runRulesCli(["draft", "quoted-guide", ...flags], home, repo);
    const pack = JSON.parse(readFileSync(join(repo, ".sys1/drafts/quoted-guide/pack.yaml"), "utf8"));
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0].source).toEqual({ kind: "guide", file: source });
    expect(await runRulesCli(["check", ".sys1/drafts/quoted-guide"], home, repo)).toMatchObject({ valid: true, requests: 0 });
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(repo, ".sys1/rules"))).toBe(false);
  });
});
