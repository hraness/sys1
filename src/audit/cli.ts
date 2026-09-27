import { fileURLToPath } from "node:url";
import { collectDiff, type DiffCollection } from "./diff.ts";
import { evaluateAudit, AUDIT_LIMITS, type AuditReport } from "./evaluate.ts";
import { loadPacks, packRoots } from "./pack.ts";
import { createClient } from "../client.ts";
import { createRouter } from "../runtime.ts";
import { gatewayUrl } from "../daemon.ts";
import { loadConfig } from "../config.ts";

// Source is under src/audit; the build puts packs beside dist/cli.js.
const BUILTIN_PACKS = fileURLToPath(new URL(import.meta.path.endsWith("cli.ts") ? "../../packs/" : "./packs/", import.meta.url));

export class AuditCliError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

function usage(message: string): never { throw new AuditCliError(message, 2); }

/** Kept separate from the legacy flag parser so unknown or duplicate audit
 * options cannot silently widen the source sent to a provider. */
export async function runAuditCli(argv: string[], home: string, cwd = process.cwd()): Promise<AuditReport> {
  const flags = new Map<string, string | true>();
  const paths: string[] = [];
  const values = new Set(["since", "model", "max-requests", "timeout-ms"]);
  const booleans = new Set(["worktree", "staged", "dry-run", "gateway", "json", "agent"]);
  let pathMode = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (pathMode) { paths.push(arg); continue; }
    if (arg === "--") { pathMode = true; continue; }
    if (!arg.startsWith("--")) usage("Put audit paths after --");
    const [name, ...rest] = arg.slice(2).split("=");
    if (name === undefined || flags.has(name)) usage("Audit options must be known and appear once");
    if (values.has(name)) {
      const value = rest.length > 0 ? rest.join("=") : argv[++index];
      if (value === undefined || value.length === 0 || value.startsWith("--")) usage(`--${name} needs a value`);
      flags.set(name, value);
    } else if (booleans.has(name) && rest.length === 0) flags.set(name, true);
    else usage(`Unknown audit option ${arg}`);
  }
  const modes = ["worktree", "staged", "since"].filter((mode) => flags.has(mode));
  if (modes.length !== 1) usage("Choose exactly one of --worktree, --staged, or --since <ref>");
  const route = flags.get("model");
  if (typeof route !== "string" || !/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/.test(route) || route.length > 128) {
    usage("--model needs an explicit backend/model route");
  }
  const number = (name: string, fallback: number, max: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) usage(`--${name} needs an integer between 1 and ${max}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) usage(`--${name} needs an integer between 1 and ${max}`);
    return value;
  };
  const maxRequests = number("max-requests", AUDIT_LIMITS.defaultRequests, AUDIT_LIMITS.maxRequests);
  const timeoutMs = number("timeout-ms", AUDIT_LIMITS.defaultTimeoutMs, AUDIT_LIMITS.maxTimeoutMs);
  let diff: DiffCollection;
  try {
    const mode = modes[0] as "staged" | "worktree" | "since";
    const since = flags.get("since");
    diff = await collectDiff({ cwd, mode, ...(typeof since === "string" ? { since } : {}), ...(paths.length > 0 ? { paths } : {}) });
  } catch {
    throw new AuditCliError("Could not collect the Git diff; check the repository, ref, and selected paths", 2);
  }
  const rules = await loadPacks(packRoots({ repoRoot: diff.repoRoot, sys1Home: home, builtinDir: BUILTIN_PACKS }));
  const dryRun = flags.has("dry-run");
  const common = { diff, rules, route, maxRequests, timeoutMs };
  if (dryRun) return evaluateAudit({ ...common, dryRun: true });
  const loaded = loadConfig(home);
  if (!loaded.ok) throw new AuditCliError("Could not load Sys1 configuration", 3);
  if (flags.has("gateway")) {
    const decider = createClient({ baseUrl: gatewayUrl(loaded.config.gateway.host, loaded.config.gateway.port), timeoutMs });
    return evaluateAudit({ ...common, decider });
  }
  if (route.startsWith("local-")) {
    throw new AuditCliError("Start the local gateway with sys1 up and add --gateway to audit a local model", 3);
  }
  // Omit home deliberately: this command never loads or downloads local weights.
  const router = createRouter({ config: loaded.config, env: process.env });
  try { return await evaluateAudit({ ...common, decider: router }); }
  finally { await router.dispose(); }
}

export function renderAudit(report: AuditReport): string {
  const lines = [report.status === "planned"
    ? `Audit preview: ${report.units} diff units, ${report.planned_requests} requests to ${report.route}.`
    : `Audit ${report.status}: ${report.evaluated_units}/${report.units} diff units, ${report.findings.length} candidates for review.`];
  lines.push("Experimental and advisory. Scores are not calibrated defect probabilities.");
  for (const finding of report.findings) {
    lines.push(`${finding.tier} ${JSON.stringify(finding.path)}:${finding.line} (${finding.side}) ${finding.rule} score=${finding.model_score.toFixed(3)}`);
    lines.push(`  ${finding.summary.replace(/[\x00-\x1f\x7f]/g, " ")}`);
  }
  for (const skip of report.skipped) lines.push(`Skipped ${JSON.stringify(skip.path)}: ${skip.reason}${skip.rule === undefined ? "" : ` (${skip.rule})`}`);
  if (report.status !== "planned" && report.findings.length === 0) lines.push("No candidates reported; this does not establish that the changes are correct.");
  return `${lines.join("\n")}\n`;
}
