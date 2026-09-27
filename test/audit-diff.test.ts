import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { collectDiff, DiffError } from "../src/audit/diff.ts";

const repositories: string[] = [];
const gitTimeoutMs = 5_000;
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runGit(cwd: string, ...args: string[]): Bun.ReadableSyncSubprocess {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return Bun.spawnSync(["git", "-c", "user.name=Audit Test", "-c", "user.email=audit@example.invalid", ...args], {
    // An absent ordinary file suppresses global config without Windows device-path handling.
    cwd, env: { ...env, GIT_CONFIG_GLOBAL: join(cwd, ".git", "fixture-global.gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: gitTimeoutMs, killSignal: "SIGKILL",
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = runGit(cwd, ...args);
  if (!result.success) throw new Error(`git ${args[0]} failed${result.exitedDueToTimeout ? " (timeout)" : ""}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function repo(files: Record<string, string | Uint8Array> = {}, committed = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sys1-audit-diff-"));
  repositories.push(root);
  git(root, "init", "--quiet");
  for (const [path, text] of Object.entries(files)) await write(root, path, text);
  if (committed) {
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "--allow-empty", "-m", "Initial fixture");
  }
  return root;
}

async function write(root: string, path: string, text: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`);
const errorCode = async (run: Promise<unknown>): Promise<string> => {
  try { await run; } catch (error) { if (error instanceof DiffError) return error.code; throw error; }
  throw new Error("expected DiffError");
};

describe("Git audit evidence", () => {
  test("retains removed assertions and coalesces overlapping context into stable units", async () => {
    const original = lines(100);
    original[39] = "assert(account.ownerId === caller.id);";
    const root = await repo({ "src/access.ts": `${original.join("\n")}\n` });
    const updated = [...original];
    updated.splice(39, 1);
    updated[44] = "return account;";
    await write(root, "src/access.ts", `${updated.join("\n")}\n`);
    const result = await collectDiff({ cwd: root, mode: "worktree" });
    expect(result.complete).toBe(true);
    expect(result.changedFiles).toBe(1);
    expect(result.units).toHaveLength(1);
    const unit = result.units[0]!;
    expect(unit.patch).toContain("-assert(account.ownerId === caller.id);");
    expect(unit.patch).toContain("+return account;");
    expect(unit.patch).toContain(" const line25 = 25;");
    expect(unit.oldRange).toEqual({ start: 25, count: 37 });
    expect(unit.newRange).toEqual({ start: 25, count: 36 });
    expect(unit.language).toBe("typescript");
    expect(unit.kind).toBe("modified");
    expect(unit.state).not.toContain(root);
    expect(unit.id).toMatch(/^[a-f0-9]{64}$/);
    expect((await collectDiff({ cwd: root, mode: "worktree" })).units[0]?.id).toBe(unit.id);
  });

  test("deletion-only changes retain the entire removed evidence, including an empty file", async () => {
    const root = await repo({ "guard.ts": "assert(authorized);\nperformWrite();\n", "empty.ts": "" });
    await rm(join(root, "guard.ts"));
    await rm(join(root, "empty.ts"));
    const result = await collectDiff({ cwd: root, mode: "worktree" });
    expect(result.complete).toBe(true);
    expect(result.units).toHaveLength(2);
    const guard = result.units.find((unit) => unit.path === "guard.ts")!;
    expect(guard.kind).toBe("deleted");
    expect(guard.patch).toContain("-assert(authorized);");
    expect(guard.patch).toContain("+++ /dev/null");
    expect(guard.oldRange).toEqual({ start: 1, count: 2 });
    expect(guard.newRange).toEqual({ start: 0, count: 0 });
    expect(result.units.find((unit) => unit.path === "empty.ts")?.kind).toBe("deleted");
  });

  test("staged mode reviews index bytes rather than different unstaged bytes", async () => {
    const root = await repo({ "a.ts": "const value = 'before';\n" });
    await write(root, "a.ts", "const value = 'staged';\n");
    git(root, "add", "a.ts");
    await write(root, "a.ts", "const value = 'unstaged';\n");
    const staged = await collectDiff({ cwd: root, mode: "staged" });
    const worktree = await collectDiff({ cwd: root, mode: "worktree" });
    expect(staged.units[0]?.patch).toContain("+const value = 'staged';");
    expect(staged.units[0]?.patch).not.toContain("unstaged");
    expect(worktree.units[0]?.patch).toContain("+const value = 'unstaged';");
    expect(staged.units[0]?.id).not.toBe(worktree.units[0]?.id);
  });

  test("an index deletion plus a recreated worktree path cannot silently lose before evidence", async () => {
    const root = await repo({ "guard.ts": "assert(authorized);\nperformWrite();\n" });
    git(root, "rm", "--quiet", "guard.ts");
    await write(root, "guard.ts", "performWrite();\n");
    const worktree = await collectDiff({ cwd: root, mode: "worktree" });
    expect(worktree.complete).toBe(false);
    expect(worktree.changedFiles).toBe(1);
    expect(worktree.units).toHaveLength(0);
    expect(worktree.skipped).toEqual([{ path: "guard.ts", reason: "index_worktree_conflict" }]);
    const staged = await collectDiff({ cwd: root, mode: "staged" });
    expect(staged.complete).toBe(true);
    expect(staged.units[0]?.patch).toContain("-assert(authorized);");
    await write(root, ".gitignore", "guard.ts\n");
    expect((await collectDiff({ cwd: root, mode: "worktree", paths: ["guard.ts"] })).skipped).toEqual([
      { path: "guard.ts", reason: "index_worktree_conflict" },
    ]);
  });

  test("since compares the resolved commit to HEAD and ignores later working changes", async () => {
    const root = await repo({ "a.ts": "before\n" });
    const base = git(root, "rev-parse", "HEAD");
    await write(root, "a.ts", "committed\n");
    git(root, "add", "a.ts");
    git(root, "commit", "--quiet", "-m", "Changed fixture");
    const head = git(root, "rev-parse", "HEAD");
    await write(root, "a.ts", "unstaged\n");
    await write(root, "untracked.ts", "untracked\n");
    const result = await collectDiff({ cwd: root, mode: "since", since: "HEAD~1" });
    expect(result.base).toBe(base);
    expect(result.head).toBe(head);
    expect(result.changedFiles).toBe(1);
    expect(result.units[0]?.patch).toContain("+committed");
    expect(result.units[0]?.patch).not.toContain("unstaged");
    expect(await errorCode(collectDiff({ cwd: root, mode: "since", since: "--output=/tmp/injected" }))).toBe("invalid_ref");
    expect(await errorCode(collectDiff({ cwd: root, mode: "since", since: "HEAD\0bad" }))).toBe("invalid_options");
  });

  test("unborn and empty repositories work without writing an empty-tree object", async () => {
    const root = await repo({}, false);
    const empty = await collectDiff({ cwd: root, mode: "worktree" });
    expect(empty).toMatchObject({ base: null, head: null, units: [], skipped: [], changedFiles: 0, complete: true });
    await write(root, "first.ts", "first\n");
    expect((await collectDiff({ cwd: root, mode: "staged" })).units).toHaveLength(0);
    expect((await collectDiff({ cwd: root, mode: "worktree" })).units[0]?.kind).toBe("added");
    git(root, "add", "first.ts");
    expect((await collectDiff({ cwd: root, mode: "staged" })).units[0]?.patch).toContain("+first");
    await write(root, "first.ts", "working\n");
    expect((await collectDiff({ cwd: root, mode: "worktree" })).units[0]?.patch).toContain("+working");
  });

  test("zero-delimited paths handle spaces, Unicode, and platform-valid option-like names", async () => {
    const root = await repo();
    const names = ["src/hello world ü.ts", "--output=bad.ts"];
    if (process.platform !== "win32") names.push("src/line\nbreak.ts", ":(top)literal.ts");
    for (const name of names) await write(root, name, `export const added = true;\n`);
    const result = await collectDiff({ cwd: root, mode: "worktree" });
    expect(result.complete).toBe(true);
    expect(result.units.map((unit) => unit.path).sort()).toEqual(names.sort());
    for (const unit of result.units) expect(unit.patch).toContain("+export const added = true;");
    git(root, "add", "--all");
    const staged = await collectDiff({ cwd: root, mode: "staged" });
    expect(staged.units.map((unit) => unit.path).sort()).toEqual(names.sort());
  });

  test("renames keep old and new paths, including pure rename metadata", async () => {
    const root = await repo({ "old name.ts": "const unchanged = true;\n" });
    git(root, "mv", "old name.ts", "new ü.ts");
    const result = await collectDiff({ cwd: root, mode: "staged" });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({ path: "new ü.ts", previousPath: "old name.ts", kind: "renamed" });
    expect(result.units[0]?.patch).toContain('rename from "old name.ts"');
    expect((await collectDiff({ cwd: root, mode: "staged", paths: ["old name.ts"] })).units).toHaveLength(1);
  });

  test("rename hunks stay with their exact path when the old path is replaced", async () => {
    const original = lines(60);
    const root = await repo({ "old.ts": `${original.join("\n")}\n` });
    git(root, "mv", "old.ts", "new.ts");
    original[30] = "changedInRenamedFile();";
    await write(root, "new.ts", `${original.join("\n")}\n`);
    git(root, "add", "new.ts");
    const renamed = await collectDiff({ cwd: root, mode: "staged" });
    expect(renamed.units).toHaveLength(1);
    expect(renamed.units[0]).toMatchObject({ path: "new.ts", previousPath: "old.ts", kind: "renamed" });
    expect(renamed.units[0]?.patch).toContain("+changedInRenamedFile();");
    await write(root, "old.ts", "replacementAtOldPath();\n");
    const working = await collectDiff({ cwd: root, mode: "worktree" });
    expect(working.complete).toBe(false);
    expect(working.units).toHaveLength(0);
    expect(working.skipped).toEqual([
      { path: "new.ts", previousPath: "old.ts", reason: "index_worktree_conflict" },
      { path: "old.ts", reason: "index_worktree_conflict" },
    ]);
    git(root, "add", "old.ts");
    const result = await collectDiff({ cwd: root, mode: "staged" });
    expect(result.complete).toBe(true);
    expect(result.units.find((unit) => unit.path === "new.ts")?.patch).not.toContain("replacementAtOldPath");
    expect(result.units.find((unit) => unit.path === "old.ts")?.patch).toContain("+replacementAtOldPath();");
  });

  test("mode-only changes remain visible", async () => {
    const root = await repo({ "run.sh": "#!/bin/sh\nexit 0\n" });
    git(root, "update-index", "--chmod=+x", "run.sh");
    const result = await collectDiff({ cwd: root, mode: "staged" });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.patch).toContain("old mode 100644\nnew mode 100755");
    if (process.platform !== "win32") {
      await chmod(join(root, "run.sh"), 0o755);
      git(root, "config", "core.filemode", "true");
      expect((await collectDiff({ cwd: root, mode: "worktree" })).units[0]?.patch).toContain("old mode 100644\nnew mode 100755");
    }
  });

  test("ignored files stay out; sensitive and generated changes are reported without their contents", async () => {
    const root = await repo({ ".gitignore": "ignored/\n", "tracked.env": "ordinary\n" });
    await write(root, "ignored/secret.ts", "IGNORED_SECRET\n");
    const excluded = [".env", ".env.example", "private.pem", "credentials.json", "src/secrets/token.ts", "node_modules/a.ts", "dist/a.js", "package-lock.json", ".npmrc", ".netrc", "production.env", ".docker/config.json", ".config/gh/hosts.yml"];
    for (const name of excluded) {
      await write(root, name, "PRIVATE_OR_GENERATED_CONTENT\n");
    }
    await write(root, "src/useful.ts", "useful\n");
    const result = await collectDiff({ cwd: root, mode: "worktree" });
    expect(result.complete).toBe(false);
    expect(result.changedFiles).toBe(excluded.length + 1);
    expect(result.units.map((unit) => unit.path)).toEqual(["src/useful.ts"]);
    expect(result.skipped).toHaveLength(excluded.length);
    expect(result.skipped.find((item) => item.path === ".env")?.reason).toBe("excluded_sensitive");
    expect(result.skipped.find((item) => item.path === "dist/a.js")?.reason).toBe("excluded_generated");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OR_GENERATED_CONTENT");
    expect(JSON.stringify(result)).not.toContain("IGNORED_SECRET");
  });

  test("secret rename source is excluded even when its new name looks safe", async () => {
    const root = await repo({ ".env": "DO_NOT_SEND_ME\n" });
    git(root, "mv", ".env", "config.ts");
    const result = await collectDiff({ cwd: root, mode: "staged" });
    expect(result.units).toHaveLength(0);
    expect(result.skipped).toEqual([{ path: "config.ts", previousPath: ".env", reason: "excluded_sensitive" }]);
  });

  test("binary, invalid UTF-8, and submodule evidence is explicitly skipped", async () => {
    const root = await repo({ "old.ts": "old\n" });
    await write(root, "binary.dat", new Uint8Array([65, 0, 66]));
    await write(root, "invalid.ts", new Uint8Array([0xff, 0xfe, 65]));
    git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD")},submodule`);
    const worktree = await collectDiff({ cwd: root, mode: "worktree" });
    expect(worktree.units).toHaveLength(0);
    expect(worktree.skipped.find((item) => item.path === "binary.dat")?.reason).toBe("binary");
    expect(worktree.skipped.find((item) => item.path === "invalid.ts")?.reason).toBe("unsupported_encoding");
    const staged = await collectDiff({ cwd: root, mode: "staged" });
    expect(staged.skipped.find((item) => item.path === "submodule")?.reason).toBe("submodule");
  });

  test.skipIf(process.platform === "win32")("file symlink evidence is explicitly skipped", async () => {
    const root = await repo({ "old.ts": "old\n" });
    await symlink(join(root, "old.ts"), join(root, "link.ts"));
    const result = await collectDiff({ cwd: root, mode: "worktree" });
    expect(result.units).toHaveLength(0);
    expect(result.skipped).toEqual([{ path: "link.ts", reason: "symlink" }]);
  });

  test("does not follow a symlink directory outside the repository", async () => {
    const root = await repo({ "nested/a.ts": "before\n" });
    const outside = await repo({ "a.ts": "OUTSIDE_SECRET\n" });
    await rm(join(root, "nested"), { recursive: true });
    await symlink(outside, join(root, "nested"), process.platform === "win32" ? "junction" : "dir");
    const result = await collectDiff({ cwd: root, mode: "worktree" });
    expect(result.units).toHaveLength(0);
    expect(result.skipped.some((item) => item.reason === "symlink")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("OUTSIDE_SECRET");
  });

  test("bounds complete file sizes, including deleted files, without truncating evidence", async () => {
    const root = await repo({ "deleted.ts": "x".repeat(200), "changed.ts": "x".repeat(200) });
    await rm(join(root, "deleted.ts"));
    await write(root, "changed.ts", "small\n");
    await write(root, "new.ts", "x".repeat(200));
    const result = await collectDiff({ cwd: root, mode: "worktree", maxFileBytes: 100 });
    expect(result.units).toHaveLength(0);
    expect(result.skipped.map((item) => item.reason)).toEqual(["file_too_large", "file_too_large", "file_too_large"]);
    expect(result.complete).toBe(false);
  });

  test("large hunks, file/unit limits, and total state budgets leave explicit coverage gaps", async () => {
    const original = lines(160);
    const root = await repo({ "a.ts": `${original.join("\n")}\n`, "b.ts": "before\n" });
    original[19] = "changedOne();";
    original[139] = "changedTwo();";
    await write(root, "a.ts", `${original.join("\n")}\n`);
    await write(root, "b.ts", "after\n");
    const normal = await collectDiff({ cwd: root, mode: "worktree" });
    expect(normal.units).toHaveLength(3);
    const limited = await collectDiff({ cwd: root, mode: "worktree", maxUnits: 1 });
    expect(limited.units).toHaveLength(1);
    expect(limited.skipped).toHaveLength(2);
    expect(limited.skipped[0]).toMatchObject({ reason: "unit_limit", oldRange: { start: 125, count: 31 } });
    const files = await collectDiff({ cwd: root, mode: "worktree", maxFiles: 1 });
    expect(files.units).toHaveLength(2);
    expect(files.skipped).toEqual([{ path: "b.ts", reason: "file_limit" }]);
    const hunk = await collectDiff({ cwd: root, mode: "worktree", maxUnitBytes: 100 });
    expect(hunk.units).toHaveLength(0);
    expect(hunk.skipped.every((item) => item.reason === "hunk_too_large")).toBe(true);
    const total = await collectDiff({ cwd: root, mode: "worktree", maxTotalBytes: 100 });
    expect(total.units).toHaveLength(0);
    expect(total.skipped.every((item) => item.reason === "total_bytes_limit")).toBe(true);
  });

  test("literal path selection cannot escape the root or inject a Git pathspec", async () => {
    const root = await repo({ "src/a.ts": "old\n", "other/b.ts": "old\n" });
    await write(root, "src/a.ts", "new\n");
    await write(root, "other/b.ts", "new\n");
    const selected = await collectDiff({ cwd: join(root, "src"), mode: "worktree", paths: ["src"] });
    expect(selected.units.map((unit) => unit.path)).toEqual(["src/a.ts"]);
    expect((await collectDiff({ cwd: root, mode: "worktree", paths: [join(root, "src/a.ts")] })).units).toHaveLength(1);
    expect((await collectDiff({ cwd: root, mode: "worktree", paths: [":(glob)**"] })).units).toHaveLength(0);
    expect(await errorCode(collectDiff({ cwd: root, mode: "worktree", paths: ["../outside"] }))).toBe("invalid_options");
    expect(await errorCode(collectDiff({ cwd: root, mode: "worktree", maxFiles: 0 }))).toBe("invalid_options");
    expect(await errorCode(collectDiff({ cwd: root, mode: "staged", since: "HEAD" }))).toBe("invalid_options");
  });

  test("unresolved merges are coverage gaps, never ordinary source evidence", async () => {
    const root = await repo({ "conflict.ts": "common\n" });
    const initial = git(root, "branch", "--show-current");
    git(root, "checkout", "--quiet", "-b", "incoming");
    await write(root, "conflict.ts", "incoming\n");
    git(root, "commit", "--quiet", "-am", "Incoming fixture");
    git(root, "checkout", "--quiet", initial);
    await write(root, "conflict.ts", "current\n");
    git(root, "commit", "--quiet", "-am", "Current fixture");
    const merge = runGit(root, "merge", "--no-edit", "incoming");
    expect(merge.exitCode).toBe(1);
    for (const mode of ["staged", "worktree"] as const) {
      const result = await collectDiff({ cwd: root, mode });
      expect(result.units).toHaveLength(0);
      expect(result.skipped).toEqual([{ path: "conflict.ts", reason: "unmerged" }]);
      expect(result.complete).toBe(false);
    }
    await write(root, "conflict.ts", "current\n");
    expect((await collectDiff({ cwd: root, mode: "worktree" })).skipped).toEqual([{ path: "conflict.ts", reason: "unmerged" }]);
  });

  test("an exhausted collection deadline fails explicitly", async () => {
    const root = await repo({ "a.ts": "before\n" });
    await write(root, "a.ts", "after\n");
    expect(await errorCode(collectDiff({ cwd: root, mode: "worktree", timeoutMs: 1 }))).toBe("timeout");
  });

  for (const race of ["modified", "untracked"] as const) {
    test.skipIf(process.platform === "win32")(`detects a late ${race} worktree change before returning evidence`, async () => {
      const root = await repo({ "a.ts": "before();\n", "b.ts": "before();\n" });
      await write(root, "a.ts", "firstMutation();\n");
      await write(root, "b.ts", "firstMutation();\n");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("Git fixture executable is unavailable");
      const bin = join(root, ".git", "test-bin");
      const shim = join(bin, "git");
      await write(root, ".git/test-bin/git", `#!${process.execPath}
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const marker = join(process.cwd(), ".git", "race-triggered");
if (args.includes("--patch") && args.at(-1) === "b.ts" && !existsSync(marker)) {
  writeFileSync(marker, "triggered");
  writeFileSync(join(process.cwd(), ${JSON.stringify(race === "modified" ? "a.ts" : "new-after-enumeration.ts")}), "laterMutation();\\n");
}
const child = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit", timeout: ${gitTimeoutMs}, killSignal: "SIGKILL" });
process.exit(child.exitCode);
`);
      await chmod(shim, 0o755);
      const runner = join(root, ".git", "race-runner.ts");
      await write(root, ".git/race-runner.ts", `import { collectDiff, DiffError } from ${JSON.stringify(new URL("../src/audit/diff.ts", import.meta.url).href)};
try {
  await collectDiff({ cwd: process.cwd(), mode: "worktree" });
  throw new Error("Expected collection-wide race detection");
} catch (error) {
  if (!(error instanceof DiffError) || error.code !== "repository_changed") throw error;
  process.stdout.write(error.code);
}
`);
      // Isolate PATH in a subprocess so other tests never observe the shim.
      const child = Bun.spawn([process.execPath, runner], {
        cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe("repository_changed");
      expect(await readFile(join(root, ".git", "race-triggered"), "utf8")).toBe("triggered");
    }, 20_000);
  }

  test("external diff, textconv, and clean filters are never invoked", async () => {
    const root = await repo({ "a.ts": "before\n", ".gitattributes": "*.ts diff=unsafe filter=unsafe\n" });
    const marker = join(root, "called");
    const command = `bun -e 'require("node:fs").writeFileSync("called", "unsafe")'`;
    git(root, "config", "diff.external", command);
    git(root, "config", "diff.unsafe.command", command);
    git(root, "config", "diff.unsafe.textconv", command);
    git(root, "config", "filter.unsafe.clean", command);
    git(root, "config", "filter.unsafe.required", "true");
    await write(root, "a.ts", "after\n");
    const result = await collectDiff({ cwd: root, mode: "worktree" });
    expect(result.units[0]?.patch).toContain("+after");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("after\n");
  });
});
