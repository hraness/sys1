#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  SETTABLE_KEYS,
  configSchema,
  loadConfig,
  localBackendSchema,
  saveConfig,
  setConfigValue,
  sysoneHome,
  type SettableKey,
  type SysoneConfig,
} from "./config.ts";
import {
  clearPidFile,
  daemonDown,
  daemonStatus,
  daemonUp,
  healthz,
  readPidFile,
  writePidFile,
} from "./daemon.ts";
import { probeAll, runtimeBackends } from "./backends.ts";
import { runDoctor } from "./doctor.ts";
import { SYSONE_VERSION, startGateway } from "./gateway.ts";
import {
  MODEL_REGISTRY,
  installedModels,
  pullModel,
  removeModel,
  storeBytes,
  verifyModel,
} from "./local/store.ts";

const EXIT = { ok: 0, usage: 2, config: 3, daemon: 4, backend: 5, doctor: 6 } as const;

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

function fail(message: string, code: number): never {
  err(`sysone: ${message}`);
  process.exit(code);
}

const USAGE = `sysone — local System One gateway for coding agents

Usage: sysone <command> [flags]

Daemon:
  up [--port N] [--json]        Start the gateway daemon in the background
  down [--json]                 Stop the gateway daemon
  serve [--port N]              Run the gateway in the foreground
  status [--json]               Daemon state and backend reachability
  doctor [--json]               Diagnose runtime, config, store, routing, daemon

Models:
  pull [MODEL] [--json]         Download + verify a model (default qwen3-0.6b)
  pull --list [--json]          Show the curated model registry
  model list [--json]           Show installed models
  model verify MODEL [--json]   Recompute and verify a model's sha256
  model remove MODEL            Remove an installed model
  models [--json]               List models across reachable backends

Routing:
  backend list [--json]         List configured HTTP backends
  backend add --name N --url U --model M [--size-b N] [--cost-rank N]
                                Register a System One HTTP backend
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

Config keys: ${Object.keys(SETTABLE_KEYS).join(", ")}

Environment:
  SYSONE_HOME                   State directory (default ~/.sysone)
  TYPESAFE_API_KEY              Hosted Jev credential (enables the typesafe backend)

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

function mustConfig(home: string): SysoneConfig {
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  return loaded.config;
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
    out(`sysone gateway running at ${result.url} (pid ${result.pid})`);
  } else {
    out(`sysone: ${result.message}`);
  }
  if (!result.ok) process.exit(EXIT.daemon);
}

async function cmdDown(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const result = await daemonDown(home, config);
  if (flags.get("json") === true) {
    out(JSON.stringify(result));
  } else {
    out(`sysone: ${result.message}`);
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
  const gateway = startGateway({
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
    writePidFile(home, process.pid, config.gateway.host, gateway.port);
  }
  err(`sysone ${SYSONE_VERSION} listening at ${gateway.url}`);
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
        err(`sysone: shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
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
    routing: { policy: config.routing.policy },
    local_store: { models: localModels.length, bytes: storeBytes(home) },
    backends: backends.map((backend) => ({
      name: backend.name,
      kind: backend.kind,
      available: backend.available,
      models: backend.models,
      size_b: backend.size_b,
      probe: probes.get(backend.name)?.detail ?? null,
    })),
  };
  if (flags.get("json") === true) {
    out(JSON.stringify(report, null, 2));
    return;
  }
  out(`daemon: ${daemon.state}${daemon.state === "running" ? ` pid ${daemon.pid} http://${daemon.host}:${daemon.port}` : ""}`);
  out(`routing: ${config.routing.policy}`);
  out(`local store: ${localModels.length} model${localModels.length === 1 ? "" : "s"}, ${formatBytes(report.local_store.bytes)}`);
  for (const backend of report.backends) {
    const marker = backend.available ? "up" : "down";
    const size = backend.size_b === null ? "" : ` ${backend.size_b}B`;
    out(`  ${backend.name} (${backend.kind})${size}: ${marker} — ${backend.models.join(", ")}`);
  }
  if (report.backends.length === 0) {
    out("  no backends configured; run `sysone pull`, set TYPESAFE_API_KEY, or `sysone backend add`");
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
      `doctor: ${report.ok ? "ready" : "not ready"} (${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail)`,
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
      specialist: entry.specialist === true,
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
      const tag = row.specialist ? `${row.kind},pin-only` : row.kind;
      out(`${row.id}\t${tag}\t${formatBytes(row.bytes)}\t${row.installed ? "installed" : "available"}\t${row.description}`);
    }
    return;
  }

  const ref = args.positional[1] ?? MODEL_REGISTRY[0]?.id;
  if (ref === undefined) fail("model registry is empty", EXIT.backend);
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
    err(`sysone: ${result.message ?? "model download failed"}`);
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
    if (models.length === 0) out("no models installed; run `sysone pull`");
    return;
  }
  if (sub === "verify") {
    if (id === undefined) fail("usage: sysone model verify MODEL", EXIT.usage);
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
    if (id === undefined) fail("usage: sysone model remove MODEL", EXIT.usage);
    const result = removeModel(home, id);
    if (args.flags.get("json") === true) {
      out(JSON.stringify({ id, ...result }, null, 2));
    } else {
      out(result.message);
    }
    if (!result.ok) process.exit(EXIT.backend);
    return;
  }
  fail("usage: sysone model <list|verify|remove> [MODEL]", EXIT.usage);
}

async function cmdEval(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const file = flagString(flags, "file");
  let raw: string;
  if (file === undefined || file === "-") {
    raw = await new Response(Bun.stdin.stream()).text();
  } else {
    if (!existsSync(file)) fail(`no such file: ${file}`, EXIT.usage);
    raw = readFileSync(file, "utf8");
  }
  const record = readPidFile(home);
  const host = record?.host ?? config.gateway.host;
  const port = record?.port ?? config.gateway.port;
  if (!(await healthz(host, port))) {
    fail(`gateway is not running at http://${host}:${port}; run \`sysone up\``, EXIT.daemon);
  }
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(config.gateway.request_timeout_ms + 5_000),
    });
  } catch (error) {
    fail(`gateway request failed: ${error instanceof Error ? error.message : "transport"}`, EXIT.backend);
  }
  const body = await response.text();
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
        fail("usage: sysone config set <key> <value>", EXIT.usage);
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
      if (key === undefined) fail("usage: sysone config unset <key>", EXIT.usage);
      if (!(key in SETTABLE_KEYS)) {
        fail(`unknown key ${key}`, EXIT.usage);
      }
      const [section, field] = key.split(".") as [keyof SysoneConfig, string];
      const defaults = DEFAULT_CONFIG[section] as Record<string, unknown>;
      const next = structuredClone(loaded.config);
      (next[section] as Record<string, unknown>)[field] = defaults[field];
      const path = saveConfig(home, configSchema.parse(next));
      out(`${key} reset to default (${path})`);
      return;
    }
    default:
      fail("usage: sysone config <path|get|set|unset>", EXIT.usage);
  }
}

function cmdBackend(home: string, args: ParsedArgs): void {
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
        fail("usage: sysone backend add --name N --url U --model M [--size-b N] [--cost-rank N]", EXIT.usage);
      }
      if (loaded.config.backends.some((b) => b.name === name)) {
        fail(`backend ${name} already exists`, EXIT.usage);
      }
      const parsed = localBackendSchema.safeParse({
        name,
        base_url: url,
        model,
        ...(flagNumber(args.flags, "size-b") === undefined
          ? {}
          : { size_b: flagNumber(args.flags, "size-b") }),
        ...(flagNumber(args.flags, "cost-rank") === undefined
          ? {}
          : { cost_rank: flagNumber(args.flags, "cost-rank") }),
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
    case "remove": {
      const name = flagString(args.flags, "name");
      if (name === undefined) fail("usage: sysone backend remove --name N", EXIT.usage);
      const next = structuredClone(loaded.config);
      const before = next.backends.length;
      next.backends = next.backends.filter((b) => b.name !== name);
      if (next.backends.length === before) fail(`no backend named ${name}`, EXIT.usage);
      const path = saveConfig(home, next);
      out(`backend ${name} removed (${path})`);
      return;
    }
    default:
      fail("usage: sysone backend <list|add|remove>", EXIT.usage);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args.positional;
  const home = sysoneHome(process.env);

  if (args.flags.get("version") === true || command === "version") {
    out(SYSONE_VERSION);
    return;
  }
  if (command === undefined || args.flags.get("help") === true || command === "help") {
    out(USAGE);
    return;
  }

  switch (command) {
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
      cmdBackend(home, args);
      return;
    default:
      err(`sysone: unknown command ${command}`);
      err(USAGE);
      process.exit(EXIT.usage);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "unexpected error", 1);
});
