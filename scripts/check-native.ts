import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeCheckCleanupError, nativeInstallSmoke, runNativeCheckCommand } from "./native-install-smoke.ts";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

/** Run after `bun run check`; reuse its validated dist without rebuilding. */
async function main(): Promise<void> {
  for (const entry of ["cli.js", "client.js", "engine-worker.js", "index.js"]) {
    if (!existsSync(join(PACKAGE_ROOT, "dist", entry))) {
      throw new Error("native check requires the dist produced by bun run check");
    }
  }
  const work = mkdtempSync(join(tmpdir(), "sys1-native-candidate-"));
  let cleanup = true;
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await runNativeCheckCommand([
      npm, "pack", "--ignore-scripts", "--pack-destination", work,
      "--cache", join(work, "npm-cache"),
    ], { cwd: PACKAGE_ROOT, timeoutMs: 60_000 });
    const tarballs = readdirSync(work).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1 || tarballs[0] === undefined) {
      throw new Error("native check expected one freshly packed candidate");
    }
    await nativeInstallSmoke(join(work, tarballs[0]));
    console.log(`native candidate install verified on ${process.platform}-${process.arch}`);
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

if (import.meta.main) await main();
