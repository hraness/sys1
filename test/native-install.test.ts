import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCheckCleanupError, runNativeCheckCommand } from "../scripts/native-install-smoke.ts";

const cwd = import.meta.dir;

describe("native install command custody", () => {
  test("returns successful bounded output", async () => {
    const result = await runNativeCheckCommand([process.execPath, "-e", 'console.log("ready")'], { cwd, timeoutMs: 5_000 });
    expect(result.trim()).toBe("ready");
  });

  test("preserves failures and includes stdout only when explicitly requested", async () => {
    const command = [process.execPath, "-e", 'console.log("diagnostic marker"); process.exit(6)'];
    try {
      await runNativeCheckCommand(command, { cwd, timeoutMs: 5_000 });
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("exited 6");
      expect(String(error)).not.toContain("diagnostic marker");
    }
    await expect(runNativeCheckCommand(command, { cwd, timeoutMs: 5_000, diagnosticStdout: true }))
      .rejects.toThrow("diagnostic marker");
  });

  test("terminates and collects a stalled owned child at the deadline", async () => {
    const work = mkdtempSync(join(tmpdir(), "sys1-native-command-test-"));
    const pidFile = join(work, "pid");
    try {
      await expect(runNativeCheckCommand([
        process.execPath, "-e",
        'await Bun.write(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
        pidFile,
      ], { cwd: work, timeoutMs: 1_000 })).rejects.toThrow("timed out");
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("output overflow terminates the command instead of leaving it running", async () => {
    await expect(runNativeCheckCommand([
      process.execPath, "-e", 'process.stdout.write("x".repeat(2048)); setInterval(() => {}, 1000)',
    ], { cwd, timeoutMs: 5_000, maxOutputBytes: 1024 })).rejects.toThrow("byte limit");
  });

  test("bounds inherited pipes after the direct child exits", async () => {
    const work = mkdtempSync(join(tmpdir(), "sys1-native-inherited-test-"));
    const pidFile = join(work, "descendant-pid");
    const started = Date.now();
    try {
      const error: unknown = await runNativeCheckCommand([
        process.execPath, "-e", [
          'const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });',
          'await Bun.write(process.argv[1], String(child.pid)); child.unref(); process.exit(0);',
        ].join("\n"), pidFile,
      ], { cwd: work, timeoutMs: 1_000 }).catch((failure: unknown) => failure);
      expect(Date.now() - started).toBeLessThan(8_000);
      if (typeof error === "string") {
        // Some Windows/Bun combinations collect the descendant when its
        // parent exits. Closed pipes are a valid success, not uncertain cleanup.
        expect(process.platform).toBe("win32");
      } else if (process.platform === "win32") {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(NativeCheckCleanupError);
        expect(error).toMatchObject({ code: "native_check_cleanup_unconfirmed" });
      } else {
        expect(String(error)).toContain("timed out");
      }
    } finally {
      // This fixture records the exact leaf it created so Windows can recover
      // the deliberately orphaned descendant after asserting fail-closed behavior.
      const pid = Number(readFileSync(pidFile, "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      rmSync(work, { recursive: true, force: true });
    }
  });
});
