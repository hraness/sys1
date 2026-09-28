import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { readBoundedText } from "../http.ts";

/** Locating the final agent message never persists its text. */
export const VERIFY_LIMITS = {
  maxMessageBytes: 65_536,
  maxTailBytes: 8 * 1024,
  maxTurnMessages: 400,
  maxToolOutputs: 20,
  maxToolOutputBytes: 2 * 1024,
  maxCommandBytes: 512,
} as const;

export class VerifyError extends Error {
  constructor(
    readonly code: "usage" | "config" | "evidence" | "backend",
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = "VerifyError";
  }
}

export interface VerifyTurn {
  /** Check-like shell commands from the turn that produced the message. */
  commands: string[];
  /** Bounded outputs of check-like commands only. */
  outputs: { command: string; failed: boolean; excerpt: string }[];
}

export interface VerifyMessage {
  text: string;
  source: "file" | "stdin" | "devin";
  /** Present only for harness transcripts that expose tool results. */
  turn: VerifyTurn | null;
}

const CHECK_COMMAND = /\b(bun (?:run )?(?:check|test|typecheck|lint|build)|bun test|npm (?:test|run check)|pnpm (?:test|check)|cargo (?:test|check|clippy|build)|vitest|jest|pytest|tsc\b|make (?:test|check))/i;
const FAILURE_MARK = /(?:^|\n).*?(?:exit code:?\s*[1-9]|error:|(?:^|\s)FAIL(?:\s|$)|\bfail(?:ed|ure)\b)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandOf(call: unknown): string | undefined {
  if (!isRecord(call)) return undefined;
  const args = isRecord(call["arguments"]) ? call["arguments"] : undefined;
  const command = args?.["command"];
  return typeof command === "string" ? command.slice(0, VERIFY_LIMITS.maxCommandBytes) : undefined;
}

function assistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : "")).join("");
  }
  return "";
}

/**
 * Read the newest Devin session whose working directory is the current
 * directory or one of its ancestors, then take the last assistant message and
 * the tool evidence from the turn that produced it.
 */
export function devinTurn(dbPath: string, cwd: string): VerifyMessage | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return undefined;
  }
  try {
    const sessions = db.query(
      "SELECT id, working_directory, last_activity_at FROM sessions ORDER BY last_activity_at DESC LIMIT 200",
    ).all() as { id: string; working_directory: string; last_activity_at: number }[];
    const session = sessions.find(item => cwd === item.working_directory || cwd.startsWith(`${item.working_directory}${sep}`));
    if (session === undefined) return undefined;
    const rows = db.query(
      "SELECT chat_message FROM message_nodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(session.id, VERIFY_LIMITS.maxTurnMessages) as { chat_message: string }[];
    const messages: Record<string, unknown>[] = [];
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.chat_message);
        if (isRecord(parsed)) messages.push(parsed);
      } catch { /* skip unparseable rows */ }
    }
    messages.reverse();
    let lastUser = -1;
    let final: { index: number; text: string } | undefined;
    messages.forEach((message, index) => {
      if (message["role"] === "user") lastUser = index;
      if (message["role"] === "assistant") {
        const text = assistantText(message);
        if (text.trim() !== "") final = { index, text };
      }
    });
    if (final === undefined) return undefined;
    // The verified turn is the assistant work after the user message that
    // precedes the final message.
    const turn = messages.slice(Math.max(lastUser, 0), final.index + 1);
    const commands: string[] = [];
    const outputs: { command: string; failed: boolean; excerpt: string }[] = [];
    const toolCalls = new Map<string, string>();
    for (const message of turn) {
      if (message["role"] === "assistant") {
        for (const call of Array.isArray(message["tool_calls"]) ? message["tool_calls"] : []) {
          const command = commandOf(call);
          const id = isRecord(call) && typeof call["id"] === "string" ? call["id"] : undefined;
          if (command !== undefined) {
            commands.push(command);
            if (id !== undefined) toolCalls.set(id, command);
          }
        }
      }
      if (message["role"] === "tool" && outputs.length < VERIFY_LIMITS.maxToolOutputs) {
        const id = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : "";
        const command = toolCalls.get(id);
        if (command === undefined || !CHECK_COMMAND.test(command)) continue;
        const meta = isRecord(message["metadata"]) ? message["metadata"] : {};
        const extensions = isRecord(meta["extensions"]) ? meta["extensions"] : {};
        const result = isRecord(extensions["chisel/tool_result_meta"]) ? extensions["chisel/tool_result_meta"] : {};
        const content = typeof message["content"] === "string" ? message["content"] : "";
        const failed = result["success"] === false || FAILURE_MARK.test(content);
        outputs.push({ command, failed, excerpt: content.slice(-VERIFY_LIMITS.maxToolOutputBytes) });
      }
    }
    return { text: final.text, source: "devin", turn: { commands, outputs } };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export function defaultDevinDb(home = homedir()): string {
  return join(home, ".local/share/devin/cli/sessions.db");
}

export async function resolveMessage(options: {
  cwd: string;
  messageFile?: string;
  devinDb?: string;
  stdin?: { body: ReadableStream<Uint8Array> | null };
}): Promise<VerifyMessage> {
  if (options.messageFile !== undefined) {
    if (options.messageFile === "-") {
      const stdin = options.stdin ?? { body: Bun.stdin.stream() };
      const text = await readBoundedText(stdin, VERIFY_LIMITS.maxMessageBytes);
      if (text.trim() === "") throw new VerifyError("usage", "The piped message is empty");
      return { text, source: "stdin", turn: null };
    }
    const text = await readBoundedText({ body: Bun.file(options.messageFile).stream() }, VERIFY_LIMITS.maxMessageBytes);
    if (text.trim() === "") throw new VerifyError("usage", "The message file is empty");
    return { text, source: "file", turn: null };
  }
  const found = devinTurn(options.devinDb ?? defaultDevinDb(), options.cwd);
  if (found !== undefined) return found;
  throw new VerifyError(
    "usage",
    "Could not find a Devin session for this directory. Pipe the final message with `sys1 verify --message -` or pass `--message <file>`.",
  );
}
