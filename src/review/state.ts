import { Database, constants as sqlite } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { z } from "zod";

export class ReviewError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 3) { super(message); }
}

export const REVIEW_STATE_LIMITS = { bytes: 2_097_152, databaseBytes: 16_777_216, findings: 2_000, receipts: 64, paths: 100 } as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-f0-9]{16}$/);
const path = z.string().min(1).max(4_096).refine(value => !value.includes("\0") && !value.startsWith("/") && !value.split(/[\\/]/).includes(".."));
const route = z.string().max(128).regex(/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/);
const timestamp = z.number().int().nonnegative();
export const reviewFeedbackSchema = z.enum(["useful", "incorrect", "unverifiable"]);
export type ReviewFeedback = z.infer<typeof reviewFeedbackSchema>;
export const reviewSelectionSchema = z.strictObject({
  mode: z.enum(["worktree", "staged", "since"]),
  since: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  paths: z.array(path).max(REVIEW_STATE_LIMITS.paths),
}).refine(value => (value.mode === "since") === (value.since !== null));
export type ReviewSelection = z.infer<typeof reviewSelectionSchema>;
export const storedFindingSchema = z.strictObject({
  id, unit_id: hash, snapshot: hash, rule: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  revision: hash, route, question_format: z.number().int().positive(), selection: reviewSelectionSchema,
  path, line: z.number().int().positive(), side: z.enum(["before", "after"]),
  first_seen: timestamp, last_seen: timestamp, feedback: reviewFeedbackSchema.nullable(),
});
export type StoredFinding = z.infer<typeof storedFindingSchema>;
export const reviewReceiptSchema = z.strictObject({
  snapshot: hash, created_at: timestamp, finding_ids: z.array(id).max(REVIEW_STATE_LIMITS.findings),
});
export type ReviewReceipt = z.infer<typeof reviewReceiptSchema>;
const stateSchema = z.strictObject({
  version: z.literal(1), generation: z.number().int().nonnegative(),
  findings: z.array(storedFindingSchema).max(REVIEW_STATE_LIMITS.findings),
  receipts: z.array(reviewReceiptSchema).max(REVIEW_STATE_LIMITS.receipts),
}).superRefine((state, ctx) => {
  if (new Set(state.findings.map(item => item.id)).size !== state.findings.length
    || new Set(state.receipts.map(item => item.snapshot)).size !== state.receipts.length) {
    ctx.addIssue({ code: "custom", message: "duplicate review metadata" });
  }
  const known = new Set(state.findings.map(item => item.id));
  if (state.receipts.some(receipt => receipt.finding_ids.some(value => !known.has(value)))) {
    ctx.addIssue({ code: "custom", message: "receipt refers to unknown finding" });
  }
});
export type ReviewState = z.infer<typeof stateSchema>;
const empty = (): ReviewState => ({ version: 1, generation: 0, findings: [], receipts: [] });
const STATE_TABLE = "CREATE TABLE review_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), body TEXT NOT NULL)";

/** Resolve every existing component without following a symbolic link. */
async function safeComponents(target: string): Promise<void> {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        // macOS exposes its system temporary directories through these fixed
        // aliases. Accept only their canonical OS targets, never a user link.
        const systemAlias = process.platform === "darwin" && (cursor === "/tmp" || cursor === "/var")
          && await realpath(cursor) === `/private${cursor}`;
        if (!systemAlias) throw new ReviewError("unsafe_state", "Review state cannot use symbolic links");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function reviewStatePath(home: string, repoRoot: string): string {
  return join(resolve(home), "review", createHash("sha256").update(repoRoot).digest("hex"), "state.sqlite");
}

async function checkedPath(home: string, repoRoot: string, create: boolean): Promise<string | null> {
  const file = reviewStatePath(home, repoRoot);
  await safeComponents(file);
  if (create) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await safeComponents(file);
    await chmod(dirname(file), 0o700);
    await chmod(dirname(dirname(file)), 0o700);
    try {
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.close();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new ReviewError("unsafe_state", "Review state must be a private regular file");
    if (info.size > REVIEW_STATE_LIMITS.databaseBytes) throw new ReviewError("state_limit", "Review state exceeds its size limit");
    if (create) await chmod(file, 0o600);
    // SQLite may read journals written by another invocation. Never follow a substituted sidecar.
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try {
        const sidecar = await lstat(file + suffix);
        // A concurrent COMMIT may unlink its journal while lstat completes;
        // that transient inode has zero links and is no longer a path target.
        if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink > 1 || sidecar.size > REVIEW_STATE_LIMITS.databaseBytes) {
          throw new ReviewError("unsafe_state", "Review state has an unsafe journal");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // SQLite opens by pathname. Canonicalize the approved OS aliases and use
    // SQLITE_OPEN_NOFOLLOW below so replacing the file with a link is rejected.
    return join(await realpath(dirname(file)), "state.sqlite");
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseState(raw: unknown): ReviewState {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > REVIEW_STATE_LIMITS.bytes) throw new ReviewError("state_corrupt", "Review state is invalid or too large");
  try { return stateSchema.parse(JSON.parse(raw)); }
  catch { throw new ReviewError("state_corrupt", "Review state is invalid"); }
}

function checkDatabaseSchema(db: Database, create: boolean): void {
  const rows = db.query("SELECT type, name, sql FROM sqlite_schema LIMIT 2").all() as { type: string; name: string; sql: string }[];
  if (rows.length === 0 && create) { db.exec(STATE_TABLE); return; }
  // trusted_schema disables unsafe functions, not ordinary views or triggers.
  // Our single-table store has no schema extensions or migrations to accept.
  if (rows.length !== 1 || rows[0]!.type !== "table" || rows[0]!.name !== "review_state" || rows[0]!.sql !== STATE_TABLE) {
    throw new ReviewError("state_corrupt", "Review state has an invalid schema");
  }
}

function readDatabase(db: Database): ReviewState {
  const count = db.query("SELECT COUNT(*) AS count FROM review_state").get() as { count: number };
  if (count.count > 1) throw new ReviewError("state_corrupt", "Review state contains unexpected records");
  const invalid = db.query("SELECT 1 FROM review_state WHERE typeof(body) != 'text' OR length(CAST(body AS BLOB)) > ? LIMIT 1").get(REVIEW_STATE_LIMITS.bytes);
  if (invalid !== null) throw new ReviewError("state_corrupt", "Review state is invalid or too large");
  const row = db.query("SELECT body FROM review_state WHERE singleton = 1").get() as { body: unknown } | null;
  if (count.count === 1 && row === null) throw new ReviewError("state_corrupt", "Review state contains an invalid record");
  return row === null ? empty() : parseState(row.body);
}

function stateError(error: unknown): never {
  if (error instanceof ReviewError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/locked|busy/i.test(message)) throw new ReviewError("state_busy", "Review state is busy; retry this command");
  throw new ReviewError("state_corrupt", "Review state could not be read or updated");
}

export async function readReviewState(home: string, repoRoot: string): Promise<ReviewState> {
  const file = await checkedPath(home, repoRoot, false);
  if (file === null) return empty();
  let db: Database | undefined;
  try {
    db = new Database(file, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_NOFOLLOW);
    db.exec("PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;");
    checkDatabaseSchema(db, false);
    return readDatabase(db);
  } catch (error) { return stateError(error); }
  finally { db?.close(); }
}

/** The synchronous mutator runs inside a short write transaction, never across model calls. */
export async function mutateReviewState<T>(home: string, repoRoot: string, mutate: (state: ReviewState) => T): Promise<T> {
  const file = await checkedPath(home, repoRoot, true);
  let db: Database | undefined;
  try {
    db = new Database(file!, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW);
    db.exec("PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=4096;");
    db.exec("BEGIN IMMEDIATE");
    try {
      checkDatabaseSchema(db, true);
      const state = readDatabase(db);
      const result = mutate(state);
      state.generation++;
      const parsed = stateSchema.parse(state);
      const body = JSON.stringify(parsed);
      if (Buffer.byteLength(body) > REVIEW_STATE_LIMITS.bytes) throw new ReviewError("state_limit", "Review metadata is full");
      db.query("INSERT INTO review_state(singleton, body) VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET body=excluded.body").run(body);
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { return stateError(error); }
  finally { db?.close(); }
}

/** Existing canonical worktree root; no source collection or state creation. */
export async function reviewRepositoryRoot(cwd: string): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
  const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "rev-parse", "--show-toplevel"], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 8_192) { child.kill("SIGKILL"); throw new ReviewError("not_repository", "Could not identify the Git worktree", 2); }
      chunks.push(result.value);
    }
    if (await child.exited !== 0) throw new ReviewError("not_repository", "Could not identify the Git worktree", 2);
    const output = Buffer.concat(chunks).toString("utf8");
    if (!output.endsWith("\n")) throw new ReviewError("not_repository", "Could not identify the Git worktree", 2);
    return await realpath(output.slice(0, -1));
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}

export const resolveReviewRoot = reviewRepositoryRoot;
