import { expect, test } from "bun:test";
import { runSys1Entrypoint } from "../src/cli-entry.ts";

test("the executable holds its update lease until product work completes", async () => {
  const order: string[] = [];
  await runSys1Entrypoint(["workflow", "check", "--", "version"], {
    daemonActive: () => false,
    update: async options => {
      expect(options.effectFree).toBe(false);
      expect(options.packageName).toBe("@hraness/sys1");
      order.push("update");
      return { handled: false, exitCode: 0, release: async () => { order.push("release"); } };
    },
    main: async () => { order.push("main"); await Promise.resolve(); order.push("completed"); },
  });
  expect(order).toEqual(["update", "main", "completed", "release"]);
});

test("a handled update never enters product work", async () => {
  const prior = process.exitCode;
  try {
    await runSys1Entrypoint(["update", "status"], {
      daemonActive: () => false,
      update: async () => ({ handled: true, exitCode: 1, release: async () => { throw new Error("already handled"); } }),
      main: async () => { throw new Error("product work must not start"); },
    });
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = prior ?? 0; }
});

test("a product failure still releases its installation", async () => {
  let released = false;
  await expect(runSys1Entrypoint(["workflow", "check", "--", "version"], {
    daemonActive: () => false,
    update: async () => ({ handled: false, exitCode: 0, release: async () => { released = true; } }),
    main: async () => { throw new Error("product failed"); },
  })).rejects.toThrow("product failed");
  expect(released).toBe(true);
});

import { sys1UpdatePolicy } from "../src/cli-args.ts";
import { daemonPreventsUpdate } from "../src/cli-service-update.ts";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Sys1 uses the product parser for controls, child arguments, and value flags", () => {
  for (const argv of [[], ["--help"], ["help", "workflow"], ["workflow", "--help"], ["--version"], ["version"]]) {
    expect(sys1UpdatePolicy(argv, {}).effectFree).toBe(true);
  }
  for (const argv of [["workflow", "check", "--", "--help"], ["review", "--", "--version"], ["backend", "add", "--name", "version"], ["config", "set", "--name", "-h"]]) {
    expect(sys1UpdatePolicy(argv, {}).effectFree).toBe(false);
  }
  expect(sys1UpdatePolicy(["serve", "--daemon-child"], {}).nested).toBe(true);
  expect(sys1UpdatePolicy(["serve"], { SYS1_UPDATE_NESTED: "1" }).nested).toBe(true);
});

test("live and unprovable legacy daemons keep their code; absent and dead daemons do not", () => {
  const home = mkdtempSync(join(tmpdir(), "sys1-update-test-"));
  const path = join(home, "daemon.json");
  const env = { SYS1_HOME: home };
  try {
    expect(daemonPreventsUpdate(env)).toBe(false);
    writeFileSync(path, JSON.stringify({ pid: 123 }));
    expect(daemonPreventsUpdate(env, () => true)).toBe(true);
    expect(daemonPreventsUpdate(env, () => false)).toBe(false);
    writeFileSync(path, "{"); expect(daemonPreventsUpdate(env)).toBe(true);
    writeFileSync(path, JSON.stringify({ pid: 0 })); expect(daemonPreventsUpdate(env)).toBe(true);
    writeFileSync(path, " ".repeat(4097)); expect(daemonPreventsUpdate(env)).toBe(true);
    rmSync(path); mkdirSync(path); expect(daemonPreventsUpdate(env)).toBe(true);
    rmSync(path, { recursive: true });
    if (process.platform !== "win32") {
      symlinkSync(join(home, "absent"), path);
      expect(daemonPreventsUpdate(env)).toBe(true);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a running gateway suppresses both automatic and explicit replacement", async () => {
  await runSys1Entrypoint(["status"], {
    daemonActive: () => true,
    update: async options => {
      expect(options.pinned).toBe(true);
      expect(options.effectFree).toBe(false);
      return { handled: false, exitCode: 0, release: async () => {} };
    },
    main: async () => {},
  });
});

test("help never reads the service pid file", async () => {
  await runSys1Entrypoint(["--help"], {
    daemonActive: () => { throw new Error("help must not read product state"); },
    update: async options => {
      expect(options.effectFree).toBe(true);
      return { handled: false, exitCode: 0, release: async () => {} };
    },
    main: async () => {},
  });
});
