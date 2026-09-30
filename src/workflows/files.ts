import { chmod, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import { WORKFLOW_LIMITS, WorkflowError } from "./types.ts";

export const LOG_ID = /^[a-f0-9]{32}\.log$/;
export function workflowLogPath(home: string, id: string): string {
  if (!LOG_ID.test(id)) throw new WorkflowError("invalid_log", "Invalid workflow log reference");
  return join(resolve(home), "workflows", "logs", id);
}
export function workflowDirectory(home: string): string { return join(resolve(home), "workflows"); }

/** Inspect every existing component; never follow a symlink into another store. */
export async function safeDirectory(path: string, create: boolean): Promise<boolean> {
  const target = resolve(path);
  let current = parse(target).root;
  const parts = relative(current, target).split(sep).filter(Boolean);
  let missing = false;
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorkflowError("unsafe_store", "Cannot inspect the private workflow directory");
      if (!create) { missing = true; continue; }
      try { await mkdir(current, { mode: 0o700 }); stat = await lstat(current); }
      catch { throw new WorkflowError("unsafe_store", "Cannot create the private workflow directory"); }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkflowError("unsafe_store", "Workflow storage must use real directories without symlinks");
  }
  if (create) await chmod(target, 0o700);
  return !missing;
}

/** Delete only expired, regular Sys1-owned logs. Symlinks and unknown files remain untouched. */
export async function expireLogs(directory: string, now = Date.now()): Promise<void> {
  if (!await safeDirectory(directory, false)) return;
  const entries = await readdir(directory);
  if (entries.length > 10_000) throw new WorkflowError("store_limit", "Workflow log inventory exceeds its limit");
  let retained = entries.length;
  for (const name of entries) {
    if (!LOG_ID.test(name)) continue;
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink() && Math.ceil(stat.mtimeMs) + WORKFLOW_LIMITS.logRetentionMs <= now) { await unlink(path); retained--; }
  }
  if (retained >= 10_000) throw new WorkflowError("store_limit", "Workflow log inventory is full");
}

export async function prepareWorkflowDirectory(home: string): Promise<string> {
  const dir = workflowDirectory(home);
  await safeDirectory(dir, true);
  // The ALGAL host owns only this subtree; raw command logs have a separate lifetime.
  await safeDirectory(join(dir, "engine"), true);
  await safeDirectory(join(dir, "logs"), true);
  await expireLogs(join(dir, "logs"));
  return dir;
}

export function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}
