import { createClient } from "../client.ts";
import { loadConfig } from "../config.ts";
import { gatewayUrl } from "../daemon.ts";
import { createRouter } from "../runtime.ts";
import { runVerify, type VerifyReport } from "./verify.ts";
import { VerifyError } from "./message.ts";
import { resolveReviewRoot } from "../review/checkpoint.ts";
import { installVerifySkill } from "./install.ts";

function usage(message: string): never {
  throw new VerifyError("usage", message, 2);
}

export interface VerifyCliArgs {
  messageFile?: string;
  urls: string[];
  model: string;
  gateway: boolean;
  dryRun: boolean;
  json: boolean;
  timeoutMs: number;
}

export function parseVerifyArgs(argv: string[]): VerifyCliArgs {
  const urls: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) usage("Use sys1 verify with options only; see sys1 verify --help");
    const [name, ...rest] = arg.slice(2).split("=");
    if (name !== "url" && flags.has(name!)) usage(`--${name} may appear only once`);
    const read = (): string => {
      const value = rest.length > 0 ? rest.join("=") : argv[++index];
      if (value === undefined || value === "" || value.startsWith("--")) usage(`--${name} needs a value`);
      return value;
    };
    switch (name) {
      case "url": urls.push(read()); continue;
      case "message": flags.set("message", read()); continue;
      case "model": flags.set("model", read()); continue;
      case "timeout-ms": flags.set("timeout-ms", read()); continue;
      case "gateway": case "dry-run": case "json": case "agent":
        if (rest.length > 0) usage(`--${name} takes no value`);
        flags.set(name!, true);
        continue;
      default: usage(`Unknown verify option --${name}`);
    }
  }
  const model = flags.get("model");
  if (typeof model !== "string" || !/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/.test(model) || model.length > 128) {
    usage("--model needs an explicit backend/model route");
  }
  let timeoutMs = 30_000;
  const rawTimeout = flags.get("timeout-ms");
  if (typeof rawTimeout === "string") {
    if (!/^[1-9][0-9]*$/.test(rawTimeout) || Number(rawTimeout) > 120_000) usage("--timeout-ms needs an integer from 1 to 120000");
    timeoutMs = Number(rawTimeout);
  }
  const messageFile = flags.get("message");
  return {
    urls,
    model,
    gateway: flags.has("gateway"),
    dryRun: flags.has("dry-run"),
    json: flags.has("json") || flags.has("agent"),
    timeoutMs,
    ...(typeof messageFile === "string" ? { messageFile } : {}),
  };
}

export type VerifyCliReport = VerifyReport | Awaited<ReturnType<typeof installVerifySkill>>;

export async function runVerifyCli(argv: string[], home: string, cwd = process.cwd()): Promise<VerifyCliReport> {
  const firstArgument = argv.find(arg => !["--json", "--agent", "--dry-run"].includes(arg));
  if (firstArgument === "setup") {
    const flags = new Set<string>();
    const positional: string[] = [];
    for (const arg of argv) {
      if (!arg.startsWith("--")) { positional.push(arg); continue; }
      if (!["--dry-run", "--json", "--agent"].includes(arg) || flags.has(arg)) usage("Verify setup accepts only --dry-run, --json, or --agent, once each");
      flags.add(arg);
    }
    if (positional.length !== 2 || positional[0] !== "setup") usage("Use verify setup codex, claude-code, or devin");
    return installVerifySkill({ repoRoot: await resolveReviewRoot(cwd), target: positional[1]!, dryRun: flags.has("--dry-run") });
  }
  const args = parseVerifyArgs(argv);
  const base = { home, cwd, route: args.model, urls: args.urls, timeoutMs: args.timeoutMs, dryRun: args.dryRun,
    ...(args.messageFile === undefined ? {} : { messageFile: args.messageFile }) };
  if (args.dryRun) return runVerify(base);
  const loaded = loadConfig(home);
  if (!loaded.ok) throw new VerifyError("config", "Could not load Sys1 configuration", 3);
  if (args.gateway) {
    const client = createClient({ baseUrl: gatewayUrl(loaded.config.gateway.host, loaded.config.gateway.port), timeoutMs: args.timeoutMs });
    return runVerify({ ...base, decider: client });
  }
  if (args.model.startsWith("local-")) throw new VerifyError("config", "Start sys1 up and add --gateway for a local model", 3);
  const router = createRouter({ config: loaded.config, env: process.env });
  try {
    return await runVerify({ ...base, decider: router });
  } finally {
    await router.dispose();
  }
}

export function verifyExitCode(report: VerifyCliReport): number {
  if ("command" in report) return 0;
  if (report.status === "incomplete") return 8;
  return report.contradictions > 0 ? 7 : 0;
}

export function renderVerify(report: VerifyCliReport): string {
  if ("command" in report) return `Verify skill ${report.status}: ${report.path}\n`;
  const lines = [`Verify ${report.status}: ${report.contradictions} contradict${report.contradictions === 1 ? "ion" : "ions"}, ${report.requests} request${report.requests === 1 ? "" : "s"}.`];
  for (const claim of report.claims) {
    const probability = claim.probability === null ? "" : ` p=${claim.probability.toFixed(2)}`;
    lines.push(`[${claim.verdict}] ${claim.kind}${probability}`);
    for (const evidence of claim.evidence) lines.push(`    ${evidence}`);
  }
  if (report.status === "complete" && report.contradictions === 0) {
    lines.push("Advisory result; unverifiable or confirmed claims do not prove correctness.");
  }
  return `${lines.join("\n")}\n`;
}
