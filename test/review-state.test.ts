import { afterEach, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  mutateReviewState, readReviewState, reviewStatePath, REVIEW_STATE_LIMITS, type StoredFinding,
} from "../src/review/state.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sys1-review-state-")); roots.push(root);
  return { home: join(root, "home"), repo: join(root, "repo") };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function finding(value = "a"): StoredFinding {
  return { id: value.repeat(16), unit_id: value.repeat(64), snapshot: value.repeat(64), rule: "example",
    revision: "b".repeat(64), route: "fake/model", question_format: 2,
    selection: { mode: "worktree", since: null, paths: [] }, path: "src/code.ts", line: 1, side: "after",
    first_seen: 1, last_seen: 1, feedback: null };
}

describe("private review metadata", () => {
  test("absent reads create nothing; transactions store only strictly checked metadata", async () => {
    const f = await fixture();
    expect((await readReviewState(f.home, f.repo)).findings).toEqual([]);
    await expect(lstat(f.home)).rejects.toMatchObject({ code: "ENOENT" });
    await mutateReviewState(f.home, f.repo, state => state.findings.push(finding()));
    const stored = await readReviewState(f.home, f.repo);
    expect(stored).toMatchObject({ generation: 1, findings: [finding()] });
    if (process.platform !== "win32") {
      expect((await lstat(reviewStatePath(f.home, f.repo))).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(reviewStatePath(f.home, f.repo)))).mode & 0o777).toBe(0o700);
    }
    await expect(mutateReviewState(f.home, f.repo, state => {
      Object.assign(state.findings[0]!, { source: "SOURCE_SENTINEL", answer: "ANSWER_SENTINEL" });
    })).rejects.toThrow();
    const bytes = await readFile(reviewStatePath(f.home, f.repo));
    expect(bytes.includes(Buffer.from("SOURCE_SENTINEL"))).toBe(false);
    expect(bytes.includes(Buffer.from("ANSWER_SENTINEL"))).toBe(false);
    expect((await readReviewState(f.home, f.repo)).generation).toBe(1);
  });

  test("concurrent transactions merge from latest state without lost feedback or findings", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 10 }, (_, index) => mutateReviewState(f.home, f.repo, state => {
      const item = finding(); item.id = index.toString(16).padStart(16, "0"); state.findings.push(item);
    })));
    const stored = await readReviewState(f.home, f.repo);
    expect(stored.generation).toBe(10);
    expect(new Set(stored.findings.map(item => item.id)).size).toBe(10);
  });

  test("separate Bun processes serialize short transactions without lost records", async () => {
    const f = await fixture();
    await mutateReviewState(f.home, f.repo, () => {});
    const script = join(dirname(f.home), "writer.ts");
    await writeFile(script, `import { mutateReviewState } from ${JSON.stringify(new URL("../src/review/state.ts", import.meta.url).href)};
const [home, repo, prefix] = process.argv.slice(2);
for (let i = 0; i < 12; i++) await mutateReviewState(home, repo, state => {
  state.findings.push({ ...${JSON.stringify(finding())}, id: prefix + i.toString(16).padStart(15, "0") });
});\n`);
    const children = ["1", "2"].map(prefix => Bun.spawn([process.execPath, script, f.home, f.repo, prefix], { stdout: "pipe", stderr: "pipe" }));
    const exits = await Promise.all(children.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(exits).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);
    expect((await readReviewState(f.home, f.repo)).findings).toHaveLength(24);
  });

  test("corrupted, unknown-schema and oversized state fail closed", async () => {
    const f = await fixture();
    const file = reviewStatePath(f.home, f.repo);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "not a database");
    await expect(readReviewState(f.home, f.repo)).rejects.toThrow("could not be read");
    await rm(file);
    const db = new Database(file);
    db.exec("CREATE TABLE review_state (singleton INTEGER PRIMARY KEY, body TEXT)");
    db.query("INSERT INTO review_state VALUES (1, ?)").run(JSON.stringify({ version: 999 }));
    db.close();
    await expect(readReviewState(f.home, f.repo)).rejects.toThrow("invalid");
    await truncate(file, REVIEW_STATE_LIMITS.databaseBytes + 1);
    await expect(readReviewState(f.home, f.repo)).rejects.toThrow("size limit");
  });

  test("rejects substituted SQLite views and write-suppressing triggers before using metadata", async () => {
    for (const schema of ["view", "trigger"] as const) {
      const f = await fixture();
      await mutateReviewState(f.home, f.repo, state => state.findings.push(finding()));
      const db = new Database(reviewStatePath(f.home, f.repo));
      if (schema === "view") {
        const row = db.query("SELECT body FROM review_state").get() as { body: string };
        db.exec("DROP TABLE review_state; CREATE TABLE substituted (body TEXT)");
        db.query("INSERT INTO substituted VALUES (?)").run(row.body);
        db.exec("CREATE VIEW review_state AS SELECT 1 AS singleton, body FROM substituted");
      } else {
        db.exec("CREATE TRIGGER discard BEFORE UPDATE ON review_state BEGIN SELECT RAISE(IGNORE); END");
      }
      db.close();
      await expect(readReviewState(f.home, f.repo)).rejects.toThrow("invalid schema");
      let mutated = false;
      await expect(mutateReviewState(f.home, f.repo, () => { mutated = true; })).rejects.toThrow("invalid schema");
      expect(mutated).toBe(false);
    }
  });

  test("rejects linked state, ancestors and sidecars while preserving their targets", async () => {
    if (process.platform === "win32") return; // Cross-platform package tests cover ordinary SQLite operation.
    const f = await fixture();
    const file = reviewStatePath(f.home, f.repo);
    await mkdir(dirname(file), { recursive: true });
    const target = join(f.home, "target"); await writeFile(target, "PRESERVE");
    await symlink(target, file);
    await expect(readReviewState(f.home, f.repo)).rejects.toThrow("symbolic");
    await expect(mutateReviewState(f.home, f.repo, () => {})).rejects.toThrow("symbolic");
    await rm(file);
    await link(target, file);
    await expect(readReviewState(f.home, f.repo)).rejects.toThrow("private regular file");
    await expect(mutateReviewState(f.home, f.repo, () => {})).rejects.toThrow("private regular file");
    await rm(file);
    await mutateReviewState(f.home, f.repo, () => {});
    await symlink(target, file + "-journal");
    await expect(readReviewState(f.home, f.repo)).rejects.toThrow("unsafe journal");
    await rm(file + "-journal");
    await link(target, file + "-journal");
    await expect(readReviewState(f.home, f.repo)).rejects.toThrow("unsafe journal");
    expect(await readFile(target, "utf8")).toBe("PRESERVE");
    const linkedHome = join(dirname(f.home), "linked"); await symlink(f.home, linkedHome);
    await expect(readReviewState(linkedHome, f.repo)).rejects.toThrow("symbolic");
  });

  test("accepts macOS system temporary aliases without permitting user-controlled links", async () => {
    if (process.platform !== "darwin") return;
    const f = await fixture();
    const aliasHome = f.home.replace(/^\/private\/(var|tmp)\//, "/$1/");
    expect(aliasHome).not.toBe(f.home);
    await mutateReviewState(aliasHome, f.repo, state => state.findings.push(finding()));
    expect((await readReviewState(f.home, f.repo)).findings).toHaveLength(1);
  });

  test("growth is bounded and failed transactions leave existing records intact", async () => {
    const f = await fixture();
    await mutateReviewState(f.home, f.repo, state => state.findings.push(finding()));
    await expect(mutateReviewState(f.home, f.repo, state => {
      state.findings = Array.from({ length: REVIEW_STATE_LIMITS.findings + 1 }, (_, index) => ({ ...finding(), id: index.toString(16).padStart(16, "0") }));
    })).rejects.toThrow();
    expect((await readReviewState(f.home, f.repo)).findings).toHaveLength(1);
  });
});
