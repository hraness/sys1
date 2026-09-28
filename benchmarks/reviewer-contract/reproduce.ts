import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadContractCorpus, sha256 } from "./corpus.ts";

type Manifest = ReturnType<typeof loadContractCorpus>["manifest"];

// Every provider call is injected; accidental global Fetch calls fail locally.
globalThis.fetch = (() => { throw new Error("real network disabled in this reproducer"); }) as unknown as typeof fetch;

async function reproduceSnapshots(root: string, manifest: Manifest) {
  const output: unknown[] = [];
  let checks = 0;
  const same = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); checks += 1; };

  for (const snapshot of manifest.snapshots) {
    const { label, commit } = snapshot;
    const directory = join(root, 'snapshots', label);
    const { forwardToBackend } = await import(pathToFileURL(join(directory, 'src/backends.ts')).href);
    const { createFetchHandler } = await import(pathToFileURL(join(directory, 'src/gateway.ts')).href);
    const { configSchema } = await import(pathToFileURL(join(directory, 'src/config.ts')).href);
    const backend = { name: 'first', kind: 'hosted', available: true, models: ['m'],
      size_b: null, cost_rank: 0, base_url: 'https://provider.invalid', headers: {}, default_model: 'm' };
    const brokenResponse = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('synthetic stream failure')); },
    }), { status: 200 });
    let forwards = 0;
    const direct = await forwardToBackend(backend, '{}', undefined, 1000, async () => {
      forwards += 1;
      return brokenResponse();
    });
    same(forwards, 1);
    const broken = label === 'introduction' || label === 'repair_parent';
    same(direct.kind, broken ? 'transport' : 'response');
    if (!broken) {
      same(direct.status, 502);
      same(JSON.parse(direct.body).error.type, 'backend_response_unreadable');
    }
    const localHome = mkdtempSync(join(tmpdir(), 'sys1-finality-repro-'));
    try {
      const config = configSchema.parse({ version: 1, routing: { policy: 'auto' },
        hosted: { enabled: true, base_url: 'https://provider.invalid', model: 'm', api_key_env: 'FIXTURE_ONLY' },
        local: { enabled: false },
        backends: [{ name: 'second', base_url: 'http://127.0.0.1:18082', model: 'm', enabled: true }] });
      const scenarios: Record<string, unknown> = {};
      for (const scenario of ['broken_body', 'http_error', 'successful_body']) {
        const posts: string[] = [];
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith('/v1/models')) return Response.json({ data: ['m'] });
          if (url.endsWith('/v1/limits')) return new Response(null, { status: 404 });
          same(init?.method, 'POST');
          posts.push(url);
          if (scenario === 'broken_body') return brokenResponse();
          if (scenario === 'http_error') return Response.json({ error: { type: 'fixture', message: 'fixture' } }, { status: 503 });
          return Response.json({ model: 'm', answers: { q: { type: 'noul', noul: 0.9 } },
            usage: { input_tokens: 1, output_tokens: 1 } });
        }) as typeof fetch;
        const handler = createFetchHandler({ config, env: { FIXTURE_ONLY: 'not-a-credential' }, home: localHome, fetchFn });
        const response = await handler(new Request('http://127.0.0.1/v1/systemone', {
          method: 'POST', body: JSON.stringify({ state: 'fixture', questions: { q: { type: 'noul' } } }),
        }));
        const body = await response.json();
        same(posts.length, broken && scenario === 'broken_body' ? 2 : 1);
        same(response.status, scenario === 'successful_body' ? 200 : scenario === 'broken_body' && !broken ? 502 : 503);
        scenarios[scenario] = { posts: posts.length, response_status: response.status,
          response_error: (body as { error?: { type: string } }).error?.type ?? null };
      }
      output.push({ label, commit, direct_result: direct.kind,
        requirement_met: !broken, scenarios });
    } finally { rmSync(localHome, { recursive: true, force: true }); }
  }
  assert.equal(checks, manifest.reproduction.expected_assertions);
  assert.deepEqual(output, manifest.reproduction.results);
  return { version: 1, bun: Bun.version, checks,
    boundary: "Exact historical full source; real Fetch Response/ReadableStream; injected providers; no server or inference.",
    results: output };
}

function packageVersion(text: string): string | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("name" in value) || value.name !== "zod"
    || !("version" in value) || typeof value.version !== "string") return undefined;
  return value.version;
}

function copyInstalledZod(source: string, target: string, version: string): void {
  const packagePath = join(source, "package.json");
  const stat = lstatSync(packagePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65_536, "zod package.json must be a bounded regular file");
  assert.equal(packageVersion(readFileSync(packagePath, "utf8")), version, "supply an installed zod 4.6.2 package directory");
  let files = 0, bytes = 0;
  const copy = (from: string, to: string, depth: number): void => {
    assert(depth <= 32, "installed zod directory is too deep");
    const stat = lstatSync(from);
    assert(!stat.isSymbolicLink(), "installed zod must not contain nested symlinks");
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name), depth + 1);
    } else {
      assert(stat.isFile(), "installed zod contains a non-regular file");
      bytes += stat.size; files += 1;
      assert(files <= 10_000 && bytes <= 67_108_864, "installed zod exceeds copy limits");
      writeFileSync(to, readFileSync(from), { flag: "wx", mode: 0o600 });
    }
  };
  copy(source, target, 0);
  assert.equal(packageVersion(readFileSync(join(target, "package.json"), "utf8")), version);
}

function buildSnapshots(repo: string, root: string, manifest: Manifest): number {
  const gitPath = Bun.which("git");
  assert(gitPath !== null, "Git must be installed");
  const env = { PATH: dirname(gitPath), HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  const git = (args: string[]): Buffer => {
    const result = spawnSync(gitPath, ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
      "-c", "core.pager=cat", "-C", repo, ...args], { env, encoding: "buffer", timeout: 10_000,
      maxBuffer: 8_388_608, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.status, 0, "local Git source read failed; all pinned objects must already be present");
    return result.stdout;
  };
  // Reject lazy-fetch repositories before asking Git for an object.
  const config = git(["config", "--local", "--list"]).toString("utf8");
  assert(!/^extensions\.partialclone=/mi.test(config) && !/^remote\..*\.promisor=true$/mi.test(config),
    "supply a local Git repository with complete objects, not a partial clone");
  let total = 0;
  for (const snapshot of manifest.snapshots) {
    assert.equal(git(["rev-parse", "--verify", `${snapshot.commit}^{commit}`]).toString("utf8").trim(), snapshot.commit);
    assert.equal(git(["rev-parse", `${snapshot.commit}:src`]).toString("utf8").trim(), snapshot.src_tree);
    const destination = join(root, "snapshots", snapshot.label);
    mkdirSync(destination, { recursive: true });
    const entries = git(["ls-tree", "-rz", "--full-tree", snapshot.commit, "--", "src"]).toString("utf8").split("\0").filter(Boolean);
    assert.equal(entries.length, snapshot.source_files);
    for (const entry of entries) {
      const match = entry.match(/^100(?:644|755) blob ([0-9a-f]{40})\t(src\/[a-zA-Z0-9_./-]+)$/);
      assert(match !== null && !match[2]!.split("/").includes(".."), "source tree must contain only regular source files");
      const content = git(["cat-file", "blob", match[1]!]);
      const target = join(destination, match[2]!);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { flag: "wx", mode: 0o600 });
      total += 1;
    }
    for (const [path, expected] of Object.entries(snapshot.files)) {
      const content = git(["show", `${snapshot.commit}:${path}`]);
      assert.equal(sha256(content), expected, "historical file hash mismatch");
      if (path.startsWith("src/")) assert.equal(sha256(readFileSync(join(destination, path))), expected);
      else writeFileSync(join(destination, path), content, { flag: "wx", mode: 0o600 });
    }
    const historicalPackage: unknown = JSON.parse(readFileSync(join(destination, "package.json"), "utf8"));
    assert(typeof historicalPackage === "object" && historicalPackage !== null && "dependencies" in historicalPackage);
    const dependencies = historicalPackage.dependencies;
    assert(typeof dependencies === "object" && dependencies !== null && "zod" in dependencies);
    assert.equal(dependencies.zod, manifest.reproduction.zod, "historical dependency pin must match installed zod");
  }
  for (const source of manifest.requirement_sources) {
    assert.equal(sha256(git(["show", `${source.commit}:${source.path}`])), source.sha256);
  }
  const fixtures = loadContractCorpus().fixtures;
  for (const diff of manifest.diffs) {
    const common = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=15", "--inter-hunk-context=0",
      "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/",
      "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= "];
    const args = diff.parent === null
      ? ["show", "--format=", "--root", ...common, diff.commit, "--", manifest.path]
      : ["diff", ...common, diff.parent, diff.commit, "--", manifest.path];
    const patch = git(args).toString("utf8");
    const historicalHunks = patch.slice(patch.search(/^@@ /m));
    const fixtureHunks = manifest.units.filter(unit => unit.role === diff.role).map(unit => {
      const state: unknown = JSON.parse(fixtures.find(fixture => fixture.id === unit.id)!.state);
      assert(typeof state === "object" && state !== null && "patch" in state && typeof state.patch === "string");
      return state.patch.slice(state.patch.search(/^@@ /m));
    }).join("");
    assert.equal(fixtureHunks, historicalHunks, "fixtures must preserve every authentic hunk byte");
  }
  return total;
}

const usage = "Usage: bun --no-env-file --no-install benchmarks/reviewer-contract/reproduce.ts --repo /path/to/sys1-git --zod /path/to/installed/zod";
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const { manifest } = loadContractCorpus();
  assert.equal(Bun.version, manifest.reproduction.bun, "use Bun 1.3.14");
  if (args.length === 2 && args[0] === "--worker" && process.env["SYS1_REPRO_WORKER"] === "1") {
    console.log(JSON.stringify(await reproduceSnapshots(realpathSync(args[1]!), manifest), null, 2));
    return;
  }
  assert(args.length === 4 && args[0] === "--repo" && args[2] === "--zod", usage);
  const repo = realpathSync(resolve(args[1]!));
  const zod = realpathSync(resolve(args[3]!));
  assert(lstatSync(repo).isDirectory() && lstatSync(zod).isDirectory(), "repository and zod paths must be directories");
  const root = mkdtempSync(join(tmpdir(), "sys1-contract-repro-"));
  try {
    for (const name of ["home", "tmp"]) mkdirSync(join(root, name));
    const sourceFiles = buildSnapshots(repo, root, manifest);
    copyInstalledZod(zod, join(root, "node_modules", "zod"), manifest.reproduction.zod);
    const child = spawnSync(process.execPath, ["--no-env-file", "--no-install", "--no-addons", import.meta.filename, "--worker", root], {
      cwd: root, env: { PATH: dirname(process.execPath), HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
        SYS1_REPRO_WORKER: "1" }, encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(child.status, 0, `historical reproduction failed: ${child.stderr}`);
    const result: unknown = JSON.parse(child.stdout);
    assert(typeof result === "object" && result !== null && "checks" in result && result.checks === 63);
    console.log(JSON.stringify({ ...result, source_files_verified: sourceFiles, requests: 0 }, null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) await main();
