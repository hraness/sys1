import { strict as assert } from "node:assert";
import { z } from "zod";
import { loadReviewerCorpus, sha256 } from "./corpus.ts";

/** Execute only the frozen public function/schema excerpts, with explicit small
 * dependency stubs. This is behavioral evidence, not full-application coverage. */
export async function reproduceReviewerDefects() {
  const corpus = await loadReviewerCorpus();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  function excerpts(id: string): string[] {
    const index = corpus.fixtures.findIndex(fixture => fixture.id === id);
    assert(index >= 0);
    const fixture = corpus.fixtures[index]!;
    const unit = corpus.manifest.units[index]!;
    const chunks = [...fixture.state.matchAll(/@@ -0,0 \+\d+,\d+ @@\n([\s\S]*?)(?=diff --git |$)/g)].map(match =>
      `${match[1]!.trimEnd().split("\n").map(line => { assert(line.startsWith("+")); return line.slice(1); }).join("\n")}\n`);
    assert.equal(chunks.length, unit.sections.length);
    chunks.forEach((chunk, part) => assert.equal(sha256(chunk), unit.sections[part]!.excerpt_sha256));
    return chunks;
  }
  function factory(source: string, name: string, parameterNames: string[] = []): (...args: unknown[]) => unknown {
    const code = transpiler.transformSync(source.replace(/\bexport /g, ""));
    return new Function(...parameterNames, `${code}\nreturn ${name};`) as (...args: unknown[]) => unknown;
  }
  const manifestInput = { version: 1, models: [{ id: "demo", file: "../../escape.gguf", source: "https://example.invalid/demo.gguf",
    sha256: "0".repeat(64), bytes: 1, installed_at: "2026-09-27" }] };
  function acceptsManifest(id: string): boolean {
    // maxModels only controls count; one entry makes its exact limit immaterial.
    const schema = factory(excerpts(id)[0]!, "manifestSchema", ["z", "MODEL_LIMITS"])(z, { maxModels: 100 }) as z.ZodType;
    return schema.safeParse(manifestInput).success;
  }
  const traversalBefore = acceptsManifest("sys1-manifest-before");
  const traversalAfter = acceptsManifest("sys1-manifest-after");
  assert.equal(traversalBefore, true);
  assert.equal(traversalAfter, false);

  type Handler = (result: { kind: string; refreshToken: string }, session: { saveRefreshToken: () => Promise<void> }) => unknown;
  async function login(id: string) {
    const handler = factory(excerpts(id)[0]!, "handlePollResult")() as Handler;
    let release = () => {};
    const storage = new Promise<void>(resolve => { release = resolve; });
    let settledBeforeSave = false;
    const completion = Promise.resolve(handler({ kind: "token", refreshToken: "test-only" }, { saveRefreshToken: () => storage }))
      .then(result => { settledBeforeSave = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    const reportsBeforeSave = settledBeforeSave;
    release();
    assert.deepEqual(await completion, { kind: "success", message: "Signed in to Hraness Accounts. You can return to your terminal." });
    const failure = Promise.reject(new Error("simulated storage failure"));
    // The old implementation ignores rejection; attach a harness observer so
    // the deliberate historical failure does not become an unhandled rejection.
    void failure.catch(() => {});
    const rejected = await handler({ kind: "token", refreshToken: "test-only" }, { saveRefreshToken: () => failure }) as { kind: string };
    return { reports_before_save: reportsBeforeSave, failed_storage_result: rejected.kind };
  }
  const loginBefore = await login("ghostget-login-before");
  const loginAfter = await login("ghostget-login-after");
  assert.deepEqual(loginBefore, { reports_before_save: true, failed_storage_result: "success" });
  assert.deepEqual(loginAfter, { reports_before_save: false, failed_storage_result: "error" });

  function theme(id: string) {
    const parts = excerpts(id);
    const expression = parts[0]!.match(/const portalTheme = ([\s\S]*?);/);
    assert(expression !== null);
    const helper = parts[1] === undefined ? undefined : factory(parts[1], "resolveEffectiveTheme")();
    return new Function("forcedTheme", "resolvedTheme", "resolveEffectiveTheme", `return (${expression[1]});`)("dark", "light", helper) as string;
  }
  const themeBefore = theme("design-kit-forced-before");
  const themeAfter = theme("design-kit-forced-after");
  assert.equal(themeBefore, "light");
  assert.equal(themeAfter, "dark");
  return {
    command: "bun benchmarks/reviewer/reproduce.ts", status: "passed", families: 3,
    manifest_sha256: corpus.manifest_sha256, fixtures_sha256: corpus.manifest.fixtures_sha256,
    toolchain: { bun: Bun.version, zod: "4.6.2" },
    cases: [
      { family: "sys1-manifest", stimulus: "manifest file ../../escape.gguf", before: { accepted: traversalBefore }, after: { accepted: traversalAfter } },
      { family: "ghostget-login", stimulus: "pending and rejected token save", before: loginBefore, after: loginAfter },
      { family: "design-kit-forced", stimulus: "forced dark, resolved light", before: { theme: themeBefore }, after: { theme: themeAfter } },
    ],
    limitations: ["Exact original excerpts, with mocked storage and maxModels; not original whole-repository regression suites.",
      "Theme check executes the original value computation and helper, not React rendering or browser event ordering.",
      "Native label activation is supported by public repair/browser-test evidence; this script does not reproduce that browser case."],
  };
}
if (import.meta.main) console.log(JSON.stringify(await reproduceReviewerDefects(), null, 2));
