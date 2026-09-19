import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;
const TYPESCRIPT_CLI = join(PACKAGE_ROOT, "node_modules/typescript/bin/tsc");

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: PACKAGE_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited with ${code}`);
  }
}

async function buildDist(): Promise<void> {
  const outdir = join(PACKAGE_ROOT, "dist");
  rmSync(outdir, { recursive: true, force: true });

  await run([
    process.execPath,
    "build",
    "src/index.ts",
    "--outdir",
    outdir,
    "--root",
    "src",
    "--target",
    "node",
    "--format",
    "esm",
    "--packages",
    "external",
  ]);
  await run([
    process.execPath,
    "build",
    "src/cli.ts",
    "--outdir",
    outdir,
    "--root",
    "src",
    "--target",
    "bun",
    "--format",
    "esm",
    "--packages",
    "external",
  ]);
  await run([process.execPath, TYPESCRIPT_CLI, "--project", "tsconfig.build.json", "--outDir", outdir]);

  const cliPath = join(outdir, "cli.js");
  const cliSource = readFileSync(cliPath, "utf8");
  writeFileSync(cliPath, `#!/usr/bin/env bun\n${cliSource}`, { mode: 0o755 });
  chmodSync(cliPath, 0o755);
  console.log("dist/: index.js, index.d.ts, cli.js");
}

if (import.meta.main) await buildDist();
