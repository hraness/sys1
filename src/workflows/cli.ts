import { createHash } from "node:crypto";
import { loadPacks, packRoots } from "../audit/pack.ts";
import { BUILTIN_RULES } from "../audit/rules-cli.ts";
import { createClient, type Sys1Client } from "../client.ts";
import { loadConfig } from "../config.ts";
import { gatewayUrl } from "../daemon.ts";
import { createRouter } from "../runtime.ts";
import { requireWorkflowPlatform } from "./command.ts";
import { inspectWorkflow, listWorkflows, resumeWorkflow, startWorkflow, verifyWorkflow, workflowLogPath } from "./index.ts";
import { WORKFLOW_ID, WORKFLOW_LIMITS, type WorkflowOptions, type WorkflowReport, type WorkflowVerification } from "./types.ts";

export class WorkflowCliError extends Error {
  constructor(readonly code: "usage" | "config", message: string, readonly exitCode = code === "usage" ? 2 : 3) {
    super(message);
    this.name = "WorkflowCliError";
  }
}

function usage(message: string): never { throw new WorkflowCliError("usage", message); }

export interface WorkflowReviewArgs {
  mode: "staged" | "worktree" | "since";
  since?: string;
  paths: string[];
  route: string;
  gateway: boolean;
  maxRequests: number;
  timeoutMs: number;
}
export type WorkflowCliArgs =
  | { action: "check" | "review"; command: string[]; timeoutMs?: number; review?: WorkflowReviewArgs; pauseAfterCheck: boolean; dryRun: boolean; json: boolean }
  | { action: "resume"; id: string; command: string[]; dryRun: boolean; json: boolean }
  | { action: "list"; json: boolean }
  | { action: "show"; id: string; json: boolean }
  | { action: "verify"; id: string; json: boolean };

const VALUE_FLAGS = new Set(["since", "model", "max-requests", "timeout-ms", "review-timeout-ms", "path"]);
const BOOLEAN_FLAGS = new Set(["staged", "worktree", "gateway", "pause-after-check", "dry-run", "json", "agent"]);
const COMMON_FLAGS = ["json", "agent"];
const ALLOWED: Record<string, readonly string[]> = {
  check: [...COMMON_FLAGS, "timeout-ms", "dry-run"],
  review: [...COMMON_FLAGS, ...VALUE_FLAGS, "staged", "worktree", "gateway", "pause-after-check", "dry-run"],
  resume: [...COMMON_FLAGS, "dry-run"],
  list: COMMON_FLAGS, show: COMMON_FLAGS, verify: COMMON_FLAGS,
};

/** A separate parser keeps child arguments out of Sys1's option namespace. */
export function parseWorkflowArgs(argv: readonly string[]): WorkflowCliArgs {
  const flags = new Map<string, string | true>();
  const paths: string[] = [];
  const positional: string[] = [];
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  for (let index = 0; index < options.length; index++) {
    const arg = options[index]!;
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (!arg.startsWith("--")) usage("Unknown workflow option; see sys1 workflow --help");
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) usage("Unknown workflow option; see sys1 workflow --help");
    if (name !== "path" && flags.has(name)) usage(`--${name} may appear only once`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) usage(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    const value = equals === -1 ? options[++index] : arg.slice(equals + 1);
    if (value === undefined || value === "" || (equals === -1 && value.startsWith("--")) || value.includes("\0")) usage(`--${name} needs a value`);
    flags.set(name, value);
    if (name === "path") paths.push(value);
  }
  const [action, id] = positional;
  if (action === undefined || !Object.hasOwn(ALLOWED, action)) usage("Use workflow check, review, list, show, resume, or verify");
  if ([...flags.keys()].some(flag => !ALLOWED[action]!.includes(flag))) usage("Option does not apply to this workflow command");
  const needsId = ["show", "resume", "verify"].includes(action);
  if (positional.length !== (needsId ? 2 : 1)) usage(needsId ? `Use workflow ${action} <id>` : `Use workflow ${action} without positional arguments`);
  if (needsId && (id === undefined || !WORKFLOW_ID.test(id))) usage("Provide the saved workflow ID from workflow list");
  const json = flags.has("json") || flags.has("agent");
  if (action === "list" || action === "show" || action === "verify") {
    if (separator !== -1) usage("Only check, review, and resume accept a command after --");
    if (action === "list") return { action, json };
    return { action, id: id!, json };
  }
  if (command.length === 0 || command[0] === "") usage("Put the command and its arguments after --");
  if (command.length > WORKFLOW_LIMITS.maxCommandArgs || command.some(value => value.includes("\0")) || command.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > WORKFLOW_LIMITS.maxCommandBytes) usage("Command exceeds the workflow argument limit");
  const dryRun = flags.has("dry-run");
  if (action === "resume") return { action, id: id!, command, dryRun, json };
  const integer = (name: string, max: number): number | undefined => {
    const raw = flags.get(name);
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) usage(`--${name} needs an integer from 1 to ${max}`);
    return Number(raw);
  };
  const timeoutMs = integer("timeout-ms", WORKFLOW_LIMITS.maxTimeoutMs);
  const base = { command, ...(timeoutMs === undefined ? {} : { timeoutMs }), pauseAfterCheck: flags.has("pause-after-check"), dryRun, json };
  if (action === "check") return { action, ...base };
  const modes = ["worktree", "staged", "since"].filter(mode => flags.has(mode));
  if (modes.length !== 1) usage("Choose one of --worktree, --staged, or --since <ref>");
  const route = flags.get("model");
  if (typeof route !== "string" || route.length > 128 || !/^[a-z0-9][a-z0-9-]*\/[^\s\x00-\x1f]{1,110}$/.test(route)) usage("--model needs an explicit backend/model route");
  const maxRequests = integer("max-requests", WORKFLOW_LIMITS.maxRequests);
  if (maxRequests === undefined) usage("Set --max-requests to limit review model calls");
  if (paths.length > WORKFLOW_LIMITS.maxPaths || paths.some(path => Buffer.byteLength(path) > 4_096)) usage("Path selection exceeds the workflow limit");
  const since = flags.get("since");
  if (typeof since === "string" && Buffer.byteLength(since) > 1_024) usage("Revision exceeds the workflow limit");
  return {
    action: "review", ...base,
    review: {
      mode: modes[0] as WorkflowReviewArgs["mode"],
      ...(typeof since === "string" ? { since } : {}),
      paths, route, gateway: flags.has("gateway"), maxRequests,
      timeoutMs: integer("review-timeout-ms", WORKFLOW_LIMITS.maxReviewTimeoutMs) ?? WORKFLOW_LIMITS.defaultReviewTimeoutMs,
    },
  };
}

type WorkflowRunReport = WorkflowReport & { command: "check" | "review" | "resume" | "show" };
export type WorkflowCliReport = WorkflowRunReport
  | (WorkflowVerification & { command: "verify" })
  | { version: 1; command: "list"; runs: WorkflowReport[] };

const identity = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function runWorkflowCli(argv: string[], home: string, cwd = process.cwd()): Promise<WorkflowCliReport> {
  const args = parseWorkflowArgs(argv);
  if (args.action === "list") return { version: 1, command: "list", runs: await listWorkflows({ home }) };
  if (args.action === "show") return { command: "show", ...await inspectWorkflow({ home, id: args.id }) };
  if (args.action === "verify") return { command: "verify", ...await verifyWorkflow({ home, id: args.id }) };
  requireWorkflowPlatform();
  // The command is supplied again, while selection and budgets stay pinned to
  // the saved intent. Never recover command arguments from a persistent file.
  const saved = args.action === "resume" ? await inspectWorkflow({ home, id: args.id }) : undefined;
  const savedReview = saved?.intent.review;
  const review = args.action === "resume"
    ? savedReview == null ? undefined : {
      mode: savedReview.mode, ...(savedReview.since === null ? {} : { since: savedReview.since }),
      paths: savedReview.paths, route: savedReview.route, gateway: savedReview.gateway,
      maxRequests: savedReview.maxRequests, timeoutMs: savedReview.timeoutMs,
    }
    : args.review;
  const timeoutMs = args.action === "resume" ? saved!.intent.timeoutMs : args.timeoutMs;
  if (review !== undefined && review.route.startsWith("local-") && !review.gateway) throw new WorkflowCliError("config", "Start sys1 up and add --gateway for a local model");
  const loaded = review === undefined ? undefined : loadConfig(home);
  if (loaded !== undefined && !loaded.ok) throw new WorkflowCliError("config", "Could not load Sys1 configuration");
  const config = loaded?.ok ? loaded.config : undefined;
  const configurationIdentity = config === undefined ? identity("sys1/workflow/check-config/v1") : identity({ config, gateway: review!.gateway });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const execute = async (decider?: Sys1Client): Promise<WorkflowRunReport> => {
    const options: WorkflowOptions = {
      home, cwd, command: args.command, configurationIdentity,
      dryRun: args.dryRun, signal: controller.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(args.action !== "resume" ? { pauseAfterCheck: args.pauseAfterCheck } : {}),
      ...(review === undefined ? {} : {
        review: {
          ...review,
          ...(decider === undefined ? {} : { decider }),
          loadRules: repoRoot => loadPacks(packRoots({ repoRoot, sys1Home: home, builtinDir: BUILTIN_RULES })),
        },
      }),
    };
    const report = args.action === "resume" ? await resumeWorkflow({ ...options, id: args.id }) : await startWorkflow(options);
    return { command: args.action, ...report };
  };
  try {
    if (review === undefined || args.dryRun) return await execute();
    if (review.gateway) return await execute(createClient({ baseUrl: gatewayUrl(config!.gateway.host, config!.gateway.port), timeoutMs: review.timeoutMs }));
    const router = createRouter({ config: config!, env: process.env });
    try { return await execute(router); }
    finally { await router.dispose(); }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export function workflowExitCode(report: WorkflowCliReport): number {
  return report.command === "check" || report.command === "review" || report.command === "resume" ? report.exitCode : 0;
}

export function renderWorkflow(report: WorkflowCliReport, home: string): string {
  if (report.command === "list") return report.runs.length === 0
    ? "No saved workflows. Start one with: sys1 workflow check -- bun test\n"
    : `${report.runs.map(run => `${run.id} ${run.status} ${JSON.stringify(run.intent.repo)}`).join("\n")}\nInspect a run with: sys1 workflow show <id>\n`;
  if (report.command === "verify") return `Workflow ${report.id}: saved record verified (${report.generations} generations, ${report.receipts} receipts).\nThis verifies the stored record; run a fresh check before delivery.\n`;
  let text = `Workflow ${report.status}: ${report.id}\n`;
  if (report.reused && report.command === "resume") text += "The saved check was reused; the command was not run again.\nReview changes to external inputs before relying on this result.\n";
  if (report.command === "show") text += "Saved result; this command does not repeat the check or review.\n";
  if (report.status === "planned") {
    text += "Preview only; your check command was not run. No state write or model call performed.\n";
    text += `Check timeout: ${report.intent.timeoutMs} ms.\n`;
    if (report.intent.review !== null) text += `Review: ${report.intent.review.route}, at most ${report.intent.review.maxRequests} requests.\n`;
    return text;
  }
  if (report.check !== null) {
    const check = report.check;
    text += `Check ${check.status} (exit ${check.exitCode ?? "unknown"}, ${check.durationMs} ms).\n`;
    text += `Checked at: ${new Date(check.checkedAt).toISOString()}.\n`;
    text += `Reuse deadline: ${new Date(check.checkedAt + WORKFLOW_LIMITS.maxReuseAgeMs).toISOString()}.\n`;
    if (check.bindingStatus === "changed") text += "Inputs changed during the check; this observation cannot be reused.\n";
    if (check.bindingStatus === "unavailable") text += "Input identity could not be verified after the check; this observation cannot be reused.\n";
    text += `Private check log: ${JSON.stringify(workflowLogPath(home, check.log.id))}\n`;
    text += `Log expires: ${new Date(check.log.expiresAt).toISOString()}${check.log.truncated ? " (output limit reached)" : ""}.\n`;
  } else if (report.status === "uncertain") {
    text += `Expected private check log (may be absent): ${JSON.stringify(workflowLogPath(home, report.intent.logId))}\n`;
  }
  if (report.review !== null) {
    text += `Advisory review ${report.review.status}: ${report.review.requests} requests, ${report.review.findings.length} candidates.\n`;
    const coverage = report.review.coverage;
    if (coverage !== null) {
      text += `Coverage: ${coverage.evaluatedUnits}/${coverage.units} units across ${coverage.changedFiles} changed files.\n`;
      for (const skip of coverage.skipped) text += `Skipped: ${skip.count} (${JSON.stringify(skip.reason)}).\n`;
    }
    for (const finding of report.review.findings) text += `${JSON.stringify(finding.path)}:${finding.line} ${finding.rule} (${finding.id})\n`;
    if (report.review.findingsOmitted > 0) text += `Additional candidates omitted from this view: ${report.review.findingsOmitted}.\n`;
    if (report.review.findings.length > 0 || report.review.findingsOmitted > 0) text += "Inspect candidates with sys1 review issues; record feedback with sys1 review feedback.\n";
  }
  if (report.status === "paused" || report.status === "ready") {
    text += `Next: sys1 workflow resume ${report.id} -- <original-command> [args...]\n`;
  } else if (report.status === "stale") {
    text += "Saved check expired or inputs changed. Start a new workflow with the current command and review selection.\n";
  } else if (report.status === "uncertain") {
    text += "A command or model call has an unknown outcome. Inspect its effects and log before starting a new run; resume will not repeat it.\n";
  } else if (report.status === "failed" || report.status === "incomplete") {
    text += "Inspect the saved result and log, address the failure, then start a new run.\n";
  }
  text += `Inspect: sys1 workflow show ${report.id}\nVerify the saved record: sys1 workflow verify ${report.id}\n`;
  text += "Run a fresh final check before merging, releasing, or deploying.\n";
  return text;
}
