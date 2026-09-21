import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Supply dist/browser/index.js from the pinned checkout with its frozen
// dependencies installed. The source artifact is verified before bundling.
const root = resolve(import.meta.dir, "..");
const manifestPath = resolve(root, "site/vendor/hraness-appearance/provenance.json");
const manifest = await Bun.file(manifestPath).json();
const artifactPath = process.argv[2];
if (!artifactPath) throw new Error("Usage: bun scripts/build-site-appearance.ts <pinned-browser-artifact>");
const sourcePath = resolve(artifactPath);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
if (hash(source) !== manifest.browser.sha256) throw new Error("Shared browser artifact does not match the pinned digest");
const result = await Bun.build({
  entrypoints: [resolve(root, "scripts/site-appearance.js")],
  target: "browser",
  format: "iife",
  minify: true,
  plugins: [{
    name: "pinned-appearance",
    setup(build) {
      build.onResolve({ filter: /^@hraness\/design-kit\/browser$/ }, () => ({ path: sourcePath }));
    },
  }],
});
if (!result.success || result.outputs.length !== 1) throw new Error(`Appearance build failed: ${result.logs.join("\n")}`);
const output = new Uint8Array(await result.outputs[0]!.arrayBuffer());
await Bun.write(resolve(root, "site/appearance.js"), output);
manifest.bundle = { path: "site/appearance.js", sha256: hash(output), bytes: output.length, bunVersion: Bun.version };
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Shared appearance bundle: ${output.length} bytes`);
