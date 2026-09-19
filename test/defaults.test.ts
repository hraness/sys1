import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCAL_MODELS,
  QUALITY_MEMORY_THRESHOLD,
  platformRecommendation,
} from "../src/defaults.ts";

const GiB = 1024 ** 3;

describe("platformRecommendation", () => {
  test("qualifies the six packaged desktop targets", () => {
    const expected = new Map([
      ["darwin-arm64", "Metal or CPU"],
      ["darwin-x64", "CPU"],
      ["linux-x64", "CUDA, Vulkan, or CPU"],
      ["linux-arm64", "CPU"],
      ["win32-x64", "CUDA, Vulkan, or CPU"],
      ["win32-arm64", "CPU"],
    ]);
    for (const [target, acceleration] of expected) {
      const parts = target.split("-");
      const platform = parts[0];
      const arch = parts[1];
      if (platform === undefined || arch === undefined) throw new Error(`bad target ${target}`);
      const recommendation = platformRecommendation({ platform, arch, memoryBytes: 8 * GiB });
      expect(recommendation).toMatchObject({ target, supported: true, acceleration });
    }
  });

  test("uses the compact model below 16 GiB", () => {
    expect(
      platformRecommendation({ platform: "linux", arch: "x64", memoryBytes: QUALITY_MEMORY_THRESHOLD - 1 }),
    ).toMatchObject({ tier: "compact", model: DEFAULT_LOCAL_MODELS.compact });
  });

  test("uses the quality model at 16 GiB and above", () => {
    expect(
      platformRecommendation({ platform: "darwin", arch: "arm64", memoryBytes: QUALITY_MEMORY_THRESHOLD }),
    ).toMatchObject({ tier: "quality", model: DEFAULT_LOCAL_MODELS.quality });
  });

  test("an explicit tier overrides memory selection", () => {
    expect(
      platformRecommendation({
        platform: "win32",
        arch: "x64",
        memoryBytes: 64 * GiB,
        tier: "compact",
      }),
    ).toMatchObject({ tier: "compact", model: "qwen3-0.6b", reason: "operator selected the compact tier" });
  });

  test("fails closed for an unqualified target", () => {
    expect(
      platformRecommendation({ platform: "freebsd", arch: "x64", memoryBytes: 64 * GiB }),
    ).toMatchObject({ supported: false, model: null, acceleration: "unsupported" });
  });
});
