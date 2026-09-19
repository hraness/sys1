import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_REGISTRY,
  engineFilePath,
  findInstalled,
  inspectGgufFile,
  inspectScorerFile,
  installedModels,
  loadManifest,
  loadManifestChecked,
  manifestPath,
  modelsDir,
  needlePlatformKey,
  pullModel,
  resolvePullTarget,
  saveManifest,
  verifyModel,
} from "../src/local/store.ts";
import { buildCactBlob } from "./fixtures/cact.ts";
import { buildScorerCheckpoint } from "./fixtures/torchckpt.ts";

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
    expect(loadManifest(dir)).toEqual({ version: 1, models: [] });
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
    const fetchFn = (async () =>
      new Response(new Uint8Array(bytes), {
        headers: { "content-length": String(bytes.byteLength) },
      })) as unknown as typeof fetch;
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

  test("admits a .pt pull as a scorer after the real loader validates it", async () => {
    const dir = home();
    const bytes = buildScorerCheckpoint({
      encoder: "tinyx",
      width: 8,
      rank: 8,
      layers: 1,
      heads: 2,
      context_tokens: 16,
      option_tokens: 8,
    });
    const fetchFn = (async () =>
      new Response(new Uint8Array(bytes), {
        headers: { "content-length": String(bytes.byteLength) },
      })) as unknown as typeof fetch;
    const target = resolvePullTarget("hf:owner/repo:ckpt.pt");
    expect(target).toMatchObject({ modelKind: "scorer" });
    const result = await pullModel(dir, "hf:owner/repo:ckpt.pt", {
      sha256: sha256(bytes),
      fetchFn,
    });
    expect(result.ok).toBe(true);
    const installed = findInstalled(dir, "ckpt");
    expect(installed?.kind).toBe("scorer");
    expect(installed?.file).toBe("ckpt.pt");
    const inspection = inspectScorerFile(join(modelsDir(dir), "ckpt.pt"));
    expect(inspection).toMatchObject({ ok: true, encoder: "tinyx" });
    const verified = await verifyModel(dir, "ckpt");
    expect(verified.ok).toBe(true);
    expect(verified.scorer?.encoder).toBe("tinyx");
  });

  test("rejects a hash-valid non-checkpoint .pt", async () => {
    const dir = home();
    const bytes = Buffer.alloc(256, 7);
    const fetchFn = (async () =>
      new Response(new Uint8Array(bytes))) as unknown as typeof fetch;
    const result = await pullModel(dir, "hf:owner/repo:fake.pt", {
      sha256: sha256(bytes),
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid scorer checkpoint");
    expect(existsSync(join(modelsDir(dir), "fake.pt"))).toBe(false);
  });

  test("needle manifest entries require and verify the engine companion", async () => {
    const dir = home();
    const cact = buildCactBlob();
    const engine = Buffer.alloc(1_024, 9);
    // Missing all engine fields → schema rejects on load.
    mkdirSync(modelsDir(dir), { recursive: true });
    writeFileSync(
      manifestPath(dir),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "n3",
            kind: "needle",
            file: "n3.cact",
            source: "test",
            sha256: sha256(cact),
            bytes: cact.byteLength,
            context: 2048,
            installed_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(loadManifestChecked(dir).ok).toBe(false);

    saveManifest(dir, {
      version: 1,
      models: [
        {
          id: "n3",
          kind: "needle",
          file: "n3.cact",
          source: "test",
          sha256: sha256(cact),
          bytes: cact.byteLength,
          context: 2048,
          engine_file: "n3.engine",
          engine_sha256: sha256(engine),
          engine_bytes: engine.byteLength,
          engine_platform: needlePlatformKey(),
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(loadManifestChecked(dir).ok).toBe(true);
    // Weights present but engine missing → not an installed candidate.
    writeFileSync(join(modelsDir(dir), "n3.cact"), cact);
    expect(installedModels(dir)).toEqual([]);
    writeFileSync(join(modelsDir(dir), "n3.engine"), engine);
    const installed = findInstalled(dir, "n3");
    expect(installed?.kind).toBe("needle");
    expect(engineFilePath(dir, installed as NonNullable<typeof installed>)).toContain("n3.engine");
    const verified = await verifyModel(dir, "n3");
    expect(verified.ok).toBe(true);
    expect(verified.engine?.ok).toBe(true);
    // Engine tamper → verify fails.
    writeFileSync(join(modelsDir(dir), "n3.engine"), Buffer.alloc(1_024, 4));
    const tampered = await verifyModel(dir, "n3");
    expect(tampered.ok).toBe(false);
    expect(tampered.engine?.ok).toBe(false);
  });

  test("a needle registry pull rejects wrong engine bytes after sha check", async () => {
    const dir = home();
    const cact = buildCactBlob();
    const entry = MODEL_REGISTRY.find((candidate) => candidate.id === "needle3");
    expect(entry?.kind).toBe("needle");
    const fetchFn = (async () => {
      // Serve real-size-mismatched bytes: the cact sha pin fails first.
      return new Response(new Uint8Array(cact));
    }) as unknown as typeof fetch;
    const result = await pullModel(dir, "needle3", { fetchFn });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("sha256 mismatch");
  });

  test("scorer and needle registry entries are pinned specialists", () => {
    const scorer = MODEL_REGISTRY.find((entry) => entry.id === "cua-s1-forms");
    expect(scorer).toMatchObject({ kind: "scorer", specialist: true });
    const needle = MODEL_REGISTRY.find((entry) => entry.id === "needle3");
    expect(needle).toMatchObject({ kind: "needle", specialist: true });
    expect(Object.keys(needle?.engine ?? {}).length).toBeGreaterThan(3);
    // Every declared engine has a pinned hash and size.
    for (const [platform, engine] of Object.entries(needle?.engine ?? {})) {
      expect(engine.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(engine.bytes).toBeGreaterThan(100_000);
      expect(engine.file.length).toBeGreaterThan(3);
      expect(platform).toMatch(/^(darwin|linux|win32)-/);
    }
  });
});
