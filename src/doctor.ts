import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  isLoopbackHost,
  type Sys1Config,
} from "./config.ts";
import { daemonStatus, type DaemonState } from "./daemon.ts";
import { probeNativeRuntime, type NativeRuntimeProbe } from "./local/engine.ts";
import {
  inspectGgufFile,
  loadManifestChecked,
  modelFilePath,
  modelsDir,
  type Manifest,
} from "./local/store.ts";
import type { JsonValue } from "./protocol.ts";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  summary: string;
  detail?: JsonValue;
}

export interface DoctorReport {
  ok: boolean;
  version: 1;
  checks: DoctorCheck[];
  counts: { pass: number; warn: number; fail: number };
}

export interface DoctorOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  runtimeVersion?: string;
  nativeProbe?: () => Promise<NativeRuntimeProbe>;
  daemonProbe?: (home: string, config: Sys1Config) => Promise<DaemonState>;
}

function compareVersion(actual: string, required: string): number {
  const left = actual.split(".").map((part) => Number(part));
  const right = required.split(".").map((part) => Number(part));
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

function boundedDetail(value: string, home: string): string {
  return value.replaceAll(home, "$SYS1_HOME").slice(0, 512);
}

function stateDirectoryCheck(home: string): DoctorCheck {
  if (home.length === 0 || home.length > 4_096) {
    return { id: "state.directory", status: "fail", summary: "state directory path is invalid" };
  }
  let target = home;
  for (let i = 0; i < 32 && !existsSync(target); i += 1) {
    const parent = dirname(target);
    if (parent === target) break;
    target = parent;
  }
  try {
    const stats = statSync(target);
    if (!stats.isDirectory()) {
      return { id: "state.directory", status: "fail", summary: "state path parent is not a directory" };
    }
    accessSync(target, constants.R_OK | constants.W_OK);
    return {
      id: "state.directory",
      status: "pass",
      summary: existsSync(home) ? "state directory is readable and writable" : "state directory can be created",
    };
  } catch {
    return { id: "state.directory", status: "fail", summary: "state directory is not accessible" };
  }
}

/** Structural check used by the models.files check. */
function inspectModelFile(
  home: string,
  model: Manifest["models"][number],
): { ok: boolean; bytes?: number; message?: string } {
  const path = modelFilePath(home, model);
  return inspectGgufFile(path);
}

function modelChecks(home: string): {
  manifest: DoctorCheck;
  files: DoctorCheck;
  inventory: DoctorCheck;
  validModelIds: string[];
} {
  const loaded = loadManifestChecked(home);
  if (!loaded.ok) {
    return {
      manifest: {
        id: "models.manifest",
        status: "fail",
        summary: "model manifest is invalid",
        detail: boundedDetail(loaded.message, home),
      },
      files: { id: "models.files", status: "fail", summary: "model files cannot be evaluated" },
      inventory: { id: "models.inventory", status: "warn", summary: "model inventory cannot be reconciled" },
      validModelIds: [],
    };
  }

  const manifest: Manifest = loaded.manifest;
  const problems: { id: string; issue: string }[] = [];
  for (const model of manifest.models) {
    const inspection = inspectModelFile(home, model);
    if (!inspection.ok) {
      problems.push({ id: model.id, issue: boundedDetail(inspection.message ?? "inspection failed", home) });
    } else if (inspection.bytes !== model.bytes) {
      problems.push({ id: model.id, issue: "byte count differs from the admitted manifest" });
    }
  }

  let inventory: DoctorCheck = {
    id: "models.inventory",
    status: "pass",
    summary: "model store has no stale or unmanaged files",
  };
  const directory = modelsDir(home);
  if (existsSync(directory)) {
    try {
      const entries = readdirSync(directory, { withFileTypes: true }).slice(0, 257);
      const admitted = new Set(
        manifest.models.map((model) => model.file),
      );
      const stale = entries.filter((entry) => entry.name.endsWith(".download") || entry.name.endsWith(".tmp")).length;
      const orphaned = entries.filter(
        (entry) =>
          entry.isFile() &&
          /\.(gguf|pt|cact|exe)$|^[^.]+\.engine$/.test(entry.name) &&
          !entry.name.endsWith(".download") &&
          !admitted.has(entry.name),
      ).length;
      const links = entries.filter((entry) => entry.isSymbolicLink()).length;
      if (entries.length > 256 || stale > 0 || orphaned > 0 || links > 0) {
        inventory = {
          id: "models.inventory",
          status: "warn",
          summary: "model store contains files that need operator review",
          detail: {
            stale_downloads: stale,
            orphaned_ggufs: orphaned,
            symbolic_links: links,
            inventory_truncated: entries.length > 256,
          },
        };
      }
    } catch {
      inventory = { id: "models.inventory", status: "fail", summary: "model store cannot be read" };
    }
  }

  return {
    manifest: {
      id: "models.manifest",
      status: "pass",
      summary: `${manifest.models.length} model${manifest.models.length === 1 ? "" : "s"} registered`,
    },
    files:
      problems.length === 0
        ? {
            id: "models.files",
            status: "pass",
            summary: `${manifest.models.length} admitted model file${manifest.models.length === 1 ? "" : "s"} structurally valid`,
          }
        : {
            id: "models.files",
            status: "fail",
            summary: `${problems.length} admitted model file${problems.length === 1 ? "" : "s"} invalid`,
            detail: problems,
          },
    inventory,
    validModelIds: manifest.models.filter((model) => !problems.some((problem) => problem.id === model.id)).map((model) => model.id),
  };
}

function routingCheck(
  config: Sys1Config,
  env: NodeJS.ProcessEnv,
  validModelIds: string[],
): DoctorCheck {
  const hosted =
    config.hosted.enabled &&
    (env[config.hosted.api_key_env]?.length ?? 0) > 0;
  const local = config.local.enabled && validModelIds.includes(config.local.model);
  const explicit = config.backends.filter((backend) => {
    if (!backend.enabled) return false;
    const hostname = new URL(backend.base_url).hostname.replace(/^\[|\]$/g, "");
    const onMachine = isLoopbackHost(hostname);
    return config.routing.policy === "local-only" ? onMachine
      : config.routing.policy === "hosted-only" ? !onMachine : true;
  }).length;
  if (explicit > 0 && (config.routing.policy === "hosted-only" ? !hosted
      : config.routing.policy === "local-only" ? !local : !hosted && !local)) {
    return { id: "routing.candidates", status: "warn", summary: "only explicit HTTP routes are configured; name a backend/model in each request" };
  }
  if (config.routing.policy === "hosted-only" && !hosted) {
    return { id: "routing.candidates", status: "fail", summary: "hosted-only has no configured credential" };
  }
  if (config.routing.policy === "local-only" && !local) {
    return { id: "routing.candidates", status: "fail", summary: `selected local model ${config.local.model} is unavailable; run sys1 setup or explicitly pin another backend` };
  }
  if (!hosted && !local) {
    return { id: "routing.candidates", status: "warn", summary: `no automatic route is available; selected local model ${config.local.model} is not installed or enabled` };
  }
  return {
    id: "routing.candidates",
    status: "pass",
    summary: "routing has at least one configured candidate",
    detail: { hosted, local },
  };
}

function daemonCheck(state: DaemonState): DoctorCheck {
  switch (state.state) {
    case "running":
      return { id: "daemon", status: "pass", summary: "daemon is running and healthy" };
    case "stopped":
      return { id: "daemon", status: "pass", summary: "daemon is stopped" };
    case "stale_pidfile":
      return { id: "daemon", status: "warn", summary: "daemon pid file is stale or unhealthy" };
    case "foreign_listener":
      return { id: "daemon", status: "fail", summary: "configured port is owned by another listener" };
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const runtimeVersion = options.runtimeVersion ?? Bun.version;
  const checks: DoctorCheck[] = [];
  checks.push(
    compareVersion(runtimeVersion, "1.3.14") >= 0
      ? { id: "runtime.bun", status: "pass", summary: `Bun ${runtimeVersion} is supported` }
      : { id: "runtime.bun", status: "fail", summary: `Bun ${runtimeVersion} is below 1.3.14` },
  );
  checks.push(stateDirectoryCheck(options.home));

  const loadedConfig = loadConfig(options.home);
  const config = loadedConfig.ok ? loadedConfig.config : DEFAULT_CONFIG;
  checks.push(
    loadedConfig.ok
      ? { id: "config", status: "pass", summary: loadedConfig.existed ? "config is valid" : "defaults are valid" }
      : {
          id: "config",
          status: "fail",
          summary: "config is invalid",
          detail: boundedDetail(loadedConfig.message, options.home),
        },
  );

  const nativeProbe = options.nativeProbe ?? probeNativeRuntime;
  if (!config.local.enabled) {
    checks.push({ id: "native.runtime", status: "pass", summary: "builtin local inference is disabled" });
  } else {
    const native = await nativeProbe();
    checks.push(
      native.ok
        ? {
            id: "native.runtime",
            status: "pass",
            summary: `llama.cpp is available via ${native.backend ?? "cpu"}`,
            detail: {
              gpu_offloading: native.gpu_offloading ?? false,
              supported_backends: native.supported_backends ?? [],
              ...(native.elapsed_ms !== undefined && Number.isSafeInteger(native.elapsed_ms) && native.elapsed_ms >= 0
                ? { native_probe_ms: native.elapsed_ms }
                : {}),
            },
          }
        : {
            id: "native.runtime",
            status: "fail",
            summary: "llama.cpp runtime is unavailable",
            ...(native.message === undefined
              ? {}
              : { detail: boundedDetail(native.message, options.home) }),
          },
    );
  }

  const models = modelChecks(options.home);
  checks.push(models.manifest, models.files, models.inventory);
  checks.push(
    loadedConfig.ok
      ? routingCheck(config, env, models.validModelIds)
      : { id: "routing.candidates", status: "fail", summary: "routing cannot be evaluated until config is fixed" },
  );

  if (loadedConfig.ok) {
    const daemonProbe = options.daemonProbe ?? daemonStatus;
    checks.push(daemonCheck(await daemonProbe(options.home, config)));
  } else {
    checks.push({ id: "daemon", status: "warn", summary: "daemon check skipped because config is invalid" });
  }

  const counts = checks.reduce(
    (result, check) => {
      result[check.status] += 1;
      return result;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
  return { ok: counts.fail === 0, version: 1, checks, counts };
}
