import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// sys1.io is served as static files, so the analytics bundle is committed.
// --check rebuilds it with the pinned Bun and posthog-js and requires the same
// bytes, so the deployed script always matches reviewed source.
const root = resolve(import.meta.dir, "..");
const output = "site/analytics.js";
const manifestPath = "site/analytics.provenance.json";
const sources = ["scripts/site-analytics.ts", "scripts/site-analytics-entry.ts"];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function build(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(root, "scripts/site-analytics-entry.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success || result.outputs.length !== 1) throw new Error(`Analytics build failed: ${result.logs.join("\n")}`);
  return `${(await result.outputs[0]!.text()).trim()}\n`;
}

async function manifest(bundle: string) {
  const posthogVersion = JSON.parse(await readFile(resolve(root, "node_modules/posthog-js/package.json"), "utf8")).version as string;
  const pinned = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).devDependencies["posthog-js"] as string;
  if (posthogVersion !== pinned) throw new Error(`Installed posthog-js ${posthogVersion} does not match pinned ${pinned}`);
  const files = await Promise.all(sources.map(async (path) => ({ path, sha256: digest(await readFile(resolve(root, path))) })));
  const consent = await Promise.all(["@hraness/posthog/consent", "@hraness/site-footer/consent"].map(async entry => ({
    entry,
    sha256: digest(await readFile(Bun.resolveSync(entry, root))),
  })));
  return { schemaVersion: 2, bun: Bun.version, posthogJs: posthogVersion, consent, entry: ["posthog-js/dist/module.slim.no-external", "posthog-js/dist/web-vitals.js"], sources: files, output: { path: output, sha256: digest(bundle), bytes: Buffer.byteLength(bundle) } };
}

const mode = process.argv[2];
const bundle = await build();
const expected = `${JSON.stringify(await manifest(bundle), null, 2)}\n`;
if (mode === "--write") {
  await writeFile(resolve(root, output), bundle);
  await writeFile(resolve(root, manifestPath), expected);
  console.log(`Wrote ${output} (${Buffer.byteLength(bundle)} bytes)`);
} else if (mode === "--check") {
  const [current, currentManifest] = await Promise.all([readFile(resolve(root, output), "utf8"), readFile(resolve(root, manifestPath), "utf8")]);
  if (current !== bundle || currentManifest !== expected) throw new Error("site/analytics.js is stale. Run bun run analytics:build.");
  console.log("Analytics bundle matches source");
} else {
  throw new Error("Usage: bun scripts/build-site-analytics.ts --write | --check");
}
