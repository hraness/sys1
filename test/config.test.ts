import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  configSchema,
  loadConfig,
  saveConfig,
  setConfigValue,
  sysoneHome,
} from "../src/config.ts";
import { clearPidFile, daemonStatus, readPidFile, writePidFile } from "../src/daemon.ts";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sysone-test-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

describe("config", () => {
  test("missing file yields defaults", () => {
    const loaded = loadConfig(tempHome());
    expect(loaded).toMatchObject({ ok: true, existed: false });
    if (loaded.ok) expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });

  test("save then load round-trips", () => {
    const home = tempHome();
    const config = configSchema.parse({
      version: 1,
      routing: { policy: "prefer-local" },
      backends: [
        { name: "openjev", base_url: "http://127.0.0.1:8080", model: "openjev-4b", size_b: 4 },
      ],
    });
    saveConfig(home, config);
    const loaded = loadConfig(home);
    expect(loaded).toMatchObject({ ok: true, existed: true });
    if (loaded.ok) {
      expect(loaded.config.routing.policy).toBe("prefer-local");
      expect(loaded.config.backends[0]?.name).toBe("openjev");
    }
  });

  test("invalid JSON reports an error", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.json"), "{nope");
    const loaded = loadConfig(home);
    expect(loaded.ok).toBe(false);
  });

  test("invalid schema reports the field", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, gateway: { port: -1 } }));
    const loaded = loadConfig(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.message).toContain("gateway.port");
  });

  test("setConfigValue sets and validates", () => {
    const result = setConfigValue(DEFAULT_CONFIG, "routing.policy", "local-only");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.routing.policy).toBe("local-only");

    const bad = setConfigValue(DEFAULT_CONFIG, "routing.policy", "chaos");
    expect(bad.ok).toBe(false);
  });

  test("setConfigValue coerces port numbers", () => {
    const result = setConfigValue(DEFAULT_CONFIG, "gateway.port", "14900");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.gateway.port).toBe(14900);
  });

  test("gateway host remains loopback-only", () => {
    expect(setConfigValue(DEFAULT_CONFIG, "gateway.host", "127.0.0.2").ok).toBe(true);
    expect(setConfigValue(DEFAULT_CONFIG, "gateway.host", "::1").ok).toBe(true);
    expect(setConfigValue(DEFAULT_CONFIG, "gateway.host", "0.0.0.0").ok).toBe(false);
    expect(setConfigValue(DEFAULT_CONFIG, "gateway.host", "192.168.1.2").ok).toBe(false);
  });

  test("SYSONE_HOME env overrides the state dir", () => {
    expect(sysoneHome({ SYSONE_HOME: "/tmp/custom" } as NodeJS.ProcessEnv)).toBe("/tmp/custom");
  });
});

describe("pid file", () => {
  test("write, read, clear round-trip", () => {
    const home = tempHome();
    writePidFile(home, 4321, "127.0.0.1", 13900);
    const record = readPidFile(home);
    expect(record).toMatchObject({ pid: 4321, port: 13900 });
    clearPidFile(home, 4321);
    expect(readPidFile(home)).toBeNull();
  });

  test("status reports a stale pid file without deleting it", async () => {
    const home = tempHome();
    writePidFile(home, 2_147_483_647, "127.0.0.1", 13900);
    const fetchFn = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const state = await daemonStatus(home, DEFAULT_CONFIG, fetchFn);
    expect(state.state).toBe("stale_pidfile");
    expect(readPidFile(home)?.pid).toBe(2_147_483_647);
  });

  test("clear refuses a different pid", () => {
    const home = tempHome();
    writePidFile(home, 4321, "127.0.0.1", 13900);
    clearPidFile(home, 9999);
    expect(readPidFile(home)?.pid).toBe(4321);
  });
});
