import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const PACKAGE_NAME = "@hraness/sysone";
const MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;

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

interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

async function readBounded(stream: ReadableStream<Uint8Array>, kill: () => void): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        kill();
        throw new Error("package smoke command output exceeded 4 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks, bytes));
}

async function run(command: string[], options: RunOptions): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const kill = (): void => child.kill(9);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 120_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, kill),
      readBounded(child.stderr, kill),
    ]);
    if (timedOut) throw new Error(`command timed out: ${command.join(" ")}`);
    if (code !== 0) {
      throw new Error(`command failed (${code}): ${command.join(" ")}\n${stderr.slice(0, 2_000)}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactDependencies(manifest: Record<string, unknown>): string[] {
  const dependencies = record(manifest["dependencies"], "dependencies");
  const names = Object.keys(dependencies).sort();
  if (names.length !== 2 || names[0] !== "node-llama-cpp" || names[1] !== "zod") {
    throw new Error(`packed dependencies are unexpected: ${names.join(", ")}`);
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`dependency ${name} is not exactly pinned`);
    }
  }
  return names;
}

export async function packageSmoke(tarballArgument?: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "sysone-package-"));
  try {
    let tarball: string;
    if (tarballArgument === undefined) {
      const pack = Bun.spawn(
        ["npm", "pack", "--ignore-scripts", "--pack-destination", work],
        { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      const code = await pack.exited;
      if (code !== 0) {
        throw new Error(`npm pack exited ${code}: ${await new Response(pack.stderr).text()}`);
      }
      const filename = readdirSync(work).find((name) => name.endsWith(".tgz"));
      if (filename === undefined) throw new Error("npm pack produced no tarball");
      tarball = join(work, filename);
    } else {
      tarball = resolve(tarballArgument);
    }

    const listing = await run(["tar", "-tzf", tarball], { cwd: work });
    const entries = listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"));
    const missing = REQUIRED.filter((path) => !entries.includes(path));
    if (missing.length > 0) throw new Error(`package is missing: ${missing.join(", ")}`);
    const forbidden = entries.filter((entry) =>
      FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(prefix)),
    );
    if (forbidden.length > 0) {
      throw new Error(`package leaks build inputs: ${forbidden.join(", ")}`);
    }

    const stage = join(work, "stage");
    const consumer = join(work, "consumer");
    mkdirSync(stage);
    mkdirSync(consumer);
    await run(["tar", "-xzf", tarball, "-C", stage], { cwd: work });
    const packedRoot = realpathSync(join(stage, "package"));
    const manifest = record(
      JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8")) as unknown,
      "package.json",
    );
    if (manifest["name"] !== PACKAGE_NAME) throw new Error("packed package name is wrong");
    if (manifest["license"] !== "MIT") throw new Error("packed package license is wrong");
    if (manifest["type"] !== "module") throw new Error("packed package must be ESM");
    if (typeof manifest["version"] !== "string") throw new Error("packed package version is missing");
    const repository = record(manifest["repository"], "repository");
    if (
      repository["type"] !== "git" ||
      repository["url"] !== "git+https://github.com/hraness/sysone.git"
    ) {
      throw new Error("packed repository identity is wrong");
    }
    const publish = record(manifest["publishConfig"], "publishConfig");
    if (
      publish["access"] !== "public" ||
      publish["provenance"] !== true ||
      publish["registry"] !== "https://registry.npmjs.org"
    ) {
      throw new Error("packed publish configuration is wrong");
    }
    const engines = record(manifest["engines"], "engines");
    if (Object.keys(engines).length !== 1 || engines["bun"] !== ">=1.3.14") {
      throw new Error("packed runtime engine boundary is wrong");
    }
    const trusted = manifest["trustedDependencies"];
    if (!Array.isArray(trusted) || trusted.length !== 1 || trusted[0] !== "node-llama-cpp") {
      throw new Error("packed native installer trust boundary is wrong");
    }
    const bin = record(manifest["bin"], "bin");
    if (Object.keys(bin).length !== 1 || bin["sysone"] !== "dist/cli.js") {
      throw new Error("packed bin must be exactly sysone -> dist/cli.js");
    }
    const cli = readFileSync(join(packedRoot, "dist/cli.js"), "utf8");
    if (!cli.startsWith("#!/usr/bin/env bun\n")) throw new Error("packed CLI has the wrong shebang");
    const dependencies = exactDependencies(manifest);

    const modules = join(consumer, "node_modules");
    const packageTarget = join(modules, "@hraness", "sysone");
    mkdirSync(dirname(packageTarget), { recursive: true });
    renameSync(packedRoot, packageTarget);
    for (const dependency of dependencies) {
      const source = realpathSync(join(PACKAGE_ROOT, "node_modules", dependency));
      const destination = join(modules, dependency);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(source, destination, "dir");
    }
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    writeFileSync(
      join(consumer, "smoke.mjs"),
      [
        `import { DECISION_LABELS, isLoopbackHost, systemOneRequestSchema, systemOneResponseSchema } from "${PACKAGE_NAME}";`,
        `const parsed = systemOneRequestSchema.safeParse({ state: "x", questions: { q: { type: "noul" } } });`,
        `const response = systemOneResponseSchema.safeParse({ model: "smoke", answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 0 } });`,
        `if (!parsed.success || !response.success || DECISION_LABELS.length !== 35 || !isLoopbackHost("127.0.0.1"))`,
        `  throw new Error("packed public API failed");`,
        `console.log(JSON.stringify({ labels: DECISION_LABELS.length, loopback: true }));`,
      ].join("\n"),
    );

    const home = join(consumer, "home");
    const env = { ...process.env, SYSONE_HOME: home };
    const imported = JSON.parse(
      (await run([process.execPath, join(consumer, "smoke.mjs")], { cwd: consumer, env })).trim(),
    ) as unknown;
    if (record(imported, "public API output")["labels"] !== 35) {
      throw new Error("packed public API returned the wrong output");
    }
    const installedCli = join(packageTarget, "dist", "cli.js");
    const version = (await run([process.execPath, installedCli, "--version"], { cwd: consumer, env })).trim();
    if (version !== manifest["version"]) {
      throw new Error(`packed CLI version ${version} does not match ${String(manifest["version"])}`);
    }
    const help = await run([process.execPath, installedCli, "--help"], { cwd: consumer, env });
    if (!help.includes("doctor [--json]") || !help.includes("pull [MODEL]")) {
      throw new Error("packed CLI help is incomplete");
    }
    const models = JSON.parse(
      (await run([process.execPath, installedCli, "model", "list", "--json"], { cwd: consumer, env })).trim(),
    ) as unknown;
    if (!Array.isArray(record(models, "model list")["data"])) {
      throw new Error("packed CLI model list returned invalid JSON");
    }
    console.log(`standalone package verified (${entries.length} files, Bun ${Bun.version})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [tarball, extra] = process.argv.slice(2);
  if (extra !== undefined) throw new Error("usage: package-smoke.ts [PACKAGE.tgz]");
  await packageSmoke(tarball);
}
