import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageSmoke } from "./package-smoke.ts";
import { nativeInstallSmoke } from "./native-install-smoke.ts";

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
  await nativeInstallSmoke(tarball);
  console.log(`release install verified on ${process.platform}-${process.arch}`);
}

await main();
