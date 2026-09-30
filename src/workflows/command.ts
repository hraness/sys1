import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { LOG_ID, safeDirectory } from "./files.ts";
import { WORKFLOW_LIMITS, WorkflowError, type WorkflowCheckResult } from "./types.ts";

export function requireWorkflowPlatform(platform = process.platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new WorkflowError("unsupported_platform", "Saved workflows currently require macOS or Linux process groups");
  }
}

export function validateCommand(argv: readonly string[], timeoutMs: number): void {
  if (!argv.length || argv.length > WORKFLOW_LIMITS.maxCommandArgs
    || argv.some(item => typeof item !== "string" || item.includes("\0")) || !argv[0]
    || argv.reduce((sum, item) => sum + Buffer.byteLength(item), 0) > WORKFLOW_LIMITS.maxCommandBytes
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKFLOW_LIMITS.maxTimeoutMs) {
    throw new WorkflowError("invalid_command", "Workflow command or timeout exceeds the supported limits");
  }
}

export async function runWorkflowCommand(options: {
  argv: readonly string[]; cwd: string; logDirectory: string; timeoutMs: number; signal?: AbortSignal;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  logId?: string;
}): Promise<WorkflowCheckResult> {
  requireWorkflowPlatform(options.platform);
  validateCommand(options.argv, options.timeoutMs);
  if (options.signal?.aborted) throw new WorkflowError("cancelled", "Workflow cancelled before starting its command", 130);
  await safeDirectory(options.logDirectory, true);
  if (options.signal?.aborted) throw new WorkflowError("cancelled", "Workflow cancelled before starting its command", 130);
  const started = Date.now();
  const id = options.logId ?? `${randomBytes(16).toString("hex")}.log`;
  if (!LOG_ID.test(id)) throw new WorkflowError("unsafe_log", "Invalid private command log reference");
  const path = join(options.logDirectory, id);
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { throw new WorkflowError("unsafe_log", "Cannot create a private command log"); }
  const hash = createHash("sha256");
  let bytes = 0, outputBytes = 0, exitCode: number | null = null;
  let status: WorkflowCheckResult["status"] = "passed";
  let pid: number | undefined, closed = false, exited = false, spawnFailed = false, ioFailed = false;
  let stopping: Promise<void> | undefined;
  let onClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => { onClosed = resolve; });
  const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  let child: ChildProcess;
  try {
    child = spawn(options.executable ?? options.argv[0]!, options.argv.slice(1), {
      cwd: options.cwd, env: options.env ?? process.env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      argv0: options.argv[0],
    });
  } catch { closeSync(fd); throw new WorkflowError("spawn_failed", "Workflow command could not be started", 127); }
  pid = child.pid;
  const alive = (): boolean => {
    if (pid === undefined || spawnFailed) return false;
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (pid === undefined || spawnFailed) return;
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") status = "uncertain"; }
  };
  const stop = (): Promise<void> => stopping ??= (async () => {
    signalGroup("SIGTERM");
    // Ownership is this invocation's detached group, never a PID recovered from saved metadata.
    const grace = Date.now() + 250;
    while (alive() && Date.now() < grace) await delay(10);
    if (alive()) signalGroup("SIGKILL");
    const reap = Date.now() + 2_000;
    while ((!closed || alive()) && Date.now() < reap) await delay(10);
    if (!closed || alive()) {
      status = "uncertain";
      child.stdout?.destroy(); child.stderr?.destroy();
    }
  })();
  const receive = (chunk: Buffer): void => {
    outputBytes += chunk.length;
    const part = chunk.subarray(0, Math.max(0, WORKFLOW_LIMITS.maxLogBytes - bytes));
    if (!part.length || ioFailed) return;
    try {
      let offset = 0;
      while (offset < part.length) offset += writeSync(fd, part, offset, part.length - offset);
      hash.update(part); bytes += part.length;
    } catch { ioFailed = true; status = "uncertain"; void stop(); }
  };
  child.stdout?.on("data", receive); child.stderr?.on("data", receive);
  const streamError = (): void => { ioFailed = true; status = "uncertain"; void stop(); };
  child.stdout?.on("error", streamError); child.stderr?.on("error", streamError);
  child.on("spawn", () => { pid = child.pid; if (options.signal?.aborted) { status = "cancelled"; void stop(); } });
  child.on("error", () => { spawnFailed = true; status = "failed"; exitCode = 127; });
  child.on("exit", (code) => {
    exited = true; exitCode = code;
    if (status === "passed" && code !== 0) status = "failed";
    // A parent can exit while its descendants still own output pipes.
    void stop();
  });
  child.on("close", () => { closed = true; onClosed(); });
  const cancel = (): void => { if (status !== "uncertain") status = "cancelled"; void stop(); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { if (status !== "uncertain") status = "timed_out"; void stop(); }, options.timeoutMs);
  let expiresAt = started + WORKFLOW_LIMITS.logRetentionMs;
  try {
    await Promise.race([closedPromise, new Promise<void>(resolve => {
      // stop() is always bounded even when a stream never emits close.
      const poll = (): void => {
        if (closed) { resolve(); return; }
        if (stopping) { void stopping.then(resolve); return; }
        setTimeout(poll, 25);
      };
      poll();
    })]);
    if (stopping) await stopping;
    if (!exited && !spawnFailed) status = "uncertain";
    if (ioFailed) status = "uncertain";
    try { fsyncSync(fd); expiresAt = Math.ceil(fstatSync(fd).mtimeMs) + WORKFLOW_LIMITS.logRetentionMs; } catch { status = "uncertain"; }
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
    child.stdout?.removeListener("data", receive); child.stderr?.removeListener("data", receive);
    child.stdout?.destroy(); child.stderr?.destroy();
    closeSync(fd);
  }
  return {
    status, exitCode, durationMs: Date.now() - started, outputBytes, checkedAt: Date.now(), bindingStatus: "unavailable",
    log: { id, bytes, sha256: hash.digest("hex"), truncated: outputBytes > bytes, expiresAt },
  };
}
