import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, configSchema } from "../src/config.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(PROJECT_ROOT, "src", "cli.ts");
const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "sys1-cli-test-"));
  homes.push(path);
  return path;
}

async function runCli(
  args: string[],
  options: { home: string; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, SYS1_HOME: options.home, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(() => {
  while (homes.length > 0) {
    const path = homes.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

describe("setup CLI", () => {
  test("dry-run reports an explicit compact recommendation without downloading", async () => {
    const dir = home();
    const result = await runCli(["setup", "--dry-run", "--tier", "compact", "--json"], {
      home: dir,
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      dry_run: boolean;
      recommendation: { model: string; tier: string; supported: boolean };
    };
    expect(report).toMatchObject({
      ok: true,
      dry_run: true,
      recommendation: { model: "qwen3-0.6b", tier: "compact", supported: true },
    });
    expect(loadConfig(dir)).toMatchObject({ ok: true, existed: false });
  });
});

describe("Jev CLI", () => {
  test("a credential does not activate Jev until explicitly enabled", async () => {
    const dir = home();
    const result = await runCli(["jev", "status", "--json"], {
      home: dir,
      env: { TYPESAFE_API_KEY: "super-secret" },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      enabled: false,
      credential_present: true,
      active: false,
    });
    expect(result.stdout).not.toContain("super-secret");
  });

  test("enable requires an environment credential and never persists it", async () => {
    const dir = home();
    const missing = await runCli(["jev", "enable"], { home: dir });
    expect(missing.code).toBe(3);
    expect(loadConfig(dir)).toMatchObject({ ok: true, existed: false });

    const enabled = await runCli(["jev", "enable", "--json"], {
      home: dir,
      env: { TYPESAFE_API_KEY: "super-secret" },
    });
    expect(enabled.code).toBe(0);
    expect(JSON.parse(enabled.stdout)).toMatchObject({ enabled: true, active: true });
    const loaded = loadConfig(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.hosted.enabled).toBe(true);
      expect(loaded.config.routing.policy).toBe("auto");
      expect(JSON.stringify(loaded.config)).not.toContain("super-secret");
    }
    expect(`${enabled.stdout}${enabled.stderr}`).not.toContain("super-secret");
  });

  test("disable repairs hosted-only routing", async () => {
    const dir = home();
    saveConfig(
      dir,
      configSchema.parse({
        version: 1,
        hosted: { enabled: true },
        routing: { policy: "hosted-only" },
      }),
    );
    const disabled = await runCli(["jev", "disable", "--json"], { home: dir });
    expect(disabled.code).toBe(0);
    expect(JSON.parse(disabled.stdout)).toMatchObject({ enabled: false, active: false });
    const loaded = loadConfig(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.hosted.enabled).toBe(false);
      expect(loaded.config.routing.policy).toBe("auto");
    }
  });
});
