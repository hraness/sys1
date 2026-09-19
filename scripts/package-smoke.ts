import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;

const REQUIRED = [
  "package/package.json",
  "package/dist/cli.js",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/README.md",
  "package/LICENSE",
];

const FORBIDDEN_PREFIXES = [
  "package/src/",
  "package/test/",
  "package/scripts/",
  "package/site/",
  "package/docs/",
  "package/.github/",
  "package/node_modules/",
];

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "sysone-pack-"));
  try {
    const child = Bun.spawn(
      ["npm", "pack", "--ignore-scripts", "--pack-destination", work],
      { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const code = await child.exited;
    if (code !== 0) {
      throw new Error(`npm pack exited ${code}: ${await new Response(child.stderr).text()}`);
    }

    const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
    if (tarball === undefined) {
      throw new Error("npm pack produced no tarball");
    }
    const list = Bun.spawn(["tar", "-tzf", join(work, tarball)], {
      stdout: "pipe",
    });
    await list.exited;
    const entries = (await new Response(list.stdout).text())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"));

    const missing = REQUIRED.filter((path) => !entries.includes(path));
    if (missing.length > 0) {
      throw new Error(`package is missing: ${missing.join(", ")}`);
    }
    const forbidden = entries.filter((entry) =>
      FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(prefix)),
    );
    if (forbidden.length > 0) {
      throw new Error(`package leaks build inputs: ${forbidden.join(", ")}`);
    }
    console.log(`package contents ok (${entries.length} files)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
