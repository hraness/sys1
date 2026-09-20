export const LOCAL_MODEL_TIERS = ["compact", "quality"] as const;
export type LocalModelTier = (typeof LOCAL_MODEL_TIERS)[number];

export const DEFAULT_LOCAL_MODELS: Record<LocalModelTier, string> = {
  compact: "qwen3-0.6b",
  quality: "qwen3-1.7b",
};

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
  tier?: LocalModelTier;
} = {}): PlatformRecommendation {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = `${platform}-${arch}`;
  const acceleration = PLATFORM_TARGETS[target];
  const tier = options.tier ?? "quality";
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
      tier === "compact"
        ? "operator selected the experimental 0.6B diagnostic model"
        : "Qwen3 1.7B is the default local model",
  };
}
