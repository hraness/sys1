import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { logPath, pidPath, type SysoneConfig } from "./config.ts";

const pidFileSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  host: z.string(),
  started_at: z.string(),
});

export type PidFile = z.infer<typeof pidFileSchema>;

export function readPidFile(home: string): PidFile | null {
  const path = pidPath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = pidFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function healthz(
  host: string,
  port: number,
  timeoutMs = 1_500,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type DaemonState =
  | { state: "running"; pid: number; port: number; host: string; started_at: string }
  | { state: "stale_pidfile"; pid: number }
  | { state: "foreign_listener"; port: number }
  | { state: "stopped" };

export async function daemonStatus(
  home: string,
  config: SysoneConfig,
  fetchFn: typeof fetch = fetch,
): Promise<DaemonState> {
  const record = readPidFile(home);
  if (record !== null && processAlive(record.pid)) {
    if (await healthz(record.host, record.port, 1_500, fetchFn)) {
      return {
        state: "running",
        pid: record.pid,
        port: record.port,
        host: record.host,
        started_at: record.started_at,
      };
    }
    return { state: "stale_pidfile", pid: record.pid };
  }
  if (record !== null) return { state: "stale_pidfile", pid: record.pid };
  if (await healthz(config.gateway.host, config.gateway.port, 800, fetchFn)) {
    return { state: "foreign_listener", port: config.gateway.port };
  }
  return { state: "stopped" };
}

export interface UpResult {
  ok: boolean;
  message: string;
  pid?: number;
  url?: string;
}

/**
 * Spawn a detached `sysone serve` child and wait for its health check. The
 * child writes the pid file itself after binding; this function only polls.
 */
export async function daemonUp(options: {
  home: string;
  config: SysoneConfig;
  cliEntry: string;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  waitMs?: number;
}): Promise<UpResult> {
  const { home, config, cliEntry, env } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const waitMs = options.waitMs ?? 8_000;

  const prior = await daemonStatus(home, config, fetchFn);
  if (prior.state === "running") {
    return {
      ok: false,
      message: `already running (pid ${prior.pid}) at http://${prior.host}:${prior.port}`,
    };
  }
  if (prior.state === "foreign_listener") {
    return {
      ok: false,
      message: `port ${prior.port} already serves a health check not owned by sysone; pick another with --port`,
    };
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = openSync(logPath(home), "a");
  const child = Bun.spawn([process.execPath, cliEntry, "serve", "--daemon-child"], {
    stdin: "ignore",
    stdout: log,
    stderr: log,
    env: { ...env, SYSONE_HOME: home },
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const record = readPidFile(home);
    if (record !== null && record.pid === child.pid && processAlive(record.pid)) {
      if (await healthz(record.host, record.port, 500, fetchFn)) {
        return {
          ok: true,
          message: "running",
          pid: record.pid,
          url: `http://${record.host}:${record.port}`,
        };
      }
    }
    if (child.exitCode !== null) {
      return {
        ok: false,
        message: `daemon exited during startup (code ${child.exitCode}); see ${logPath(home)}`,
      };
    }
    await Bun.sleep(100);
  }
  return { ok: false, message: `daemon did not become healthy within ${waitMs}ms` };
}

export interface DownResult {
  ok: boolean;
  message: string;
}

export async function daemonDown(home: string, config: SysoneConfig): Promise<DownResult> {
  const record = readPidFile(home);
  if (record === null) {
    const state = await daemonStatus(home, config);
    if (state.state === "foreign_listener") {
      return {
        ok: false,
        message: `port ${state.port} answers but has no sysone pid file; refusing to stop it`,
      };
    }
    return { ok: true, message: "not running" };
  }
  if (!processAlive(record.pid)) {
    rmSync(pidPath(home), { force: true });
    return { ok: true, message: "not running (cleared stale pid file)" };
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    rmSync(pidPath(home), { force: true });
    return { ok: false, message: `could not signal pid ${record.pid}` };
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processAlive(record.pid)) {
      rmSync(pidPath(home), { force: true });
      return { ok: true, message: `stopped pid ${record.pid}` };
    }
    await Bun.sleep(100);
  }
  try {
    process.kill(record.pid, "SIGKILL");
  } catch {
    // already gone
  }
  rmSync(pidPath(home), { force: true });
  return { ok: true, message: `stopped pid ${record.pid} (SIGKILL after grace period)` };
}

/** Called by the detached `serve --daemon-child` process after binding. */
export function writePidFile(home: string, pid: number, host: string, port: number): void {
  writeFileSync(
    pidPath(home),
    `${JSON.stringify({ pid, host, port, started_at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
}

export function clearPidFile(home: string, pid: number): void {
  const record = readPidFile(home);
  if (record !== null && record.pid === pid) {
    rmSync(pidPath(home), { force: true });
  }
}
