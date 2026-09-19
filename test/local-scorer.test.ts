import { describe, expect, test } from "bun:test";
import { loadScorer } from "../src/local/scorer.ts";
import { TorchCheckpointError, loadTorchCheckpoint, readZip } from "../src/local/torchckpt.ts";
import { PickleWriter, buildScorerCheckpoint, buildZip } from "./fixtures/torchckpt.ts";

const TINYX = {
  encoder: "tinyx" as const,
  width: 8,
  rank: 8,
  layers: 1,
  heads: 2,
  context_tokens: 16,
  option_tokens: 8,
};

function fixture(config: Parameters<typeof buildScorerCheckpoint>[0] = TINYX): Uint8Array {
  return buildScorerCheckpoint(config);
}

describe("torch checkpoint loader", () => {
  test("reads zip members and rejects traversal names", () => {
    const zip = buildZip([
      { name: "a/b.txt", data: new Uint8Array([1, 2, 3]) },
      { name: "a/c.txt", data: new Uint8Array([4]) },
    ]);
    const members = readZip(zip);
    expect(members.get("a/b.txt")).toEqual(new Uint8Array([1, 2, 3]));
    expect(members.get("a/c.txt")).toEqual(new Uint8Array([4]));

    const evil = buildZip([{ name: "../escape.txt", data: new Uint8Array([1]) }]);
    expect(() => readZip(evil)).toThrow(TorchCheckpointError);
    expect(() => readZip(new Uint8Array([1, 2, 3]))).toThrow(TorchCheckpointError);
  });

  test("parses a synthetic checkpoint into tensors and config", () => {
    const bytes = fixture();
    const checkpoint = loadTorchCheckpoint(bytes);
    expect(checkpoint.config["encoder"]).toBe("tinyx");
    expect(checkpoint.config["width"]).toBe(8);
    expect(checkpoint.tensors.size).toBe(45 - 12); // tinyx L1 + option layer + head
    const embedding = checkpoint.tensors.get("embedding.weight");
    expect(embedding?.shape).toEqual([257, 8]);
    expect(embedding?.data.length).toBe(257 * 8);
  });

  test("rejects a checkpoint with a disallowed global", () => {
    const writer = new PickleWriter();
    writer.proto();
    writer.global("os", "system");
    writer.stop();
    const zip = buildZip([{ name: "x/data.pkl", data: writer.finish() }]);
    expect(() => loadTorchCheckpoint(zip)).toThrow(/disallowed global/);
  });
});

describe("option scorer", () => {
  test("loads a tinyx checkpoint and scores options", () => {
    const scorer = loadScorer(fixture());
    expect(scorer.config.encoder).toBe("tinyx");
    expect(scorer.tensorCount).toBeGreaterThan(30);
    const distribution = scorer.score("context bytes", ["alpha", "beta", "gamma"]);
    expect(distribution).toHaveLength(3);
    const total = distribution.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0.999);
    expect(total).toBeLessThan(1.001);
    for (const p of distribution) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  test("is deterministic across calls", () => {
    const scorer = loadScorer(fixture());
    const a = scorer.score("ctx", ["x", "y"]);
    const b = scorer.score("ctx", ["x", "y"]);
    expect(a).toEqual(b);
  });

  test("respects option count bounds and empty context", () => {
    const scorer = loadScorer(fixture());
    expect(() => scorer.score("", ["x", "y"])).toThrow(TorchCheckpointError);
    expect(() => scorer.score("ctx", ["only"])).toThrow(TorchCheckpointError);
    const many = Array.from({ length: 27 }, (_, i) => `opt${i}`);
    expect(() => scorer.score("ctx", many)).toThrow(TorchCheckpointError);
  });

  test("supports the tiny (embedding-only) encoder", () => {
    const scorer = loadScorer(
      fixture({ encoder: "tiny", width: 8, rank: 8, context_tokens: 16, option_tokens: 8 }),
    );
    expect(scorer.config.encoder).toBe("tiny");
    const distribution = scorer.score("ctx", ["x", "y"]);
    expect(distribution).toHaveLength(2);
  });

  test("rejects missing tensors and bad configs", () => {
    // A checkpoint with only config, no tensors at all.
    const pkl = new PickleWriter().checkpoint({ encoder: "tinyx", width: 8, rank: 8, layers: 1, heads: 2, context_tokens: 16, option_tokens: 8 }, []);
    const zip = buildZip([
      { name: "t/data.pkl", data: pkl },
      { name: "t/byteorder", data: new TextEncoder().encode("little") },
    ]);
    expect(() => loadScorer(zip)).toThrow(/missing tensor/);

    const badEncoder = buildZip([
      {
        name: "t/data.pkl",
        data: new PickleWriter().checkpoint(
          { encoder: "mystery", width: 8, rank: 8, context_tokens: 16, option_tokens: 8 },
          [],
        ),
      },
    ]);
    expect(() => loadScorer(badEncoder)).toThrow(/unsupported scorer encoder/);
  });
});
