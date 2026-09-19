import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ROUTING_POLICIES = [
  "auto",
  "prefer-local",
  "prefer-hosted",
  "local-only",
  "hosted-only",
] as const;

export const routingPolicySchema = z.enum(ROUTING_POLICIES);
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export const localBackendSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, hyphens"),
  base_url: z.url().max(512),
  model: z.string().min(1).max(128),
  size_b: z.number().positive().max(10_000).optional(),
  cost_rank: z.number().int().min(0).max(1_000).optional(),
  enabled: z.boolean().default(true),
});

export const configSchema = z.object({
  version: z.literal(1),
  gateway: z
    .object({
      host: z.string().min(1).max(255).default("127.0.0.1"),
      port: z.number().int().min(1).max(65_535).default(13_900),
      request_timeout_ms: z.number().int().min(1_000).max(120_000).default(15_000),
      probe_timeout_ms: z.number().int().min(200).max(10_000).default(1_500),
    })
    .prefault({}),
  routing: z
    .object({
      policy: routingPolicySchema.default("auto"),
    })
    .prefault({}),
  hosted: z
    .object({
      enabled: z.boolean().default(true),
      base_url: z.url().max(512).default("https://api.typesafe.ai"),
      model: z.string().min(1).max(128).default("jev-latest"),
      api_key_env: z.string().min(1).max(128).default("TYPESAFE_API_KEY"),
    })
    .prefault({}),
  local: z
    .object({
      enabled: z.boolean().default(true),
      context_tokens: z.number().int().min(256).max(65_536).default(2_048),
      eval_timeout_ms: z.number().int().min(1_000).max(300_000).default(60_000),
      max_loaded_models: z.number().int().min(1).max(4).default(1),
    })
    .prefault({}),
  backends: z.array(localBackendSchema).max(64).default([]),
});

export type LocalBackendConfig = z.infer<typeof localBackendSchema>;
export type SysoneConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: SysoneConfig = configSchema.parse({ version: 1 });

export function sysoneHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SYSONE_HOME"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".sysone");
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function pidPath(home: string): string {
  return join(home, "daemon.json");
}

export function logPath(home: string): string {
  return join(home, "daemon.log");
}

export type ConfigLoadResult =
  | { ok: true; config: SysoneConfig; path: string; existed: boolean }
  | { ok: false; path: string; message: string };

export function loadConfig(home: string): ConfigLoadResult {
  const path = configPath(home);
  if (!existsSync(path)) {
    return { ok: true, config: DEFAULT_CONFIG, path, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, path, message: `config is not valid JSON: ${path}` };
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".")}`;
    const what = issue === undefined ? "invalid config" : issue.message;
    return { ok: false, path, message: `invalid config${where}: ${what}` };
  }
  return { ok: true, config: result.data, path, existed: true };
}

export function saveConfig(home: string, config: SysoneConfig): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const path = configPath(home);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export const SETTABLE_KEYS = {
  "routing.policy": routingPolicySchema,
  "gateway.host": z.string().min(1).max(255),
  "gateway.port": z.coerce.number().int().min(1).max(65_535),
  "gateway.request_timeout_ms": z.coerce.number().int().min(1_000).max(120_000),
  "gateway.probe_timeout_ms": z.coerce.number().int().min(200).max(10_000),
  "hosted.enabled": z.enum(["true", "false"]).transform((v) => v === "true"),
  "hosted.base_url": z.url().max(512),
  "hosted.model": z.string().min(1).max(128),
  "hosted.api_key_env": z.string().min(1).max(128),
  "local.enabled": z.enum(["true", "false"]).transform((v) => v === "true"),
  "local.context_tokens": z.coerce.number().int().min(256).max(65_536),
  "local.eval_timeout_ms": z.coerce.number().int().min(1_000).max(300_000),
  "local.max_loaded_models": z.coerce.number().int().min(1).max(4),
} as const;

export type SettableKey = keyof typeof SETTABLE_KEYS;

export function setConfigValue(
  config: SysoneConfig,
  key: SettableKey,
  rawValue: string,
): { ok: true; config: SysoneConfig } | { ok: false; message: string } {
  const schema = SETTABLE_KEYS[key];
  const parsed = schema.safeParse(rawValue);
  if (!parsed.success) {
    return { ok: false, message: `invalid value for ${key}: ${rawValue}` };
  }
  const next = structuredClone(config);
  const [section, field] = key.split(".") as [keyof SysoneConfig, string];
  const target = next[section] as Record<string, unknown>;
  target[field] = parsed.data;
  return { ok: true, config: configSchema.parse(next) };
}
