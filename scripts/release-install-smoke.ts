import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageSmoke } from "./package-smoke.ts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

async function readBounded(stream: ReadableStream<Uint8Array>, kill: () => void): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_OUTPUT_BYTES) {
        kill();
        throw new Error("release smoke output exceeded 4 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
}

async function run(command: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const child = Bun.spawn(command, {
    ...(env === undefined ? {} : { env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = (): void => child.kill(9);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    readBounded(child.stdout, kill),
    readBounded(child.stderr, kill),
  ]);
  if (code !== 0) {
    throw new Error(`${command[0] ?? "command"} exited ${code}: ${stderr.slice(0, 2_000)}`);
  }
  return stdout;
}

function releaseFile(directory: string, suffix: string): string {
  const matches = readdirSync(directory).filter((name) => name.endsWith(suffix));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`expected one ${suffix} release file, found ${matches.length}`);
  }
  return join(directory, matches[0]);
}

async function main(): Promise<void> {
  const [directoryArg, extra] = process.argv.slice(2);
  if (directoryArg === undefined || extra !== undefined) {
    throw new Error("usage: release-install-smoke.ts ARTIFACT_DIRECTORY");
  }
  const artifactId = process.env["ARTIFACT_ID"] ?? "";
  const artifactDigest = process.env["ARTIFACT_DIGEST"] ?? "";
  if (!/^[1-9][0-9]*$/.test(artifactId) || !/^[0-9a-f]{64}$/.test(artifactDigest)) {
    throw new Error("release artifact identity is invalid");
  }

  const directory = resolve(directoryArg);
  const tarball = releaseFile(directory, ".tgz");
  const sums = releaseFile(directory, "SHA256SUMS");
  const expectedLine = readFileSync(sums, "utf8").trim();
  const match = /^([0-9a-f]{64})  \.\/(.+\.tgz)$/.exec(expectedLine);
  if (match === null || match[2] !== tarball.split(/[\\/]/).at(-1)) {
    throw new Error("SHA256SUMS does not identify the release tarball");
  }
  const observed = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (observed !== match[1]) throw new Error("release tarball checksum mismatch");

  await packageSmoke(tarball);
  const root = process.env["RUNNER_TEMP"] ?? tmpdir();
  const prefix = join(root, "sysone-global");
  const home = join(root, "sysone-home");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run([
    npm,
    "install",
    "--global",
    "--prefix",
    prefix,
    "--allow-scripts=node-llama-cpp",
    tarball,
  ]);
  const executable =
    process.platform === "win32" ? join(prefix, "sysone.cmd") : join(prefix, "bin", "sysone");
  const doctor = JSON.parse(
    await run([executable, "doctor", "--json"], { ...process.env, SYSONE_HOME: home }),
  ) as { ok?: unknown; version?: unknown };
  if (doctor.ok !== true || doctor.version !== 1) {
    throw new Error("installed release doctor did not report ready");
  }
  console.log(`release install verified on ${process.platform}-${process.arch}`);
}

await main();
