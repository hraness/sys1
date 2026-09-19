import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, configSchema, saveConfig } from "../src/config.ts";
import { runDoctor } from "../src/doctor.ts";
import { modelsDir, saveManifest } from "../src/local/store.ts";

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "sys1-doctor-test-"));
  homes.push(path);
  return path;
}

function nativeOk() {
  return Promise.resolve({
    ok: true as const,
    backend: "cpu",
    gpu_offloading: false,
    supported_backends: ["cpu"],
  });
}

const daemonStopped = async () => ({ state: "stopped" as const });

afterEach(() => {
  while (homes.length > 0) {
    const path = homes.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

describe("runDoctor", () => {
  test.each([42, undefined, -1, NaN, Infinity, 1.5])("includes only valid native probe timing: %s", async (elapsed_ms) => {
    const report = await runDoctor({
      home: home(),
      env: {},
      runtimeVersion: "1.3.14",
      nativeProbe: async () => ({ ...(await nativeOk()), ...(elapsed_ms === undefined ? {} : { elapsed_ms }) }),
      daemonProbe: daemonStopped,
    });
    const detail = report.checks.find((check) => check.id === "native.runtime")?.detail;
    expect(detail).toEqual({
      gpu_offloading: false,
      supported_backends: ["cpu"],
      ...(elapsed_ms === 42 ? { native_probe_ms: 42 } : {}),
    });
  });

  test("returns a stable ready report for valid defaults", async () => {
    const report = await runDoctor({
      home: home(),
      env: {},
      runtimeVersion: "1.3.14",
      nativeProbe: nativeOk,
      daemonProbe: daemonStopped,
    });
    expect(report.ok).toBe(true);
    expect(report.version).toBe(1);
    expect(report.checks.map((check) => check.id)).toEqual([
      "runtime.bun",
      "state.directory",
      "config",
      "native.runtime",
      "models.manifest",
      "models.files",
      "models.inventory",
      "routing.candidates",
      "daemon",
    ]);
    expect(report.checks.find((check) => check.id === "routing.candidates")?.status).toBe("warn");
    expect(report.counts).toEqual({ pass: 8, warn: 1, fail: 0 });
  });

  test("fails closed for an old runtime, invalid config and manifest", async () => {
    const dir = home();
    writeFileSync(configPath(dir), "not-json");
    saveManifest(dir, { version: 1, models: [] });
    writeFileSync(join(modelsDir(dir), "manifest.json"), "also-not-json");
    const report = await runDoctor({
      home: dir,
      env: {},
      runtimeVersion: "1.2.0",
      nativeProbe: async () => ({ ok: false, message: `${dir}/native missing` }),
      daemonProbe: daemonStopped,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "runtime.bun")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "config")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "models.manifest")?.status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain(dir);
  });

  test("detects an invalid admitted GGUF without hashing the file", async () => {
    const dir = home();
    saveManifest(dir, {
      version: 1,
      models: [
        {
          id: "broken",
          kind: "gguf",
          file: "broken.gguf",
          source: "test",
          sha256: "0".repeat(64),
          bytes: 32,
          context: 2048,
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    writeFileSync(join(modelsDir(dir), "broken.gguf"), Buffer.alloc(32));
    const report = await runDoctor({
      home: dir,
      env: {},
      runtimeVersion: "1.3.14",
      nativeProbe: nativeOk,
      daemonProbe: daemonStopped,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "models.files")?.status).toBe("fail");
  });

  test("reports policy-specific missing candidates", async () => {
    const dir = home();
    saveConfig(
      dir,
      configSchema.parse({
        version: 1,
        routing: { policy: "hosted-only" },
      }),
    );
    const report = await runDoctor({
      home: dir,
      env: {},
      runtimeVersion: "1.3.14",
      nativeProbe: nativeOk,
      daemonProbe: daemonStopped,
    });
    const routing = report.checks.find((check) => check.id === "routing.candidates");
    expect(routing?.status).toBe("fail");
    expect(routing?.summary).toContain("credential");
  });
});
