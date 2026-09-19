import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { clearPidFile, daemonDown, daemonStatus, gatewayUrl, writePidFile } from "../src/daemon.ts";

test("a reused live PID with foreign health cannot be stopped", async () => {
  const home = mkdtempSync(join(tmpdir(), "sys1-pid-"));
  try {
    writePidFile(home, process.pid, "127.0.0.1", 13900, crypto.randomUUID());
    const seen: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return Response.json({ ok: true });
    }) as typeof fetch;
    expect((await daemonStatus(home, DEFAULT_CONFIG, fetchFn)).state).toBe("stale_pidfile");
    expect((await daemonDown(home, DEFAULT_CONFIG, fetchFn)).ok).toBe(false);
    expect(seen.every(url => url.endsWith("/healthz"))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("owned shutdown uses the authenticated endpoint, not a saved PID signal", async () => {
  const home = mkdtempSync(join(tmpdir(), "sys1-pid-"));
  const instance = crypto.randomUUID();
  try {
    writePidFile(home, process.pid, "127.0.0.1", 13900, instance);
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${instance}`);
      if (String(input).endsWith("/healthz")) return Response.json({ ok: true, pid: process.pid, instance });
      expect(init?.method).toBe("POST");
      clearPidFile(home, process.pid);
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    expect((await daemonDown(home, DEFAULT_CONFIG, fetchFn)).ok).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("IPv6 loopback URLs are bracketed", () => {
  expect(gatewayUrl("::1", 13900)).toBe("http://[::1]:13900");
});

test("rewriting a permissive pid file replaces it with private storage", () => {
  const home = mkdtempSync(join(tmpdir(), "sys1-pid-"));
  try {
    writePidFile(home, process.pid, "127.0.0.1", 13900, crypto.randomUUID());
    chmodSync(join(home, "daemon.json"), 0o644);
    writePidFile(home, process.pid, "127.0.0.1", 13900, crypto.randomUUID());
    if (process.platform !== "win32") expect(statSync(join(home, "daemon.json")).mode & 0o777).toBe(0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
