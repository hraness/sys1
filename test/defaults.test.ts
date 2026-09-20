import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCAL_MODELS,
  platformRecommendation,
} from "../src/defaults.ts";

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
      const recommendation = platformRecommendation({ platform, arch });
      expect(recommendation).toMatchObject({ target, supported: true, acceleration, tier: "quality", model: DEFAULT_LOCAL_MODELS.quality });
    }
  });

  test("compact requires an explicit experimental selection", () => {
    expect(
      platformRecommendation({
        platform: "win32",
        arch: "x64",
        tier: "compact",
      }),
    ).toMatchObject({ tier: "compact", model: "qwen3-0.6b", reason: "operator selected the experimental 0.6B diagnostic model" });
  });

  test("fails closed for an unqualified target", () => {
    expect(
      platformRecommendation({ platform: "freebsd", arch: "x64" }),
    ).toMatchObject({ supported: false, model: null, acceleration: "unsupported" });
  });
});
