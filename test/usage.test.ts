import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, renderUsage, type UsageSources } from "../src/usage.ts";

const NOW = new Date("2026-09-27T12:00:00Z");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(): UsageSources & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "sys1-usage-"));
  scratch.push(root);
  return { root, devinDb: join(root, "devin.db"), claudeDir: join(root, "claude"), codexDir: join(root, "codex") };
}

function devinDb(path: string): void {
  const db = new Database(path);
  db.run("CREATE TABLE sessions (id TEXT, created_at INTEGER, last_activity_at INTEGER)");
  db.run("CREATE TABLE tool_call_state (session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT)");
  const recent = Date.parse("2026-09-25T10:00:00Z") / 1000;
  const old = Date.parse("2026-08-01T10:00:00Z") / 1000;
  db.run("INSERT INTO sessions VALUES ('s1', ?, ?), ('s2', ?, ?), ('old', ?, ?)", [recent, recent, recent, recent, old, old]);
  const call = (session: string, value: unknown) => db.run("INSERT INTO tool_call_state VALUES (?, ?, ?, NULL)", [session, crypto.randomUUID(), JSON.stringify(value)]);
  call("s1", { title: "Invoked skill system-one-verify", kind: "other", rawInput: { command: "invoke", skill: "system-one-verify" } });
  call("s1", { title: "Ran system-one-skills", kind: "execute", rawInput: { command: "system-one-skills check --timeout-ms 900000 -- bun test" } });
  call("s1", { title: "Ran sys1", kind: "execute", rawInput: { command: "cd repo && sys1 review checkpoint --staged --model typesafe/jev-1.13.0 --dry-run" } });
  call("s1", { title: "Invoked skill query-kb", kind: "other", rawInput: { command: "invoke", skill: "query-kb" } });
  call("s2", { title: "Ran ls", kind: "execute", rawInput: { command: "ls /private/secret-sys1-notes" } });
  call("old", { title: "Ran sys1", kind: "execute", rawInput: { command: "sys1 audit --staged" } });
  db.close();
}

function jsonl(path: string, records: unknown[], mtime = NOW): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  utimesSync(path, mtime, mtime);
}

describe("sys1 usage", () => {
  test("counts Sys1 commands, verify checks, and Sys1 skills per harness and day", async () => {
    const sources = fixture();
    devinDb(sources.devinDb);
    jsonl(join(sources.claudeDir, "project", "a.jsonl"), [
      { type: "assistant", timestamp: "2026-09-26T08:00:00Z", message: { content: [
        { type: "tool_use", name: "Skill", input: { skill: "sys1-review" } },
        { type: "tool_use", name: "Bash", input: { command: "~/.local/bin/sys1 audit --worktree --model typesafe/jev-1.13.0" } },
        { type: "tool_use", name: "Skill", input: { skill: "ghostget" } },
      ] } },
      { type: "assistant", timestamp: "2026-09-01T08:00:00Z", message: { content: [
        { type: "tool_use", name: "Bash", input: { command: "sys1 doctor" } },
      ] } },
    ]);
    jsonl(join(sources.codexDir, "2026", "09", "26", "rollout.jsonl"), [
      { timestamp: "2026-09-26T09:00:00Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n 1,80p .agents/skills/sys1-review/SKILL.md" }) } },
      { timestamp: "2026-09-26T09:01:00Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "text(await tools.exec_command({cmd:\"system-one-skills check --timeout-ms 900000 -- bun run check\"}))" } },
      { timestamp: "2026-09-26T09:02:00Z", type: "response_item", payload: { type: "message", content: [{ type: "output_text", text: "run sys1 audit later" }] } },
    ]);
    jsonl(join(sources.codexDir, "2026", "08", "01", "old.jsonl"), [
      { timestamp: "2026-08-01T09:00:00Z", type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ cmd: "sys1 up" }) } },
    ], new Date("2026-08-01T09:00:00Z"));

    const report = await collectUsage({ days: 14, sources, now: NOW });
    expect(report.since).toBe("2026-09-13");
    expect(report.harnesses.devin).toEqual({
      status: "read", transcripts: 2, transcripts_with_use: 1,
      sys1_commands: { review: 1 }, verify_checks: 1, skills: { "system-one-verify": 1 },
    });
    expect(report.harnesses["claude-code"]).toEqual({
      status: "read", transcripts: 1, transcripts_with_use: 1,
      sys1_commands: { audit: 1 }, verify_checks: 0, skills: { "sys1-review": 1 },
    });
    expect(report.harnesses.codex).toEqual({
      status: "read", transcripts: 1, transcripts_with_use: 1,
      sys1_commands: {}, verify_checks: 1, skills: { "sys1-review": 1 },
    });
    expect(report.by_day).toEqual({
      "2026-09-25": { devin: { sys1: 1, verify: 1, skills: 1 } },
      "2026-09-26": { "claude-code": { sys1: 1, verify: 0, skills: 1 }, codex: { sys1: 0, verify: 1, skills: 1 } },
    });
  });

  test("reports counts only, never commands, paths, or unrelated skills", async () => {
    const sources = fixture();
    devinDb(sources.devinDb);
    const report = await collectUsage({ days: 14, sources, now: NOW });
    const text = JSON.stringify(report) + renderUsage(report);
    for (const secret of ["typesafe/jev", "--dry-run", "bun test", "/private/secret", "query-kb", "cd repo", sources.root]) {
      expect(text).not.toContain(secret);
    }
  });

  test("missing and unreadable sources are reported, not fatal", async () => {
    const sources = fixture();
    writeFileSync(sources.devinDb, "not a database");
    const report = await collectUsage({ days: 7, sources, now: NOW });
    expect(report.harnesses.devin.status).toBe("unreadable");
    expect(report.harnesses["claude-code"].status).toBe("missing");
    expect(report.harnesses.codex.status).toBe("missing");
    expect(renderUsage(report)).toContain("claude-code: no transcripts found");
  });

  test("rejects windows outside 1..90 days", async () => {
    const sources = fixture();
    for (const days of [0, 91, 1.5, Number.NaN]) {
      await expect(collectUsage({ days, sources, now: NOW })).rejects.toThrow(RangeError);
    }
  });
});
