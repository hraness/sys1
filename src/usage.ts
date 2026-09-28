import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Counts how often coding agents used Sys1 and System One Skills, from their
 * local transcripts. Read-only and aggregate-only: no prompt text, command
 * text, paths, or source ever leaves this module.
 */

export const HARNESSES = ["devin", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface UsageSources {
  devinDb: string;
  claudeDir: string;
  codexDir: string;
}

export interface HarnessUsage {
  status: "read" | "missing" | "unreadable";
  /** Transcripts (Devin sessions or JSONL files) active inside the window. */
  transcripts: number;
  /** Transcripts with at least one Sys1 or System One Skills event. */
  transcripts_with_use: number;
  sys1_commands: Record<string, number>;
  verify_checks: number;
  skills: Record<string, number>;
}

export interface UsageReport {
  version: 1;
  days: number;
  since: string;
  harnesses: Record<Harness, HarnessUsage>;
  by_day: Record<string, Partial<Record<Harness, { sys1: number; verify: number; skills: number }>>>;
}

export const USAGE_LIMITS = { minDays: 1, maxDays: 90, maxFiles: 50_000, maxLineBytes: 8 * 1024 * 1024 } as const;

const SYS1_SUBCOMMANDS = "audit|review|rules|eval|setup|jev|up|down|serve|status|doctor|pull|model|models|backend|config";
const SYS1_COMMAND = new RegExp(`(?:^|[\\s;&|(/"'\`])sys1\\s+(${SYS1_SUBCOMMANDS})\\b`, "g");
const VERIFY_CHECK = /system-one-skills\s+check\b/g;
const SKILL_FILE = /skills\/((?:sys1|system-one)[a-z0-9-]*)\/SKILL\.md/g;
const MARKERS = ["sys1", "system-one"];

export function defaultUsageSources(home = homedir()): UsageSources {
  return {
    devinDb: join(home, ".local/share/devin/cli/sessions.db"),
    claudeDir: join(home, ".claude/projects"),
    codexDir: join(home, ".codex/sessions"),
  };
}

function emptyHarness(status: HarnessUsage["status"] = "missing"): HarnessUsage {
  return { status, transcripts: 0, transcripts_with_use: 0, sys1_commands: {}, verify_checks: 0, skills: {} };
}

function isSys1Skill(name: unknown): name is string {
  return typeof name === "string" && /^(?:sys1|system-one)[a-z0-9-]*$/u.test(name);
}

class Tally {
  readonly usage: HarnessUsage = emptyHarness("read");
  private used = false;
  constructor(private readonly harness: Harness, private readonly report: UsageReport) {}

  private bump(day: string, key: "sys1" | "verify" | "skills"): void {
    const row = (this.report.by_day[day] ??= {});
    const cell = (row[this.harness] ??= { sys1: 0, verify: 0, skills: 0 });
    cell[key] += 1;
    this.used = true;
  }

  /** Scan text that an agent sent to a tool (shell commands, patches, arguments). */
  text(value: string, day: string): void {
    for (const match of value.matchAll(SYS1_COMMAND)) {
      const sub = match[1]!;
      this.usage.sys1_commands[sub] = (this.usage.sys1_commands[sub] ?? 0) + 1;
      this.bump(day, "sys1");
    }
    for (const _ of value.matchAll(VERIFY_CHECK)) {
      this.usage.verify_checks += 1;
      this.bump(day, "verify");
    }
    for (const match of value.matchAll(SKILL_FILE)) this.skill(match[1]!, day);
  }

  skill(name: string, day: string): void {
    this.usage.skills[name] = (this.usage.skills[name] ?? 0) + 1;
    this.bump(day, "skills");
  }

  endTranscript(): void {
    this.usage.transcripts += 1;
    if (this.used) this.usage.transcripts_with_use += 1;
    this.used = false;
  }
}

function dayOf(value: unknown): string | undefined {
  const ms = typeof value === "number" ? (value > 1e12 ? value : value * 1000) : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readDevin(path: string, sinceSeconds: number, tally: Tally): void {
  const db = new Database(path, { readonly: true });
  try {
    const sessions = db.query("SELECT id, created_at FROM sessions WHERE last_activity_at >= ?").all(sinceSeconds) as { id: string; created_at: number }[];
    const calls = db.query(`SELECT json_extract(tool_call_json, '$.title') AS title, json_extract(tool_call_json, '$.rawInput') AS raw
      FROM tool_call_state WHERE session_id = ? AND (tool_call_json LIKE '%sys1%' OR tool_call_json LIKE '%system-one%')`);
    for (const session of sessions) {
      const day = dayOf(session.created_at) ?? "unknown";
      for (const row of calls.iterate(session.id) as Iterable<{ title: string | null; raw: string | null }>) {
        const raw = asRecord(typeof row.raw === "string" ? parseJson(row.raw) : undefined) ?? {};
        const invoked = typeof row.title === "string" && row.title.startsWith("Invoked skill ") ? row.title.slice("Invoked skill ".length) : raw["skill"];
        if (raw["command"] === "invoke" || typeof row.title === "string" && row.title.startsWith("Invoked skill ")) {
          if (isSys1Skill(invoked)) tally.skill(invoked, day);
          continue;
        }
        for (const key of ["command", "file_path"]) {
          const value = raw[key];
          if (typeof value === "string") tally.text(value, day);
        }
      }
      tally.endTranscript();
    }
  } finally {
    db.close();
  }
}

function* jsonlFiles(root: string, sinceMs: number): Generator<string> {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && statSync(path).mtimeMs >= sinceMs) {
        if (++seen > USAGE_LIMITS.maxFiles) return;
        yield path;
      }
    }
  }
}

async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Bun.file(path).stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.length <= USAGE_LIMITS.maxLineBytes) yield line;
    }
    // A single oversized line cannot be parsed within bounds; drop it.
    if (pending.length > USAGE_LIMITS.maxLineBytes) pending = "";
  }
  pending += decoder.decode();
  if (pending.length > 0 && pending.length <= USAGE_LIMITS.maxLineBytes) yield pending;
}

const hasMarker = (line: string): boolean => MARKERS.some((marker) => line.includes(marker));

function inWindow(day: string | undefined, since: string): day is string {
  return day !== undefined && day >= since;
}

async function readClaude(root: string, sinceMs: number, since: string, tally: Tally): Promise<void> {
  for (const file of jsonlFiles(root, sinceMs)) {
    for await (const line of lines(file)) {
      if (!line.includes('"tool_use"') || !hasMarker(line)) continue;
      const record = asRecord(parseJson(line));
      const day = dayOf(record?.["timestamp"]);
      if (!inWindow(day, since)) continue;
      const content = asRecord(record?.["message"])?.["content"];
      for (const block of Array.isArray(content) ? content : []) {
        const tool = asRecord(block);
        if (tool?.["type"] !== "tool_use") continue;
        const input = asRecord(tool["input"]) ?? {};
        if (tool["name"] === "Skill") {
          if (isSys1Skill(input["skill"])) tally.skill(input["skill"], day);
          continue;
        }
        for (const key of ["command", "file_path"]) {
          const value = input[key];
          if (typeof value === "string") tally.text(value, day);
        }
      }
    }
    tally.endTranscript();
  }
}

async function readCodex(root: string, sinceMs: number, since: string, tally: Tally): Promise<void> {
  const callTypes = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
  for (const file of jsonlFiles(root, sinceMs)) {
    for await (const line of lines(file)) {
      if (!line.includes("_call") || !hasMarker(line)) continue;
      const record = asRecord(parseJson(line));
      const payload = asRecord(record?.["payload"]);
      if (payload === undefined || !callTypes.has(String(payload["type"]))) continue;
      const day = dayOf(record?.["timestamp"]);
      if (!inWindow(day, since)) continue;
      const body = payload["arguments"] ?? payload["input"] ?? payload["action"];
      tally.text(typeof body === "string" ? body : JSON.stringify(body ?? ""), day);
    }
    tally.endTranscript();
  }
}

export async function collectUsage(options: { days: number; sources?: UsageSources; now?: Date }): Promise<UsageReport> {
  const { days } = options;
  if (!Number.isInteger(days) || days < USAGE_LIMITS.minDays || days > USAGE_LIMITS.maxDays) {
    throw new RangeError(`days must be an integer from ${USAGE_LIMITS.minDays} to ${USAGE_LIMITS.maxDays}`);
  }
  const sources = options.sources ?? defaultUsageSources();
  const sinceMs = (options.now ?? new Date()).getTime() - days * 86_400_000;
  const since = new Date(sinceMs).toISOString().slice(0, 10);
  const report: UsageReport = {
    version: 1,
    days,
    since,
    harnesses: { devin: emptyHarness(), "claude-code": emptyHarness(), codex: emptyHarness() },
    by_day: {},
  };
  const readers: Record<Harness, [string, (tally: Tally) => void | Promise<void>]> = {
    devin: [sources.devinDb, (tally) => readDevin(sources.devinDb, Math.floor(sinceMs / 1000), tally)],
    "claude-code": [sources.claudeDir, (tally) => readClaude(sources.claudeDir, sinceMs, since, tally)],
    codex: [sources.codexDir, (tally) => readCodex(sources.codexDir, sinceMs, since, tally)],
  };
  for (const harness of HARNESSES) {
    const [path, read] = readers[harness];
    if (!existsSync(path)) continue;
    const tally = new Tally(harness, report);
    try {
      await read(tally);
      report.harnesses[harness] = tally.usage;
    } catch {
      report.harnesses[harness] = emptyHarness("unreadable");
    }
  }
  report.by_day = Object.fromEntries(Object.entries(report.by_day).sort(([a], [b]) => a.localeCompare(b)));
  return report;
}

export function renderUsage(report: UsageReport): string {
  const lines = [`Sys1 usage by coding agents since ${report.since} (${report.days} days)`, ""];
  for (const harness of HARNESSES) {
    const usage = report.harnesses[harness];
    if (usage.status !== "read") {
      lines.push(`${harness}: ${usage.status === "missing" ? "no transcripts found" : "transcripts could not be read"}`);
      continue;
    }
    const sys1 = Object.values(usage.sys1_commands).reduce((sum, count) => sum + count, 0);
    const skills = Object.values(usage.skills).reduce((sum, count) => sum + count, 0);
    lines.push(`${harness}: ${usage.transcripts_with_use} of ${usage.transcripts} transcripts used Sys1 · ${sys1} sys1 commands · ${usage.verify_checks} verify checks · ${skills} skill loads`);
    const detail = [
      ...Object.entries(usage.sys1_commands).sort(([, a], [, b]) => b - a).map(([name, count]) => `sys1 ${name} ${count}`),
      ...Object.entries(usage.skills).sort(([, a], [, b]) => b - a).map(([name, count]) => `${name} ${count}`),
    ];
    if (detail.length > 0) lines.push(`  ${detail.join(" · ")}`);
  }
  return `${lines.join("\n")}\n`;
}
