import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_LOCAL_MODELS } from "./defaults.ts";

export const ROUTING_POLICIES = [
  "auto",
  "prefer-local",
  "prefer-hosted",
  "local-only",
  "hosted-only",
] as const;

export const routingPolicySchema = z.enum(ROUTING_POLICIES);
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

export const loopbackHostSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isLoopbackHost, "must be a loopback host");

const backendUrlSchema = z.url().max(512).refine((value) => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(host))) &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}, "use HTTPS or loopback HTTP without URL credentials, query, or fragment");

export const localBackendSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, hyphens")
    .refine((name) => name !== "typesafe" && !name.startsWith("local-"), "typesafe and local-* names are reserved"),
  base_url: backendUrlSchema,
  model: z.string().min(1).max(128),
  /** Explicit wire adapter; omitted keeps the standard System One contract. */
  adapter: z.enum(["systemone", "kev"]).optional(),
  size_b: z.number().positive().max(10_000).optional(),
  cost_rank: z.number().int().min(0).max(1_000).optional(),
  capabilities: z
    .object({
      max_options: z.number().int().positive().max(255).optional(),
      max_questions: z.number().int().positive().max(64).optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
});

export const configSchema = z.object({
  version: z.literal(1),
  gateway: z
    .object({
      host: loopbackHostSchema.default("127.0.0.1"),
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
      enabled: z.boolean().default(false),
      base_url: backendUrlSchema.default("https://api.typesafe.ai"),
      model: z.string().min(1).max(128).default("jev-1.13.0"),
      api_key_env: z.string().min(1).max(128).default("TYPESAFE_API_KEY"),
    })
    .prefault({}),
  local: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9.-]*$/).default(DEFAULT_LOCAL_MODELS.quality),
      context_tokens: z.number().int().min(256).max(65_536).default(2_048),
      eval_timeout_ms: z.number().int().min(1_000).max(300_000).default(60_000),
      max_loaded_models: z.number().int().min(1).max(4).default(1),
    })
    .prefault({}),
  backends: z.array(localBackendSchema).max(64).refine(
    (backends) => new Set(backends.map((backend) => backend.name)).size === backends.length,
    "backend names must be unique",
  ).default([]),
});

export type LocalBackendConfig = z.infer<typeof localBackendSchema>;
export type Sys1Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Sys1Config = configSchema.parse({ version: 1 });

export function sys1Home(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SYS1_HOME"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".sys1");
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
  | { ok: true; config: Sys1Config; path: string; existed: boolean }
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

export function saveConfig(home: string, config: Sys1Config): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const path = configPath(home);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export const SETTABLE_KEYS = {
  "routing.policy": routingPolicySchema,
  "gateway.host": loopbackHostSchema,
  "gateway.port": z.coerce.number().int().min(1).max(65_535),
  "gateway.request_timeout_ms": z.coerce.number().int().min(1_000).max(120_000),
  "gateway.probe_timeout_ms": z.coerce.number().int().min(200).max(10_000),
  "hosted.base_url": backendUrlSchema,
  "hosted.model": z.string().min(1).max(128),
  "hosted.api_key_env": z.string().min(1).max(128),
  "local.enabled": z.enum(["true", "false"]).transform((v) => v === "true"),
  "local.model": z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9.-]*$/),
  "local.context_tokens": z.coerce.number().int().min(256).max(65_536),
  "local.eval_timeout_ms": z.coerce.number().int().min(1_000).max(300_000),
  "local.max_loaded_models": z.coerce.number().int().min(1).max(4),
} as const;

export type SettableKey = keyof typeof SETTABLE_KEYS;

export function setConfigValue(
  config: Sys1Config,
  key: SettableKey,
  rawValue: string,
): { ok: true; config: Sys1Config } | { ok: false; message: string } {
  if (typeof key !== "string" || !Object.hasOwn(SETTABLE_KEYS, key)) {
    return { ok: false, message: "unknown configuration key" };
  }
  const schema = SETTABLE_KEYS[key];
  const parsed = schema.safeParse(rawValue);
  if (!parsed.success) {
    return { ok: false, message: `invalid value for ${key}: ${rawValue}` };
  }
  const next = structuredClone(config);
  const [section, field] = key.split(".") as [keyof Sys1Config, string];
  const target = next[section] as Record<string, unknown>;
  // Define an own property rather than invoking any inherited setter.
  Object.defineProperty(target, field, { value: parsed.data, writable: true, enumerable: true, configurable: true });
  return { ok: true, config: configSchema.parse(next) };
}
