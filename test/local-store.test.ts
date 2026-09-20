import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_REGISTRY,
  findInstalled,
  inspectGgufFile,
  installedModels,
  loadManifest,
  loadManifestChecked,
  manifestPath,
  modelsDir,
  pullModel,
  removeModel,
  resolvePullTarget,
  saveManifest,
  verifyModel,
} from "../src/local/store.ts";

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "sys1-local-test-"));
  homes.push(path);
  return path;
}

function gguf(version = 3, tensors = 1n, metadata = 1n): Buffer {
  const value = Buffer.alloc(32);
  value.write("GGUF", 0, "ascii");
  value.writeUInt32LE(version, 4);
  value.writeBigUInt64LE(tensors, 8);
  value.writeBigUInt64LE(metadata, 16);
  value.write("fixture", 24, "ascii");
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  while (homes.length > 0) {
    const path = homes.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

describe("local model store", () => {
  test("resolves curated and Hugging Face pull refs", () => {
    const curated = resolvePullTarget("qwen3-0.6b");
    expect("kind" in curated && curated.kind).toBe("registry");
    const custom = resolvePullTarget("hf:owner/repo:model.Q4.gguf");
    expect(custom).toEqual({
      kind: "hf",
      modelKind: "gguf",
      repo: "owner/repo",
      file: "model.Q4.gguf",
      id: "model.q4",
    });
    expect(resolvePullTarget("hf:bad")).toHaveProperty("error");
    expect(resolvePullTarget("hf:owner/repo:../model.gguf")).toHaveProperty("error");
    expect(resolvePullTarget("unknown")).toHaveProperty("error");
  });

  test("reads malformed state safely and refuses to pull over it", async () => {
    const dir = home();
    saveManifest(dir, { version: 1, models: [] });
    writeFileSync(manifestPath(dir), "not-json");
    expect(() => loadManifest(dir)).toThrow("not valid JSON");
    expect(loadManifestChecked(dir).ok).toBe(false);
    const pulled = await pullModel(dir, "qwen3-0.6b");
    expect(pulled.ok).toBe(false);
    expect(pulled.message).toContain("not valid JSON");
    writeFileSync(
      manifestPath(dir),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "escape",
            kind: "gguf",
            file: "../../escape.gguf",
            source: "test",
            sha256: "0".repeat(64),
            bytes: 1,
            context: 2048,
            installed_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(loadManifestChecked(dir).ok).toBe(false);
  });

  test("only lists manifest entries whose files exist", async () => {
    const dir = home();
    const entry = MODEL_REGISTRY[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const bytes = gguf();
    saveManifest(dir, {
      version: 1,
      models: [
        {
          id: entry.id,
          kind: "gguf",
          file: `${entry.id}.gguf`,
          size_b: entry.size_b,
          source: `hf:${entry.repo}:${entry.file}`,
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
          context: 2048,
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(installedModels(dir)).toEqual([]);
    writeFileSync(join(modelsDir(dir), `${entry.id}.gguf`), bytes);
    expect(installedModels(dir)).toHaveLength(1);
    expect(findInstalled(dir, entry.id)?.id).toBe(entry.id);
    const verified = await verifyModel(dir, entry.id);
    expect(verified.ok).toBe(true);
    expect(verified.gguf?.version).toBe(3);
    writeFileSync(join(modelsDir(dir), `${entry.id}.gguf`), "changed");
    expect((await verifyModel(dir, entry.id)).ok).toBe(false);
  });

  test("bounds and validates the GGUF header", () => {
    const dir = home();
    const path = join(dir, "model.gguf");
    writeFileSync(path, gguf(2, 42n, 7n));
    expect(inspectGgufFile(path)).toEqual({
      ok: true,
      version: 2,
      tensors: 42,
      metadata_entries: 7,
      bytes: 32,
    });
    writeFileSync(path, gguf(4));
    expect(inspectGgufFile(path)).toEqual({ ok: false, message: "unsupported GGUF version 4" });
    writeFileSync(path, "not a gguf");
    expect(inspectGgufFile(path).ok).toBe(false);
  });

  test("admits a custom download only after hash and GGUF validation", async () => {
    const dir = home();
    const bytes = gguf();
    const fetchFn = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://huggingface.co/owner/repo/resolve/main/model.gguf");
      return new Response(new Uint8Array(bytes), {
        headers: { "content-length": String(bytes.byteLength) },
      });
    }) as unknown as typeof fetch;
    const result = await pullModel(dir, "hf:owner/repo:model.gguf", {
      sha256: sha256(bytes),
      fetchFn,
    });
    expect(result.ok).toBe(true);
    const installed = findInstalled(dir, "model");
    expect(installed?.size_b).toBeUndefined();
    expect(inspectGgufFile(join(modelsDir(dir), "model.gguf")).ok).toBe(true);
  });

  test("rejects and removes a hash-valid non-GGUF download", async () => {
    const dir = home();
    const bytes = Buffer.alloc(32, 1);
    const fetchFn = (async () =>
      new Response(new Uint8Array(bytes))) as unknown as typeof fetch;
    const result = await pullModel(dir, "hf:owner/repo:bad.gguf", {
      sha256: sha256(bytes),
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid GGUF");
    expect(existsSync(join(modelsDir(dir), "bad.gguf"))).toBe(false);
    expect(loadManifest(dir).models).toEqual([]);
  });

  test("curated pulls use an immutable revision for GGUF weights", async () => {
    const dir = home();
    const weights = gguf();
    const revision = "a".repeat(40);
    const fixture = {
      id: "qwen-revision-fixture",
      kind: "gguf" as const,
      size_b: 0.12,
      repo: "owner/revision-fixture",
      revision,
      file: "model.gguf",
      sha256: sha256(weights),
      bytes: weights.byteLength,
      context: 2048,
      description: "revision fixture",
    };
    const weightsUrl = `https://huggingface.co/${fixture.repo}/resolve/${revision}/model.gguf`;
    const requested: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === weightsUrl) return new Response(new Uint8Array(weights));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    MODEL_REGISTRY.push(fixture);
    try {
      const result = await pullModel(dir, fixture.id, { fetchFn });
      expect(result.ok).toBe(true);
      expect(requested).toEqual([weightsUrl]);
      expect((await verifyModel(dir, fixture.id)).ok).toBe(true);
    } finally {
      MODEL_REGISTRY.splice(MODEL_REGISTRY.indexOf(fixture), 1);
    }
  });

  test("curated pulls reject mutable or malformed revisions before fetching", async () => {
    const base = MODEL_REGISTRY[0];
    if (base === undefined) throw new Error("missing curated model");
    for (const revision of ["main", "../main", "a".repeat(39), "g".repeat(40)]) {
      const dir = home();
      const fixture = { ...base, id: "invalid-revision-fixture", revision };
      let fetches = 0;
      const fetchFn = (async () => {
        fetches += 1;
        return new Response("unexpected fetch");
      }) as unknown as typeof fetch;
      MODEL_REGISTRY.push(fixture);
      try {
        const result = await pullModel(dir, fixture.id, { fetchFn });
        expect(result.ok).toBe(false);
        expect(result.message).toContain("invalid registry revision");
        expect(fetches).toBe(0);
        expect(existsSync(modelsDir(dir))).toBe(false);
      } finally {
        MODEL_REGISTRY.splice(MODEL_REGISTRY.indexOf(fixture), 1);
      }
    }
  });


  test("removed model formats and registry ids fail before downloading", () => {
    for (const ref of ["cua-s1-forms", "needle3", "hf:owner/repo:weights.pt", "hf:owner/repo:weights.cact"]) {
      expect(resolvePullTarget(ref)).toHaveProperty("error");
    }
    expect(MODEL_REGISTRY.map((entry) => entry.id).sort()).toEqual(["qwen3-0.6b", "qwen3-1.7b", "qwen3.5-4b"]);
  });

  test("Qwen3.5 candidate resolves to an immutable experimental artifact", () => {
    expect(resolvePullTarget("qwen3.5-4b")).toMatchObject({
      kind: "registry",
      entry: {
        id: "qwen3.5-4b",
        experimental: true,
        repo: "unsloth/Qwen3.5-4B-GGUF",
        revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
        file: "Qwen3.5-4B-Q4_K_M.gguf",
        bytes: 2_740_937_888,
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
      },
    });
  });

  test("legacy inventory blocks reads and mutations without changing any bytes", async () => {
    for (const kind of ["scorer", "needle"]) {
      const dir = home();
      mkdirSync(modelsDir(dir), { recursive: true });
      const filename = kind === "scorer" ? "old.pt" : "old.cact";
      const weights = Buffer.from("keep existing weights");
      const manifest = JSON.stringify({ version: 1, models: [{ id: "old", kind, file: filename }] });
      writeFileSync(manifestPath(dir), manifest);
      writeFileSync(join(modelsDir(dir), filename), weights);
      let fetches = 0;
      const fetchFn = (async () => { fetches++; throw new Error("unexpected network"); }) as unknown as typeof fetch;
      expect(loadManifestChecked(dir)).toMatchObject({ ok: false, message: expect.stringContaining("new SYS1_HOME") });
      expect(() => installedModels(dir)).toThrow("legacy");
      expect((await pullModel(dir, "qwen3-1.7b", { fetchFn })).ok).toBe(false);
      expect(removeModel(dir, "old").ok).toBe(false);
      expect((await verifyModel(dir, "old")).ok).toBe(false);
      expect(() => saveManifest(dir, { version: 1, models: [] })).toThrow("legacy");
      expect(fetches).toBe(0);
      expect(readFileSync(manifestPath(dir), "utf8")).toBe(manifest);
      expect(readFileSync(join(modelsDir(dir), filename))).toEqual(weights);
    }
  });

});
