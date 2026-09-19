import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Keep artifacts available for recovery when owned descendant cleanup is uncertain. */
export class NativeCheckCleanupError extends Error {
  readonly code = "native_check_cleanup_unconfirmed";
  constructor() {
    super("native check could not confirm descendant cleanup");
    this.name = "NativeCheckCleanupError";
  }
  retainWorkspace(path: string): void {
    this.message += `; retained task workspace: ${path}`;
  }
}

interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Opt in only for the credential-free doctor JSON report. */
  diagnosticStdout?: boolean;
  maxOutputBytes?: number;
}

/** Bounded command execution; terminate only this command's owned process tree. */
export async function runNativeCheckCommand(command: string[], options: CommandOptions): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // POSIX gives this command its own process group. Windows uses taskkill
    // against the exact spawned PID, including its descendants.
    detached: process.platform !== "win32",
  });
  let failure: "timeout" | "output" | "io" | "interrupted" | undefined;
  let stopping: Promise<void> | undefined;
  const collection = new AbortController();
  const stop = (reason: "timeout" | "output" | "io" | "interrupted"): Promise<void> => {
    failure ??= reason;
    stopping ??= (async () => {
      try {
        if (process.platform === "win32") {
          // Once the parent has exited, taskkill cannot establish ownership
          // of descendants still holding its pipes. Fail closed and retain
          // the isolated install rather than deleting possibly live files.
          if (child.exitCode !== null) throw new NativeCheckCleanupError();
          const killer = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
            stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5_000, killSignal: 9,
          });
          const killed = await killer.exited;
          if (killed !== 0) throw new NativeCheckCleanupError();
        } else {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new NativeCheckCleanupError();
          }
        }
      } catch {
        throw new NativeCheckCleanupError();
      } finally {
        // Collect the direct child even if tree termination raced normal exit.
        if (child.exitCode === null) child.kill(9);
        await child.exited;
        // A pipe inherited by a failing installer must not extend the deadline.
        // Cancel readers without waiting for a foreign stream cleanup callback.
        collection.abort();
      }
    })();
    return stopping;
  };
  const interrupted = (): void => { void stop("interrupted").catch(() => {}); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, interrupted);
  const timer = setTimeout(() => { void stop("timeout").catch(() => {}); }, options.timeoutMs);
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = (): void => {
      rejectAbort(new Error("native check output collection cancelled"));
      void reader.cancel().catch(() => {});
    };
    collection.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        collection.signal.throwIfAborted();
        const next = await Promise.race([reader.read(), aborted]);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > (options.maxOutputBytes ?? MAX_OUTPUT_BYTES)) {
          await stop("output");
          throw new Error("native check output exceeded its byte limit");
        }
        chunks.push(next.value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks, bytes));
    } catch (error) {
      await stop("io");
      throw error;
    } finally {
      collection.signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  };
  try {
    // All streams and process exit settle before cleanup removes the owned
    // install prefix. A rejected reader must not leave npm running behind it.
    const [exit, stdout, stderr] = await Promise.allSettled([
      child.exited, read(child.stdout), read(child.stderr),
    ]);
    if (stopping !== undefined) await stopping;
    if (failure !== undefined) {
      throw new Error(failure === "timeout"
        ? `native check command timed out after ${options.timeoutMs}ms`
        : failure === "output" ? "native check command output exceeded its byte limit"
          : failure === "interrupted" ? "native check command interrupted"
          : "native check could not collect command output");
    }
    if (exit.status !== "fulfilled" || stdout.status !== "fulfilled" || stderr.status !== "fulfilled") {
      throw new Error("native check could not collect command output");
    }
    if (exit.value !== 0) {
      const diagnostic = options.diagnosticStdout ? `\n${stdout.value.slice(0, 8_000)}` : "";
      throw new Error(`${command[0] ?? "command"} exited ${exit.value}: ${stderr.value.slice(0, 2_000)}${diagnostic}`);
    }
    return stdout.value;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.removeListener(signal, interrupted);
  }
}

/** Install these exact bytes in a disposable prefix and exercise real native readiness. */
export async function nativeInstallSmoke(tarball: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "sys1-native-install-"));
  let cleanup = true;
  try {
    const prefix = join(work, "prefix");
    const home = join(work, "state");
    mkdirSync(prefix, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await runNativeCheckCommand([
      npm, "install", "--global", "--prefix", prefix,
      "--cache", join(work, "npm-cache"), "--no-audit", "--no-fund",
      "--allow-scripts=node-llama-cpp", resolve(tarball),
    ], { cwd: work, timeoutMs: 8 * 60_000 });
    const executable = process.platform === "win32"
      ? join(prefix, "sys1.cmd") : join(prefix, "bin", "sys1");
    // A fresh state directory leaves hosted inference disabled and contains
    // no models. Doctor loads only the native runtime; it never pulls weights.
    const doctor: unknown = JSON.parse(await runNativeCheckCommand(
      [executable, "doctor", "--json"], {
        cwd: work, env: { ...process.env, SYS1_HOME: home },
        timeoutMs: 45_000, diagnosticStdout: true,
      },
    ));
    if (doctor === null || typeof doctor !== "object" ||
        !("ok" in doctor) || doctor.ok !== true ||
        !("version" in doctor) || doctor.version !== 1) {
      throw new Error("installed package doctor did not report ready");
    }
    const checks = "checks" in doctor && Array.isArray(doctor.checks) ? doctor.checks : [];
    const native = checks.find((check: unknown): check is Record<string, unknown> =>
      check !== null && typeof check === "object" && "id" in check && check.id === "native.runtime");
    if (native?.["status"] !== "pass") throw new Error("installed package did not verify native readiness");
    const detail: unknown = native["detail"];
    if (detail !== null && typeof detail === "object" && "native_probe_ms" in detail &&
        typeof detail.native_probe_ms === "number" && Number.isFinite(detail.native_probe_ms) &&
        detail.native_probe_ms >= 0) {
      console.log(`installed native readiness verified in ${Math.round(detail.native_probe_ms)}ms`);
    }
  } catch (error) {
    if (error instanceof NativeCheckCleanupError) {
      cleanup = false;
      error.retainWorkspace(work);
    }
    throw error;
  } finally {
    if (cleanup) rmSync(work, { recursive: true, force: true });
  }
}
