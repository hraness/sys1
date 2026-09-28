import { createClient } from "../client.ts";
import { loadConfig } from "../config.ts";
import { gatewayUrl } from "../daemon.ts";
import { createRouter } from "../runtime.ts";
import { loadPacks, packRoots } from "../audit/pack.ts";
import { RuleSelectionError, selectRules } from "../audit/select.ts";
import { BUILTIN_RULES } from "../audit/rules-cli.ts";
import { AUDIT_LIMITS } from "../audit/evaluate.ts";
import { renderAudit } from "../audit/cli.ts";
import { checkpointReview, feedbackReview, listReviewIssues, recheckReview, resolveReviewRoot, ReviewError, type ReviewRuntimeOptions } from "./checkpoint.ts";
import { reviewFeedbackSchema } from "./state.ts";
import { installReviewSkill } from "./install.ts";

function usage(message: string): never { throw new ReviewError("usage", message, 2); }

export async function runReviewCli(argv: string[], home: string, cwd = process.cwd()) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const paths: string[] = [];
  const ruleIds: string[] = [];
  const values = new Set(["since", "model", "max-requests", "timeout-ms", "rule"]);
  const booleans = new Set(["worktree", "staged", "dry-run", "gateway", "json", "agent"]);
  let pathMode = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (pathMode) { paths.push(arg); continue; }
    if (arg === "--") { pathMode = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, ...rest] = arg.slice(2).split("=");
    if (name === undefined || (name !== "rule" && flags.has(name))) usage("Review options must be known and appear once, except --rule");
    if (values.has(name)) {
      const value = rest.length > 0 ? rest.join("=") : argv[++index];
      if (value === undefined || !value || value.startsWith("--")) usage(`--${name} needs a value`);
      flags.set(name, value);
      if (name === "rule") ruleIds.push(value);
    } else if (booleans.has(name) && rest.length === 0) flags.set(name, true);
    else usage("Unknown review option");
  }
  const [command, arg, extra] = positional;
  const allowed: Record<string, string[]> = {
    checkpoint: [...values, ...booleans],
    recheck: ["model", "max-requests", "timeout-ms", "dry-run", "gateway", "json", "agent"],
    setup: ["dry-run", "json", "agent"], issues: ["json", "agent"], feedback: ["json", "agent"],
  };
  if (command === undefined || !Object.hasOwn(allowed, command)) usage("Use review checkpoint, issues, feedback, recheck, or setup");
  if ([...flags.keys()].some(flag => !allowed[command]!.includes(flag)) || (pathMode && command !== "checkpoint")) usage("Option or paths do not apply to this review command");
  if (command === "setup") {
    if (positional.length !== 2 || arg === undefined) usage("Use review setup codex or claude-code");
    return installReviewSkill({ repoRoot: await resolveReviewRoot(cwd), target: arg, dryRun: flags.has("dry-run") });
  }
  if (command === "issues") {
    if (positional.length !== 1) usage("Use review issues without arguments");
    return { command: "issues" as const, ...await listReviewIssues({ home, cwd }) };
  }
  if (command === "feedback") {
    const outcome = reviewFeedbackSchema.safeParse(extra);
    if (positional.length !== 3 || arg === undefined || !outcome.success) usage("Use review feedback <id> useful|incorrect|unverifiable");
    return { command: "feedback" as const, ...await feedbackReview({ home, cwd, id: arg, feedback: outcome.data }) };
  }
  const route = flags.get("model");
  if (typeof route !== "string" || !/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/.test(route) || route.length > 128) usage("--model needs an explicit backend/model route");
  const number = (name: string, fallback: number, max: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) usage(`--${name} needs an integer between 1 and ${max}`);
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed > max) usage(`--${name} needs an integer between 1 and ${max}`);
    return parsed;
  };
  const maxRequests = number("max-requests", AUDIT_LIMITS.defaultRequests, AUDIT_LIMITS.maxRequests);
  const timeoutMs = number("timeout-ms", AUDIT_LIMITS.defaultTimeoutMs, AUDIT_LIMITS.maxTimeoutMs);
  const modes = ["worktree", "staged", "since"].filter(mode => flags.has(mode));
  if (command === "checkpoint" && (modes.length !== 1 || positional.length !== 1)) usage("Choose one of --worktree, --staged, or --since <ref>; put paths after --");
  if (command === "recheck" && (positional.length !== 2 || arg === undefined)) usage("Use review recheck <id> --model <backend/model>");
  const base: ReviewRuntimeOptions = {
    home, cwd, route, maxRequests, timeoutMs, dryRun: flags.has("dry-run"),
    loadRules: async repoRoot => {
      const activeRules = await loadPacks(packRoots({ repoRoot, sys1Home: home, builtinDir: BUILTIN_RULES }));
      try { return selectRules(activeRules, ruleIds.length ? ruleIds : undefined); }
      catch (error) { if (error instanceof RuleSelectionError) usage(error.message); throw error; }
    },
  };
  const execute = async (options: ReviewRuntimeOptions) => {
    if (command === "recheck") return { command: "recheck" as const, ...await recheckReview({ ...options, id: arg! }) };
    const since = flags.get("since");
    return { command: "checkpoint" as const, ...await checkpointReview({
      ...options, mode: modes[0] as "staged" | "worktree" | "since",
      ...(typeof since === "string" ? { since } : {}), ...(paths.length ? { paths } : {}),
    }) };
  };
  if (flags.has("dry-run")) return execute(base);
  const loaded = loadConfig(home);
  if (!loaded.ok) throw new ReviewError("config", "Could not load Sys1 configuration");
  if (flags.has("gateway")) return execute({ ...base, decider: createClient({ baseUrl: gatewayUrl(loaded.config.gateway.host, loaded.config.gateway.port), timeoutMs }) });
  if (route.startsWith("local-")) throw new ReviewError("config", "Start sys1 up and add --gateway for a local model");
  const router = createRouter({ config: loaded.config, env: process.env });
  try { return await execute({ ...base, decider: router }); }
  finally { await router.dispose(); }
}

export type ReviewCliReport = Awaited<ReturnType<typeof runReviewCli>>;
export function reviewExitCode(report: ReviewCliReport): number {
  return "status" in report && ["incomplete", "stale", "unavailable", "superseded"].includes(report.status) ? 8 : 0;
}
export function renderReview(report: ReviewCliReport): string {
  if (report.command === "setup") return `Review skill ${report.status}: ${report.path}\n`;
  if (report.command === "feedback") return `Feedback saved for ${report.issue.id}: ${report.issue.feedback}\n`;
  if (report.command === "issues") return `${report.issues.length} recorded candidates. These are historical observations.\n${report.issues.map(issue => `${issue.id} ${JSON.stringify(issue.path)}:${issue.line} ${issue.rule} feedback=${issue.feedback ?? "unset"}`).join("\n")}\n`;
  let text = `Review ${report.status}${report.command === "checkpoint" ? `: ${report.requests} requests, ${report.suppressed_count} previously reported candidates` : `: ${report.id}`}.\n`;
  if (report.command === "checkpoint" && report.checked_at !== null) text += `Last checked: ${new Date(report.checked_at).toISOString()}.\n`;
  if (report.command === "recheck" && report.reason !== null) text += `Reason: ${report.reason}. Run a fresh checkpoint on changed evidence.\n`;
  if (report.audit !== null) text += renderAudit(report.audit);
  else text += "Advisory review; unchanged or missing candidates do not prove correctness.\n";
  if (report.command === "checkpoint") for (const finding of report.findings) text += `Feedback ID: ${finding.id}\n`;
  return text;
}
