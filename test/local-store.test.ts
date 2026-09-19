import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_REGISTRY,
  findInstalled,
  installedModels,
  loadManifest,
  loadManifestChecked,
  manifestPath,
  modelsDir,
  pullModel,
  resolvePullTarget,
  saveManifest,
  verifyModel,
} from "../src/local/store.ts";

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "sysone-local-test-"));
  homes.push(path);
  return path;
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
  });

  test("only lists manifest entries whose files exist", async () => {
    const dir = home();
    const entry = MODEL_REGISTRY[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    saveManifest(dir, {
      version: 1,
      models: [
        {
          id: entry.id,
          file: `${entry.id}.gguf`,
          size_b: entry.size_b,
          source: `hf:${entry.repo}:${entry.file}`,
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          bytes: 5,
          context: 2048,
          installed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(installedModels(dir)).toEqual([]);
    writeFileSync(join(modelsDir(dir), `${entry.id}.gguf`), "hello");
    expect(installedModels(dir)).toHaveLength(1);
    expect(findInstalled(dir, entry.id)?.id).toBe(entry.id);
    expect((await verifyModel(dir, entry.id)).ok).toBe(true);
    writeFileSync(join(modelsDir(dir), `${entry.id}.gguf`), "changed");
    expect((await verifyModel(dir, entry.id)).ok).toBe(false);
  });
});
