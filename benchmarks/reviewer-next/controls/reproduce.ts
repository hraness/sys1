import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadControls } from "./corpus.ts";

const corpus = loadControls();
const fixtures = new Map([...corpus.fixtures, ...corpus.diagnostics].map(f => [f.id, f]));
const source = (id: string) => fixtures.get(id)!.state.split("\n")
  .filter(line => line.startsWith("+") && !line.startsWith("+++ b/"))
  .map(line => line.slice(1)).join("\n") + "\n";
// Only fixed, reviewed public helper bodies are executed. TypeScript erasure
// and an export accessor do not change their control flow. Dependencies below
// are explicit; this is not the originating repositories' entire test suites.
const helpers = (id: string, names: string[], dependencies: Record<string, unknown> = {}) => {
  const code = ts.transpileModule(source(id), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const injected = { exports: {}, isAbsolute, join, relative, resolve, sep, ...dependencies };
  return new Function(...Object.keys(injected), `${code}\nreturn {${names.join(",")}};`)(...Object.values(injected));
};
let assertions = 0;
const eq = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); assertions++; };
const rejects = (run: () => unknown) => { assert.throws(run); assertions++; };
const outcomes: Record<string, unknown>[] = [];
const sandbox = await mkdtemp(join(tmpdir(), "sys1-control-proof-"));

try {
  // Materialize all temporary modules before the first dynamic import so Bun's
  // directory resolver cache sees the complete module set.
  await Promise.all([
    writeFile(join(sandbox, "serve.ts"), source("wordcell-http-containment")),
    ...(["before", "after"] as const).map(state => writeFile(join(sandbox, `${state}-note-lock.ts`), source(`wordcell-release-${state}`))),
  ]);
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const installNavigator = (value: unknown) => Object.defineProperty(globalThis, "navigator", { configurable: true, value });
  try {
    const share = helpers("design-kit-share-await", ["shareFileNatively", "canShareFileNatively"]);
    const file = new File(["example"], "example.txt", { type: "text/plain" });
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    let settled = false;
    installNavigator({ canShare: () => true, share: async (data: unknown) => { eq(data, { files: [file] }); await pending; } });
    const sharing = share.shareFileNatively(file).then((result: unknown) => { settled = true; return result; });
    await Promise.resolve(); eq(settled, false); complete(); eq(await sharing, { kind: "shared" });
    installNavigator({ canShare: () => true, share: async () => { throw { name: "AbortError" }; } });
    eq(await share.shareFileNatively(file), { kind: "cancelled" });
    const error = new Error("controlled failure");
    installNavigator({ canShare: () => true, share: async () => { throw error; } });
    eq(await share.shareFileNatively(file), { kind: "failed", error });
    installNavigator({ canShare: () => { throw error; }, share: async () => undefined });
    eq(await share.shareFileNatively(file), { kind: "unavailable" });
    installNavigator(undefined); eq(await share.shareFileNatively(file), { kind: "unavailable" });
    outcomes.push({ id: "design-kit-share-await", result: "pending share does not report shared; completed/cancelled/failed/unavailable outcomes preserved" });
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }

  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalTimeout = globalThis.setTimeout;
  try {
    const events: string[] = []; let cleanup: (() => void) | undefined;
    const anchor = { click: () => events.push("click"), remove: () => events.push("remove") };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      createElement: () => anchor, body: { append: () => events.push("append") },
    } });
    URL.createObjectURL = () => "blob:controlled";
    URL.revokeObjectURL = () => { events.push("revoke"); };
    globalThis.setTimeout = ((callback: () => void) => { cleanup = callback; return 0; }) as unknown as typeof setTimeout;
    helpers("design-kit-download-revocation", ["downloadBlob"]).downloadBlob(new Blob(["example"]), "example.txt");
    eq(events, ["append", "click", "remove"]); assert(cleanup); assertions++; cleanup();
    eq(events, ["append", "click", "remove", "revoke"]);
    outcomes.push({ id: "design-kit-download-revocation", result: "download activation is dispatched before deferred object-URL cleanup" });
  } finally {
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; globalThis.setTimeout = originalTimeout;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }

  const bundle = helpers("wordcell-bundle-containment", ["confinedRelativePath", "confined"]);
  const root = resolve(sandbox, "bundle");
  for (const path of ["../escape", "a/../escape", "a\\escape", "/escape", "a//b", "a/./b", "a\0b", ""]) {
    rejects(() => bundle.confinedRelativePath(path, "test"));
  }
  eq(bundle.confinedRelativePath("media/photo.png", "test"), "media/photo.png");
  eq(bundle.confined({ path: root }, "media/photo.png", "test"), join(root, "media/photo.png"));
  rejects(() => bundle.confined({ path: root }, "../escape", "test"));
  rejects(() => bundle.confined({ path: root }, ".", "test"));
  outcomes.push({ id: "wordcell-bundle-containment", result: "unsafe components and escaping resolved paths rejected; nested contained path accepted" });

  const artifact = helpers("ghostget-artifact-containment", ["safeRelativePath", "containedPath", "relativeArtifactPath"]);
  for (const path of ["../escape", "a/../escape", "a\\escape", "/escape", "a//b", "a/./b", "a\0b", ""]) {
    eq(artifact.safeRelativePath(path), false); rejects(() => artifact.containedPath(root, path));
  }
  eq(artifact.containedPath(root, "media/photo.png"), join(root, "media/photo.png"));
  eq(artifact.relativeArtifactPath(root, join(root, "media/photo.png")), "media/photo.png");
  rejects(() => artifact.relativeArtifactPath(root, join(root, "../escape")));
  outcomes.push({ id: "ghostget-artifact-containment", result: "unsafe relative paths rejected; valid nested artifact retained" });

  const home = helpers("sys1-state-home-override", ["sys1Home"], { homedir: () => root });
  eq(home.sys1Home({ SYS1_HOME: "custom-state" }), "custom-state");
  eq(home.sys1Home({}), join(root, ".sys1")); eq(home.sys1Home({ SYS1_HOME: "" }), join(root, ".sys1"));
  outcomes.push({ id: "sys1-state-home-override", result: "valid explicit state directory wins; missing and empty overrides use default" });
  const router = helpers("sys1-explicit-backend-pin", ["chooseBackend"]);
  const hosted = { name: "hosted", kind: "hosted", models: ["model"], available: true, size_b: null, cost_rank: 0 };
  const local = { name: "local", kind: "local", models: ["model"], available: true, size_b: 1, cost_rank: 1 };
  eq(router.chooseBackend("prefer-hosted", "local/model", [hosted, local]).backend.name, "local");
  eq(router.chooseBackend("prefer-hosted", "local/model", [hosted, { ...local, available: false }]).reason, "model_unavailable");
  eq(router.chooseBackend("hosted-only", "local/model", [hosted, local]).reason, "policy_restricted");
  outcomes.push({ id: "sys1-explicit-backend-pin", result: "valid explicit pin wins; unavailable and policy-excluded pins fail explicitly" });
  const aspect = helpers("slopcamera-requested-aspect", ["providerVideoResolution"]);
  eq(aspect.providerVideoResolution("alibaba/wan-model", "720p", undefined), "1280x720");
  eq(aspect.providerVideoResolution("alibaba/wan-model", "720p", "9:16"), "720x1280");
  eq(aspect.providerVideoResolution("alibaba/wan-model", "720p", "2:1"), null);
  eq(aspect.providerVideoResolution("other/model", "720p", "9:16"), "720p");
  outcomes.push({ id: "slopcamera-requested-aspect", result: "requested aspect controls mapping; absent default and unsupported combination remain distinct" });

  const serveModule = join(sandbox, "serve.ts");
  const serve = await import(pathToFileURL(serveModule).href);
  const publicRoot = join(sandbox, "site"); await mkdir(publicRoot);
  await writeFile(join(publicRoot, "index.html"), "public"); await writeFile(join(sandbox, "secret.txt"), "outside");
  await symlink(join(sandbox, "secret.txt"), join(publicRoot, "link.txt"));
  const handler = await serve.createServeHandler(publicRoot);
  eq(await (await handler(new Request("http://example.invalid/"))).text(), "public");
  for (const path of ["/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/%ZZ", "/%5csecret.txt", "/%00", "/link.txt"]) {
    eq((await handler(new Request(`http://example.invalid${path}`))).status, 404);
  }
  outcomes.push({ id: "wordcell-http-containment", result: "public file served; traversal, malformed encoding, NUL, backslash and escaping symlink rejected without opening a listener" });

  for (const state of ["before", "after"] as const) {
    const modulePath = join(sandbox, `${state}-note-lock.ts`);
    const module = await import(pathToFileURL(modulePath).href);
    const vault = join(sandbox, `vault-${state}`); await mkdir(vault);
    let started!: () => void, proceed!: () => void;
    const paused = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { proceed = resolve; });
    const lock = await module.acquireNoteLock(vault, "example", { cacheHome: join(sandbox, `cache-${state}`),
      dependencies: { afterTombstoneMove: async () => { started(); await resume; } } });
    let firstResolved = false, secondResolved = false;
    const first = lock.release().then(() => { firstResolved = true; });
    await paused;
    const second = lock.release().then(() => { secondResolved = true; });
    try {
      await Promise.resolve(); await Promise.resolve();
      eq(firstResolved, false); eq(secondResolved, state === "before");
      outcomes.push({ id: `wordcell-release-${state}`, diagnostic_only: true, firstResolvedWhileCleanupPending: firstResolved,
        secondResolvedWhileCleanupPending: secondResolved });
    } finally { proceed(); await Promise.all([first, second]); }
    eq(firstResolved && secondResolved, true);
  }
} finally { await rm(sandbox, { recursive: true, force: true }); }
console.log(JSON.stringify({ command: "bun benchmarks/reviewer-next/controls/reproduce.ts", assertions, outcomes,
  limitations: ["No network, model, browser, native engine or sibling checkout is used.",
    "Browser APIs are explicit fakes; path and lease modules use a temporary filesystem.",
    "The two ordinary UI diffs have independent source review only; originating browser/UI suites were not rerun.",
    "Wordcell promise timing is diagnostic behavior, not an admitted success-rule violation.",
    "This script executes only the fixed reviewed source examples; it is not an untrusted-code sandbox."] }, null, 2));
