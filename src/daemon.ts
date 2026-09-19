import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { readBoundedText } from "./http.ts";
import { logPath, pidPath, loopbackHostSchema, type Sys1Config } from "./config.ts";

const pidFileSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  host: loopbackHostSchema,
  instance: z.string().uuid(),
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

export function gatewayUrl(host: string, port: number): string {
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export async function healthz(
  host: string,
  port: number,
  timeoutMs = 1_500,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`${gatewayUrl(host, port)}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ownedHealth(record: PidFile, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(`${gatewayUrl(record.host, record.port)}/healthz`, {
      headers: { authorization: `Bearer ${record.instance}` },
      signal: AbortSignal.timeout(1_500),
      redirect: "error",
    });
    if (!response.ok) return false;
    const value: unknown = JSON.parse(await readBoundedText(response, 4096, AbortSignal.timeout(1_500)));
    const parsed = z.object({ ok: z.literal(true), pid: z.number(), instance: z.string() }).safeParse(value);
    return parsed.success && parsed.data.pid === record.pid && parsed.data.instance === record.instance;
  } catch { return false; }
}

export type DaemonState =
  | { state: "running"; pid: number; port: number; host: string; started_at: string }
  | { state: "stale_pidfile"; pid: number }
  | { state: "foreign_listener"; port: number }
  | { state: "stopped" };

export async function daemonStatus(
  home: string,
  config: Sys1Config,
  fetchFn: typeof fetch = fetch,
): Promise<DaemonState> {
  const record = readPidFile(home);
  if (record !== null && processAlive(record.pid)) {
    if (await ownedHealth(record, fetchFn)) {
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
 * Spawn a detached `sys1 serve` child and wait for its health check. The
 * child writes the pid file itself after binding; this function only polls.
 */
export async function daemonUp(options: {
  home: string;
  config: Sys1Config;
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
      message: `already running (pid ${prior.pid}) at ${gatewayUrl(prior.host, prior.port)}`,
    };
  }
  if (prior.state === "foreign_listener") {
    return {
      ok: false,
      message: `port ${prior.port} already serves a health check not owned by sys1; pick another with --port`,
    };
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = openSync(logPath(home), "a");
  const child = Bun.spawn([process.execPath, cliEntry, "serve", "--daemon-child", "--port", String(config.gateway.port)], {
    stdin: "ignore",
    stdout: log,
    stderr: log,
    env: { ...env, SYS1_HOME: home },
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const record = readPidFile(home);
    if (record !== null && record.pid === child.pid && processAlive(record.pid)) {
      if (await ownedHealth(record, fetchFn)) {
        return {
          ok: true,
          message: "running",
          pid: record.pid,
          url: gatewayUrl(record.host, record.port),
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

export async function daemonDown(home: string, config: Sys1Config, fetchFn: typeof fetch = fetch): Promise<DownResult> {
  const record = readPidFile(home);
  if (record === null) {
    const state = await daemonStatus(home, config, fetchFn);
    if (state.state === "foreign_listener") {
      return {
        ok: false,
        message: `port ${state.port} answers but has no sys1 pid file; refusing to stop it`,
      };
    }
    return { ok: true, message: "not running" };
  }
  if (!processAlive(record.pid)) {
    rmSync(pidPath(home), { force: true });
    return { ok: true, message: "not running (cleared stale pid file)" };
  }
  if (!(await ownedHealth(record, fetchFn))) {
    return { ok: false, message: "daemon ownership could not be verified; refusing to signal a saved PID" };
  }
  try {
    const response = await fetchFn(`${gatewayUrl(record.host, record.port)}/_sys1/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${record.instance}` },
      signal: AbortSignal.timeout(1_500),
      redirect: "error",
    });
    if (response.status !== 202) return { ok: false, message: "daemon refused authenticated shutdown" };
    await response.body?.cancel();
  } catch {
    return { ok: false, message: "daemon shutdown could not be confirmed" };
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processAlive(record.pid) || readPidFile(home)?.instance !== record.instance) {
      return { ok: true, message: `stopped daemon ${record.pid}` };
    }
    await Bun.sleep(100);
  }
  return { ok: false, message: "daemon accepted shutdown but has not exited; no PID signal sent" };
}

/** Called by the detached `serve --daemon-child` process after binding. */
export function writePidFile(home: string, pid: number, host: string, port: number, instance: string): void {
  const temporary = `${pidPath(home)}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary,
      `${JSON.stringify({ pid, host, port, instance, started_at: new Date().toISOString() })}\n`,
      { mode: 0o600, flag: "wx" });
    renameSync(temporary, pidPath(home));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function clearPidFile(home: string, pid: number): void {
  const record = readPidFile(home);
  if (record !== null && record.pid === pid) {
    rmSync(pidPath(home), { force: true });
  }
}
