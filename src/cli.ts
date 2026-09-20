#!/usr/bin/env bun
import { readBoundedText } from "./http.ts";
import { existsSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  SETTABLE_KEYS,
  configSchema,
  loadConfig,
  localBackendSchema,
  saveConfig,
  setConfigValue,
  sys1Home,
  type SettableKey,
  type Sys1Config,
} from "./config.ts";
import {
  clearPidFile,
  daemonDown,
  daemonStatus,
  daemonUp,
  healthz,
  gatewayUrl,
  readPidFile,
  writePidFile,
} from "./daemon.ts";
import { probeAll, runtimeBackends } from "./backends.ts";
import { DEFAULT_LOCAL_MODELS, LOCAL_MODEL_TIERS, platformRecommendation, type LocalModelTier } from "./defaults.ts";
import { runDoctor } from "./doctor.ts";
import { SYS1_VERSION, startGateway } from "./gateway.ts";
import { probeNativeRuntime } from "./local/engine.ts";
import { qualifyBackend } from "./qualification.ts";
import {
  MODEL_REGISTRY,
  installedModels,
  pullModel,
  removeModel,
  storeBytes,
  verifyModel,
  type PullResult,
} from "./local/store.ts";

const EXIT = { ok: 0, usage: 2, config: 3, daemon: 4, backend: 5, doctor: 6 } as const;
const LOCAL_DECISION_NOTICE = "Local decisions are experimental. Review results and evaluate your task: https://sys1.io/compare";

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

function fail(message: string, code: number): never {
  err(`sys1: ${message}`);
  process.exit(code);
}

const USAGE = `sys1 — local System One gateway for coding agents

Usage: sys1 <command> [flags]

Setup:
  setup [--tier compact|quality] [--dry-run] [--json]
                                Configure and install the experimental local default
  jev status|enable|disable [--json]
                                Manage explicit hosted Jev activation

Daemon:
  up [--port N] [--json]        Start the gateway daemon in the background
  down [--json]                 Stop the gateway daemon
  serve [--port N]              Run the gateway in the foreground
  status [--json]               Daemon state and backend reachability
  doctor [--json]               Diagnose runtime, config, store, routing, daemon

Models:
  pull [MODEL] [--json]         Download + verify weights (experimental qwen3-1.7b default)
  pull --list [--json]          Show the curated model registry
  model list [--json]           Show installed models
  model verify MODEL [--json]   Recompute and verify a model's sha256
  model remove MODEL            Remove an installed model
  models [--json]               List models across reachable backends

Routing:
  backend list [--json]         List configured HTTP backends
  backend add --name N --url U --model M [--size-b N] [--cost-rank N]
                                Register a System One HTTP backend
  backend check --name N [--json]
                                Qualify discovery, limits, and all answer types
  backend remove --name N       Remove an HTTP backend
  config path                   Print the config file location
  config get [--json]           Print the effective config
  config set <key> <value>      Set a config key (see list below)
  config unset <key>            Reset a key to its default

Evaluate:
  eval [--file path|-] [--json] Send a System One request through the gateway
                                (reads the JSON request from --file or stdin)

Flags:
  --json                        Machine-readable output on supporting commands
  --version                     Print version
  --help                        This help

Local tiers (both experimental): quality (default Qwen3 1.7B), compact (Qwen3 0.6B)
${LOCAL_DECISION_NOTICE}
Config keys: ${Object.keys(SETTABLE_KEYS).join(", ")}

Environment:
  SYS1_HOME                   State directory (default ~/.sys1)
  TYPESAFE_API_KEY              Hosted Jev credential (used only after \`jev enable\`)

Endpoint: POST http://127.0.0.1:13900/v1/systemone, GET /v1/models, GET /healthz
`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--") && VALUE_FLAGS.has(arg)) {
          flags.set(arg.slice(2), next);
          i += 1;
        } else {
          flags.set(arg.slice(2), true);
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const VALUE_FLAGS = new Set([
  "--port",
  "--name",
  "--url",
  "--model",
  "--size-b",
  "--cost-rank",
  "--tier",
  "--file",
  "--sha256",
]);

function flagNumber(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined || raw === true) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${name} needs a number, got ${raw}`, EXIT.usage);
  return value;
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const raw = flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function mustConfig(home: string): Sys1Config {
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  return loaded.config;
}

function setupTier(flags: Map<string, string | boolean>): LocalModelTier | undefined {
  const raw = flagString(flags, "tier");
  if (raw === undefined) return undefined;
  if (raw !== "compact" && raw !== "quality") {
    fail(`--tier must be ${LOCAL_MODEL_TIERS.join(" or ")}`, EXIT.usage);
  }
  return raw;
}

async function cmdSetup(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const tier = setupTier(flags);
  const recommendation = platformRecommendation({
    ...(tier === undefined ? {} : { tier }),
  });
  if (!recommendation.supported || recommendation.model === null) {
    fail(recommendation.reason, EXIT.backend);
  }
  if (flags.get("dry-run") === true) {
    const report = { ok: true, dry_run: true, recommendation };
    if (flags.get("json") === true) out(JSON.stringify(report, null, 2));
    else {
      out(`platform: ${recommendation.target} (${recommendation.acceleration})`);
      out(`default: ${recommendation.model} (${recommendation.tier}) — ${recommendation.reason}`);
      out(LOCAL_DECISION_NOTICE);
    }
    return;
  }

  if (flags.get("json") !== true) out(LOCAL_DECISION_NOTICE);
  const native = await probeNativeRuntime();
  if (!native.ok) fail(native.message ?? "local llama.cpp runtime is unavailable", EXIT.backend);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  const config = structuredClone(loaded.config);
  config.local.enabled = true;
  config.local.model = recommendation.model;

  const existing = installedModels(home).find((model) => model.id === recommendation.model);
  let pull: PullResult | undefined;
  if (existing === undefined) {
    let lastProgress = 0;
    pull = await pullModel(home, recommendation.model, {
      onProgress: (done, total) => {
        if (flags.get("json") === true || Date.now() - lastProgress < 1_000) return;
        lastProgress = Date.now();
        const suffix = total === null ? "" : ` / ${formatBytes(total)}`;
        err(`downloading ${recommendation.model}: ${formatBytes(done)}${suffix}`);
      },
    });
    if (!pull.ok) {
      if (flags.get("json") === true) {
        out(JSON.stringify({ ok: false, recommendation, pull }, null, 2));
      } else {
        err(`sys1: ${pull.message ?? "default model download failed"}`);
      }
      process.exit(EXIT.backend);
    }
  }

  const path = saveConfig(home, config);
  const report = {
    ok: true,
    dry_run: false,
    recommendation,
    native: {
      backend: native.backend ?? "cpu",
      gpu_offloading: native.gpu_offloading ?? false,
    },
    config_path: path,
    model: {
      id: recommendation.model,
      already_installed: existing !== undefined,
      ...(existing === undefined ? { path: pull?.path, bytes: pull?.bytes } : { bytes: existing.bytes }),
    },
  };
  if (flags.get("json") === true) out(JSON.stringify(report, null, 2));
  else {
    out(`platform: ${recommendation.target} (${native.backend ?? "cpu"})`);
    out(`${recommendation.model}: ${existing === undefined ? "installed" : "already installed"}`);
    out("experimental local setup complete; run `sys1 up`");
  }
}

function cmdJev(home: string, args: ParsedArgs): void {
  const [sub] = args.positional.slice(1);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  const credentialPresent = (process.env[loaded.config.hosted.api_key_env]?.length ?? 0) > 0;
  if (sub === "status") {
    const report = {
      enabled: loaded.config.hosted.enabled,
      credential_env: loaded.config.hosted.api_key_env,
      credential_present: credentialPresent,
      active: loaded.config.hosted.enabled && credentialPresent,
      model: loaded.config.hosted.model,
      base_url: loaded.config.hosted.base_url,
    };
    if (args.flags.get("json") === true) out(JSON.stringify(report, null, 2));
    else {
      out(`Jev: ${report.active ? "active" : report.enabled ? "enabled, credential missing" : "disabled"}`);
      out(`model: ${report.model}`);
      out(`credential: ${report.credential_env} (${credentialPresent ? "present" : "missing"})`);
    }
    return;
  }
  if (sub === "enable") {
    if (!credentialPresent) {
      fail(`set ${loaded.config.hosted.api_key_env} in the environment before enabling Jev`, EXIT.config);
    }
    const next = structuredClone(loaded.config);
    next.hosted.enabled = true;
    next.routing.policy = "hosted-only";
    const path = saveConfig(home, next);
    const report = { enabled: true, active: true, model: next.hosted.model, routing_policy: next.routing.policy, config_path: path };
    if (args.flags.get("json") === true) out(JSON.stringify(report, null, 2));
    else {
      out(`Jev enabled for ${next.hosted.model} (${path})`);
      out("routing is hosted-only; local fallback requires an explicit policy change after evaluation");
      out("restart the gateway if it was started before the credential was exported");
    }
    return;
  }
  if (sub === "disable") {
    const next = structuredClone(loaded.config);
    next.hosted.enabled = false;
    if (next.routing.policy === "hosted-only") next.routing.policy = "auto";
    const path = saveConfig(home, next);
    const report = { enabled: false, active: false, config_path: path };
    if (args.flags.get("json") === true) out(JSON.stringify(report, null, 2));
    else out(`Jev disabled (${path})`);
    return;
  }
  fail("usage: sys1 jev <status|enable|disable> [--json]", EXIT.usage);
}

async function cmdUp(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const port = flagNumber(flags, "port");
  if (port !== undefined) config.gateway.port = port;
  const cliEntry = process.argv[1];
  if (cliEntry === undefined) fail("cannot resolve cli entry", EXIT.daemon);
  const result = await daemonUp({ home, config, cliEntry, env: process.env });
  if (flags.get("json") === true) {
    out(JSON.stringify(result));
  } else if (result.ok) {
    out(`sys1 gateway running at ${result.url} (pid ${result.pid})`);
  } else {
    out(`sys1: ${result.message}`);
  }
  if (!result.ok) process.exit(EXIT.daemon);
}

async function cmdDown(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const result = await daemonDown(home, config);
  if (flags.get("json") === true) {
    out(JSON.stringify(result));
  } else {
    out(`sys1: ${result.message}`);
  }
  if (!result.ok) process.exit(EXIT.daemon);
}

async function cmdServe(
  home: string,
  flags: Map<string, string | boolean>,
): Promise<void> {
  const config = mustConfig(home);
  const port = flagNumber(flags, "port");
  const daemonChild = flags.get("daemon-child") === true;
  const instance = crypto.randomUUID();
  const gateway = startGateway({
    ...(daemonChild ? { daemon: { instance, onShutdown: () => shutdown() } } : {}),
    config,
    env: process.env,
    home,
    ...(port === undefined ? {} : { port }),
    reloadConfig: () => {
      const loaded = loadConfig(home);
      if (!loaded.ok) throw new Error(loaded.message);
      return loaded.config;
    },
  });
  if (daemonChild) {
    writePidFile(home, process.pid, config.gateway.host, gateway.port, instance);
  }
  err(`sys1 ${SYS1_VERSION} listening at ${gateway.url}`);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gateway
      .stop()
      .then(() => {
        if (daemonChild) clearPidFile(home, process.pid);
        process.exit(0);
      })
      .catch((error: unknown) => {
        err(`sys1: shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
        process.exit(1);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise(() => {});
}

async function cmdStatus(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const daemon = await daemonStatus(home, config);
  const backends = runtimeBackends(config, process.env, home);
  const probes = await probeAll(backends, config.gateway.probe_timeout_ms);
  const localModels = installedModels(home);
  const report = {
    daemon,
    gateway: { host: config.gateway.host, port: config.gateway.port },
    routing: { policy: config.routing.policy, local_model: config.local.model },
    local_store: { models: localModels.length, bytes: storeBytes(home) },
    backends: backends.map((backend) => ({
      name: backend.name,
      kind: backend.kind,
      available: backend.available,
      models: backend.models,
      size_b: backend.size_b,
      explicit_only: backend.explicitOnly === true,
      capabilities: backend.capabilities ?? null,
      probe: probes.get(backend.name)?.detail ?? null,
    })),
  };
  if (flags.get("json") === true) {
    out(JSON.stringify(report, null, 2));
    return;
  }
  out(`daemon: ${daemon.state}${daemon.state === "running" ? ` pid ${daemon.pid} ${gatewayUrl(daemon.host, daemon.port)}` : ""}`);
  out(`routing: ${config.routing.policy}; selected local model: ${config.local.model}`);
  out(`local store: ${localModels.length} model${localModels.length === 1 ? "" : "s"}, ${formatBytes(report.local_store.bytes)}`);
  for (const backend of report.backends) {
    const marker = backend.available ? "up" : "down";
    const size = backend.size_b === null ? "" : ` ${backend.size_b}B`;
    out(`  ${backend.name} (${backend.kind}${backend.explicit_only ? ", explicit pin" : ""})${size}: ${marker} — ${backend.models.join(", ")}`);
  }
  if (report.backends.length === 0) {
    out("  no backends configured; run `sys1 setup`, `sys1 jev enable`, or `sys1 backend add`");
  }
}

async function cmdDoctor(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const report = await runDoctor({ home, env: process.env });
  if (flags.get("json") === true) {
    out(JSON.stringify(report, null, 2));
  } else {
    for (const check of report.checks) {
      out(`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.summary}`);
    }
    out(
      `doctor: runtime ${report.ok ? "ready" : "not ready"} (${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail)`,
    );
  }
  if (!report.ok) process.exit(EXIT.doctor);
}

async function cmdModels(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const backends = runtimeBackends(config, process.env, home);
  await probeAll(backends, config.gateway.probe_timeout_ms);
  const rows = backends.flatMap((backend) =>
    backend.models.map((id) => ({
      id,
      backend: backend.name,
      kind: backend.kind,
      available: backend.available,
      size_b: backend.size_b,
    })),
  );
  if (flags.get("json") === true) {
    out(JSON.stringify({ object: "list", data: rows }, null, 2));
    return;
  }
  for (const row of rows) {
    out(`${row.id}\t${row.backend} (${row.kind}) ${row.available ? "up" : "down"}`);
  }
}

async function cmdPull(home: string, args: ParsedArgs): Promise<void> {
  if (args.flags.get("list") === true) {
    const rows = MODEL_REGISTRY.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      experimental: entry.experimental === true,
      size_b: entry.size_b,
      bytes: entry.bytes,
      description: entry.description,
      installed: installedModels(home).some((model) => model.id === entry.id),
    }));
    if (args.flags.get("json") === true) {
      out(JSON.stringify({ object: "list", data: rows }, null, 2));
      return;
    }
    for (const row of rows) {
      const tag = row.experimental ? `${row.kind},experimental` : row.kind;
      out(`${row.id}\t${tag}\t${formatBytes(row.bytes)}\t${row.installed ? "installed" : "available"}\t${row.description}`);
    }
    return;
  }

  const ref = args.positional[1] ?? DEFAULT_LOCAL_MODELS.quality;
  const sha256 = flagString(args.flags, "sha256");
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
    fail("--sha256 needs 64 lowercase hexadecimal characters", EXIT.usage);
  }
  const asJson = args.flags.get("json") === true;
  let lastProgress = 0;
  const result = await pullModel(home, ref, {
    ...(sha256 === undefined ? {} : { sha256 }),
    onProgress: (done, total) => {
      if (asJson || Date.now() - lastProgress < 1_000) return;
      lastProgress = Date.now();
      const suffix = total === null ? "" : ` / ${formatBytes(total)}`;
      err(`downloading ${ref}: ${formatBytes(done)}${suffix}`);
    },
  });
  if (asJson) {
    out(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    out(`installed ${result.id} at ${result.path} (${formatBytes(result.bytes ?? 0)})`);
  } else {
    err(`sys1: ${result.message ?? "model download failed"}`);
  }
  if (!result.ok) process.exit(EXIT.backend);
}

async function cmdModel(home: string, args: ParsedArgs): Promise<void> {
  const [sub, id] = args.positional.slice(1);
  if (sub === "list") {
    const models = installedModels(home);
    if (args.flags.get("json") === true) {
      out(JSON.stringify({ object: "list", data: models, bytes: storeBytes(home) }, null, 2));
      return;
    }
    for (const model of models) {
      const size = model.size_b === undefined ? "unknown" : `${model.size_b}B`;
      out(`${model.id}\t${model.kind}\t${size}\t${formatBytes(model.bytes)}\t${model.source}`);
    }
    if (models.length === 0) out("no models installed; run `sys1 pull`");
    return;
  }
  if (sub === "verify") {
    if (id === undefined) fail("usage: sys1 model verify MODEL", EXIT.usage);
    const result = await verifyModel(home, id);
    if (args.flags.get("json") === true) {
      out(JSON.stringify({ id, ...result }, null, 2));
    } else {
      out(result.ok ? `${id}: verified` : `${id}: ${result.message ?? "sha256 mismatch"}`);
    }
    if (!result.ok) process.exit(EXIT.backend);
    return;
  }
  if (sub === "remove") {
    if (id === undefined) fail("usage: sys1 model remove MODEL", EXIT.usage);
    const result = removeModel(home, id);
    if (args.flags.get("json") === true) {
      out(JSON.stringify({ id, ...result }, null, 2));
    } else {
      out(result.message);
    }
    if (!result.ok) process.exit(EXIT.backend);
    return;
  }
  fail("usage: sys1 model <list|verify|remove> [MODEL]", EXIT.usage);
}

async function cmdEval(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const file = flagString(flags, "file");
  let raw: string;
  if (file === undefined || file === "-") {
    raw = await readBoundedText({ body: Bun.stdin.stream() }, 1_048_576);
  } else {
    if (!existsSync(file)) fail(`no such file: ${file}`, EXIT.usage);
    raw = await readBoundedText({ body: Bun.file(file).stream() }, 1_048_576);
  }
  const record = readPidFile(home);
  const host = record?.host ?? config.gateway.host;
  const port = record?.port ?? config.gateway.port;
  if (!(await healthz(host, port))) {
    fail(`gateway is not running at ${gatewayUrl(host, port)}; run \`sys1 up\``, EXIT.daemon);
  }
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl(host, port)}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(config.gateway.request_timeout_ms + 5_000),
      redirect: "error",
    });
  } catch (error) {
    fail(`gateway request failed: ${error instanceof Error ? error.message : "transport"}`, EXIT.backend);
  }
  const body = await readBoundedText(response, 4_194_304, AbortSignal.timeout(config.gateway.request_timeout_ms));
  out(body);
  if (!response.ok) process.exit(EXIT.backend);
}

function cmdConfig(home: string, args: ParsedArgs): void {
  const [sub, ...rest] = args.positional.slice(1);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  switch (sub) {
    case "path": {
      out(loaded.path);
      return;
    }
    case "get": {
      out(JSON.stringify(loaded.config, null, 2));
      return;
    }
    case "set": {
      const [key, value] = rest;
      if (key === undefined || value === undefined) {
        fail("usage: sys1 config set <key> <value>", EXIT.usage);
      }
      if (!(key in SETTABLE_KEYS)) {
        fail(`unknown key ${key}; settable: ${Object.keys(SETTABLE_KEYS).join(", ")}`, EXIT.usage);
      }
      const result = setConfigValue(loaded.config, key as SettableKey, value);
      if (!result.ok) fail(result.message, EXIT.usage);
      const path = saveConfig(home, result.config);
      out(`${key} = ${value} (${path})`);
      return;
    }
    case "unset": {
      const [key] = rest;
      if (key === undefined) fail("usage: sys1 config unset <key>", EXIT.usage);
      if (!(key in SETTABLE_KEYS)) {
        fail(`unknown key ${key}`, EXIT.usage);
      }
      const [section, field] = key.split(".") as [keyof Sys1Config, string];
      const defaults = DEFAULT_CONFIG[section] as Record<string, unknown>;
      const next = structuredClone(loaded.config);
      (next[section] as Record<string, unknown>)[field] = defaults[field];
      const path = saveConfig(home, configSchema.parse(next));
      out(`${key} reset to default (${path})`);
      return;
    }
    default:
      fail("usage: sys1 config <path|get|set|unset>", EXIT.usage);
  }
}

async function cmdBackend(home: string, args: ParsedArgs): Promise<void> {
  const [sub] = args.positional.slice(1);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  switch (sub) {
    case "list": {
      const backends = loaded.config.backends;
      if (args.flags.get("json") === true) {
        out(JSON.stringify(backends, null, 2));
        return;
      }
      for (const backend of backends) {
        const size = backend.size_b === undefined ? "" : ` ${backend.size_b}B`;
        out(`${backend.name}${size} ${backend.enabled ? "" : "(disabled) "}→ ${backend.base_url} model ${backend.model}`);
      }
      if (backends.length === 0) {
        out("no local backends configured");
      }
      return;
    }
    case "add": {
      const name = flagString(args.flags, "name");
      const url = flagString(args.flags, "url");
      const model = flagString(args.flags, "model");
      if (name === undefined || url === undefined || model === undefined) {
        fail("usage: sys1 backend add --name N --url U --model M [--size-b N] [--cost-rank N]", EXIT.usage);
      }
      if (loaded.config.backends.some((candidate) => candidate.name === name)) {
        fail(`backend ${name} already exists`, EXIT.usage);
      }
      const size = flagNumber(args.flags, "size-b");
      const costRank = flagNumber(args.flags, "cost-rank");
      const parsed = localBackendSchema.safeParse({
        name,
        base_url: url,
        model,
        ...(size === undefined ? {} : { size_b: size }),
        ...(costRank === undefined ? {} : { cost_rank: costRank }),
        enabled: true,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        fail(`invalid backend: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`, EXIT.usage);
      }
      const next = structuredClone(loaded.config);
      next.backends.push(parsed.data);
      const path = saveConfig(home, next);
      out(`backend ${name} added (${path})`);
      return;
    }
    case "check": {
      const name = flagString(args.flags, "name");
      if (name === undefined) fail("usage: sys1 backend check --name N [--json]", EXIT.usage);
      const backend = loaded.config.backends.find((candidate) => candidate.name === name);
      if (backend === undefined) fail(`no backend named ${name}`, EXIT.usage);
      const report = await qualifyBackend(backend, {
        probeTimeoutMs: loaded.config.gateway.probe_timeout_ms,
        requestTimeoutMs: loaded.config.gateway.request_timeout_ms,
      });
      if (args.flags.get("json") === true) {
        out(JSON.stringify(report, null, 2));
      } else {
        for (const check of report.checks) {
          out(`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.summary}`);
        }
        out(`backend ${backend.name}: protocol checks ${report.ok ? "passed" : "failed"}`);
      }
      if (!report.ok) process.exit(EXIT.backend);
      return;
    }
    case "remove": {
      const name = flagString(args.flags, "name");
      if (name === undefined) fail("usage: sys1 backend remove --name N", EXIT.usage);
      const next = structuredClone(loaded.config);
      const before = next.backends.length;
      next.backends = next.backends.filter((b) => b.name !== name);
      if (next.backends.length === before) fail(`no backend named ${name}`, EXIT.usage);
      const path = saveConfig(home, next);
      out(`backend ${name} removed (${path})`);
      return;
    }
    default:
      fail("usage: sys1 backend <list|add|check|remove>", EXIT.usage);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args.positional;
  const home = sys1Home(process.env);

  if (args.flags.get("version") === true || command === "version") {
    out(SYS1_VERSION);
    return;
  }
  if (command === undefined || args.flags.get("help") === true || command === "help") {
    out(USAGE);
    return;
  }

  switch (command) {
    case "setup":
      await cmdSetup(home, args.flags);
      return;
    case "jev":
      cmdJev(home, args);
      return;
    case "up":
      await cmdUp(home, args.flags);
      return;
    case "down":
      await cmdDown(home, args.flags);
      return;
    case "serve":
      await cmdServe(home, args.flags);
      return;
    case "status":
      await cmdStatus(home, args.flags);
      return;
    case "doctor":
      await cmdDoctor(home, args.flags);
      return;
    case "models":
      await cmdModels(home, args.flags);
      return;
    case "pull":
      await cmdPull(home, args);
      return;
    case "model":
      await cmdModel(home, args);
      return;
    case "eval":
      await cmdEval(home, args.flags);
      return;
    case "config":
      cmdConfig(home, args);
      return;
    case "backend":
      await cmdBackend(home, args);
      return;
    default:
      err(`sys1: unknown command ${command}`);
      err(USAGE);
      process.exit(EXIT.usage);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "unexpected error", 1);
});
