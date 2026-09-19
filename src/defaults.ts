import { totalmem } from "node:os";

export const LOCAL_MODEL_TIERS = ["compact", "quality"] as const;
export type LocalModelTier = (typeof LOCAL_MODEL_TIERS)[number];

export const DEFAULT_LOCAL_MODELS: Record<LocalModelTier, string> = {
  compact: "qwen3-0.6b",
  quality: "qwen3-1.7b",
};

export const QUALITY_MEMORY_THRESHOLD = 16 * 1024 ** 3;

export interface PlatformRecommendation {
  platform: string;
  arch: string;
  target: string;
  supported: boolean;
  acceleration: string;
  tier: LocalModelTier;
  model: string | null;
  reason: string;
}

const PLATFORM_TARGETS: Record<string, string> = {
  "darwin-arm64": "Metal or CPU",
  "darwin-x64": "CPU",
  "linux-x64": "CUDA, Vulkan, or CPU",
  "linux-arm64": "CPU",
  "win32-x64": "CUDA, Vulkan, or CPU",
  "win32-arm64": "CPU",
};

export function platformRecommendation(options: {
  platform?: string;
  arch?: string;
  memoryBytes?: number;
  tier?: LocalModelTier;
} = {}): PlatformRecommendation {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const memoryBytes = options.memoryBytes ?? totalmem();
  const target = `${platform}-${arch}`;
  const acceleration = PLATFORM_TARGETS[target];
  const tier = options.tier ?? (memoryBytes >= QUALITY_MEMORY_THRESHOLD ? "quality" : "compact");
  if (acceleration === undefined) {
    return {
      platform,
      arch,
      target,
      supported: false,
      acceleration: "unsupported",
      tier,
      model: null,
      reason: `no qualified Bun + llama.cpp package target for ${target}`,
    };
  }
  return {
    platform,
    arch,
    target,
    supported: true,
    acceleration,
    tier,
    model: DEFAULT_LOCAL_MODELS[tier],
    reason:
      options.tier === undefined
        ? tier === "quality"
          ? "system memory is at least 16 GiB"
          : "system memory is below 16 GiB"
        : `operator selected the ${tier} tier`,
  };
}
