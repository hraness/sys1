import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ProcessSupervisor, type ProcessSnapshot } from "@hraness/algal/process";
import { manifestToJson, parseOrganismManifest } from "@hraness/algal/manifest";
import { digestCanonical } from "@hraness/algal/digest";
import { AlgalError } from "@hraness/algal/errors";
import { parseRunReceipt } from "@hraness/algal/run";
import type { ToolRegistry } from "@hraness/algal/tools";
import type { JsonValue } from "@hraness/algal/values";
import { checkpointReview } from "../review/checkpoint.ts";
import { Sys1ClientError, type Sys1Client } from "../client.ts";
import { bindWorkflow, sameIntent, type LiveBinding } from "./binding.ts";
import { runWorkflowCommand } from "./command.ts";
import { prepareWorkflowDirectory, safeDirectory, workflowDirectory } from "./files.ts";
import { parseState, type WorkflowState } from "./schema.ts";
import { WORKFLOW_ID, WORKFLOW_LIMITS, WorkflowError, type WorkflowIntent, type WorkflowLocation, type WorkflowOptions, type WorkflowReport, type WorkflowReviewResult, type WorkflowVerification } from "./types.ts";

export * from "./types.ts";
export { workflowLogPath } from "./files.ts";
export { requireWorkflowPlatform } from "./command.ts";

const json = (value: unknown): JsonValue => value as JsonValue;
const TOOL_NAMES = ["sys1.workflow.check.v1", "sys1.workflow.continue.v1", "sys1.workflow.review.v1"] as const;
const manifest = parseOrganismManifest({
  contract: "algal.organism.v1", key: "organism:sys1-workflow-v1", name: "Sys1 saved check and advisory review",
  budgets: { maxSteps: 16, maxAgentCalls: 0, maxWork: 1_000_000, maxContextBytes: 262_144, maxOutputBytes: 262_144, maxDepth: 1 },
  cells: [
    { id: "input", kind: "input", outputs: { state: { type: "json" } } },
    { id: "check", kind: "tool", tool: TOOL_NAMES[0] },
    { id: "continue", kind: "tool", tool: TOOL_NAMES[1] },
    { id: "review", kind: "tool", tool: TOOL_NAMES[2] },
  ],
  edges: [
    { from: { cell: "input", port: "state" }, to: { cell: "check", port: "state" } },
    { from: { cell: "check", port: "state" }, to: { cell: "continue", port: "state" } },
    { from: { cell: "continue", port: "state" }, to: { cell: "review", port: "state" } },
  ],
});

function validId(id: string): void {
  if (!WORKFLOW_ID.test(id)) throw new WorkflowError("invalid_id", "Invalid saved workflow identifier");
}
function fresh(intent: WorkflowIntent, checkedAt?: number): void {
  const age = Date.now() - (checkedAt ?? intent.createdAt);
  if (age < 0 || age > WORKFLOW_LIMITS.maxReuseAgeMs) throw new WorkflowError("expired", "Saved checks are older than one hour; start a new workflow");
}
async function assertBinding(options: WorkflowOptions, expected: WorkflowIntent, checkedAt?: number): Promise<LiveBinding> {
  fresh(expected, checkedAt);
  const live = await bindWorkflow(options, expected.createdAt, expected.logId);
  if (!sameIntent(expected, live.intent)) throw new WorkflowError("stale", "Workflow inputs changed; start a new workflow with the current command and source");
  return live;
}

/** All wrappers persist only schema-checked metadata, never live options or model messages. */
function registry(intent: WorkflowIntent, options?: WorkflowOptions, continuing = false): ToolRegistry {
  const configurationDigest = digestCanonical(json({ adapter: "sys1-workflow-tools-v1", intent }));
  const ownedErrors = new WeakSet<AlgalError>();
  const stageError = (code: "TOOL_FAILED" | "EFFECT_SUSPENDED", message: string, uncertain = false) => {
    const error = new AlgalError(code, message, undefined, { uncertain }); ownedErrors.add(error); return error;
  };
  const entry = (stage: number) => ({
    signature: { inputs: { state: { type: "json" as const } }, outputs: { state: { type: "json" as const } },
      effect: "write" as const, cost: 1, maxOutputBytes: 262_144 },
    configurationDigest,
    tool: async (input: Record<string, JsonValue>): Promise<Record<string, JsonValue>> => {
      const state = parseState(input.state);
      if (!sameIntent(intent, state.intent) || options === undefined) throw new AlgalError("CAPABILITY_DENIED", "Live workflow execution is unavailable");
      try {
        if (stage === 0) {
          if (state.check !== null || state.review !== null) throw new WorkflowError("state_corrupt", "A workflow cannot execute the check twice");
          const live = await assertBinding(options, intent);
          const result = await runWorkflowCommand({ argv: options.command, executable: live.executable, cwd: intent.cwd,
            logDirectory: join(workflowDirectory(options.home), "logs"), logId: intent.logId, timeoutMs: intent.timeoutMs, env: live.env,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          if (result.status === "uncertain") throw stageError("TOOL_FAILED", "Command completion or cleanup is uncertain", true);
          try { await assertBinding(options, intent); result.bindingStatus = "unchanged"; }
          catch (error) { result.bindingStatus = error instanceof WorkflowError && ["stale", "expired", "source_changed"].includes(error.code) ? "changed" : "unavailable"; }
          return { state: json(parseState({ ...state, check: result })) };
        }
        if (state.check === null) throw new WorkflowError("state_corrupt", "The workflow has no recorded command result");
        if (stage === 1) {
          if (state.check.status === "passed" && state.check.bindingStatus === "unchanged" && intent.review !== null && options.pauseAfterCheck && !continuing) {
            throw stageError("EFFECT_SUSPENDED", "Workflow paused after its recorded check");
          }
          return { state: json(state) };
        }
        if (state.review !== null) throw new WorkflowError("state_corrupt", "A workflow cannot repeat its review");
        if (state.check.status !== "passed" || state.check.bindingStatus !== "unchanged" || options.review === undefined) return { state: json(state) };
        if (intent.review === null) throw new WorkflowError("state_corrupt", "The workflow has no bound review intent");
        await assertBinding(options, intent, state.check.checkedAt);
        if (!options.review.decider) throw new WorkflowError("missing_model", "The review stage requires an explicit configured model client");
        let inFlight = 0, unsettled = false;
        const original = options.review.decider;
        const decider: Sys1Client = { evaluate: async (request, evaluationOptions) => {
          inFlight++;
          try { return await original.evaluate(request, evaluationOptions); }
          catch (error) {
            // A network/abort failure does not establish whether the paid call completed.
            if (!(error instanceof Sys1ClientError) || ["transport_error", "timeout", "aborted"].includes(error.code)) unsettled = true;
            throw error;
          } finally { inFlight--; }
        } };
        const result = await checkpointReview({ home: options.home, cwd: intent.cwd, ...options.review, decider, expectedSnapshot: intent.review.snapshot,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (inFlight > 0 || unsettled) throw stageError("TOOL_FAILED", "Model completion is uncertain; this call cannot be repeated automatically", true);
        const skipped = new Map<string, number>();
        for (const item of result.audit?.skipped ?? []) skipped.set(item.reason, (skipped.get(item.reason) ?? 0) + 1);
        const review: WorkflowReviewResult = {
          advisory: true, status: result.status === "planned" ? "incomplete" : result.status, complete: result.complete,
          snapshot: result.snapshot, checkedAt: result.checked_at, requests: result.requests, suppressedCount: result.suppressed_count,
          usage: result.audit?.usage ?? { input_tokens: 0, output_tokens: 0, known_requests: 0, unknown_requests: 0 },
          coverage: result.audit === null ? null : { changedFiles: result.audit.changed_files, units: result.audit.units,
            evaluatedUnits: result.audit.evaluated_units, plannedRequests: result.audit.planned_requests,
            skipped: [...skipped].map(([reason, count]) => ({ reason, count })).sort((a, b) => a.reason.localeCompare(b.reason)),
          },
          findings: result.findings.slice(0, 200).map(({ id, unit_id, rule, revision, path, line, side }) => ({ id, unit_id, rule, revision, path, line, side })),
          findingsOmitted: Math.max(0, result.findings.length - 200),
        };
        if (review.snapshot !== intent.review.snapshot) {
          review.status = "stale"; review.complete = false; review.findings = [];
        }
        while (review.findings.length && Buffer.byteLength(JSON.stringify({ ...state, review })) > 55_000) {
          review.findings.pop(); review.findingsOmitted++;
        }
        // A check can modify files, and source can change while a model is answering.
        try { await assertBinding(options, intent, state.check.checkedAt); }
        catch (error) { if (error instanceof WorkflowError && error.code === "stale") { review.status = "stale"; review.complete = false; review.findings = []; } else throw error; }
        return { state: json(parseState({ ...state, review })) };
      } catch (error) {
        if (error instanceof AlgalError && ownedErrors.has(error)) throw error;
        if (error instanceof WorkflowError && ["stale", "expired", "source_changed"].includes(error.code)) {
          throw new AlgalError("TOOL_FAILED", "Workflow inputs changed or expired; start a new workflow");
        }
        throw new AlgalError("TOOL_FAILED", "Workflow stage failed; inspect the saved metadata and private command log");
      }
    },
  });
  return new Map(TOOL_NAMES.map((name, index) => [name, entry(index)]));
}

function initial(snapshot: ProcessSnapshot): WorkflowState {
  const state = parseState(snapshot.process.args.input?.state);
  if (state.check !== null || state.review !== null || snapshot.process.maxGenerations !== 2) throw new WorkflowError("state_corrupt", "Saved workflow initial state is invalid");
  return state;
}
function requireManifest(snapshot: ProcessSnapshot): void {
  const expected = digestCanonical(manifestToJson(manifest));
  if (snapshot.process.manifestDigest !== expected) throw new WorkflowError("state_corrupt", "Saved workflow definition does not match this version of Sys1");
}
async function toReport(host: ProcessSupervisor, snapshot: ProcessSnapshot, reused = false): Promise<WorkflowReport> {
  let state = initial(snapshot);
  if (snapshot.process.receipt) {
    const value = await host.store.getReceipt(snapshot.process.receipt);
    if (!value) throw new WorkflowError("state_corrupt", "Saved workflow receipt is missing");
    const receipt = parseRunReceipt(value);
    for (const cell of ["review", "continue", "check"]) {
      const output = receipt.cells[cell]?.outputs?.state;
      if (output !== undefined) { state = parseState(output); break; }
    }
    if (!sameIntent(state.intent, initial(snapshot).intent)) throw new WorkflowError("state_corrupt", "Saved workflow receipt refers to different inputs");
  }
  let status: WorkflowReport["status"] = snapshot.process.status === "suspended" ? "paused"
    : snapshot.process.status === "stuck" ? "incomplete" : snapshot.process.status;
  if (status === "complete") {
    if (state.check?.status !== "passed") status = "failed";
    else if (state.check.bindingStatus !== "unchanged") status = "stale";
    else if (state.review?.status === "stale") status = "stale";
    else if (state.review && !state.review.complete) status = "incomplete";
  }
  const exitCode = status === "failed" && state.check?.status !== "passed"
    ? (state.check?.status === "timed_out" ? 124 : state.check?.status === "cancelled" ? 130 : state.check?.exitCode ?? 1)
    : ["complete", "paused", "ready"].includes(status) ? 0 : 2;
  return { version: 1, id: snapshot.process.name, advisory: true, reused, status, processDigest: snapshot.digest,
    exitCode, intent: state.intent, check: state.check, review: state.review };
}

async function openWorkflow(location: WorkflowLocation): Promise<{ host: ProcessSupervisor; snapshot: ProcessSnapshot }> {
  validId(location.id);
  const dir = workflowDirectory(location.home);
  if (!await safeDirectory(join(dir, "engine"), false)) throw new WorkflowError("not_found", "Saved workflow was not found");
  // inspect verifies history without running callbacks; construct the final verifier from validated intent metadata.
  const unbound = new ProcessSupervisor(join(dir, "engine"));
  const snapshot = await unbound.inspect(location.id);
  const intent = initial(snapshot).intent;
  const host = new ProcessSupervisor(join(dir, "engine"), { tools: registry(intent), journal: true });
  requireManifest(snapshot);
  await host.verify(location.id);
  return { host, snapshot };
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("workflow_failed", "Cannot read or execute the workflow safely; inspect its saved state and start a new workflow if needed");
  }
}

export function startWorkflow(options: WorkflowOptions): Promise<WorkflowReport> {
  return guarded(async () => {
    const bound = await bindWorkflow(options);
    const state = parseState({ intent: bound.intent, check: null, review: null });
    const id = `wf-${randomBytes(12).toString("hex")}`;
    if (options.dryRun) return { version: 1, id, advisory: true, reused: false, status: "planned", processDigest: null,
      exitCode: 0, intent: state.intent, check: null, review: null };
    const dir = await prepareWorkflowDirectory(options.home);
    const host = new ProcessSupervisor(join(dir, "engine"), { tools: registry(state.intent, options), journal: true });
    await host.create(id, manifest, { input: { state: json(state) } }, 2);
    try { await host.tick(id); }
    catch (error) { if ((await host.inspect(id)).process.status !== "uncertain") throw error; }
    return toReport(host, await host.inspect(id));
  });
}

export function resumeWorkflow(options: WorkflowOptions & { id: string }): Promise<WorkflowReport> {
  return guarded(async () => {
    const current = await openWorkflow(options);
    const state = initial(current.snapshot);
    if (current.snapshot.process.status === "uncertain") throw new WorkflowError("uncertain", "Command or model completion is uncertain; do not repeat this workflow automatically");
    const previous = await toReport(current.host, current.snapshot);
    await assertBinding(options, state.intent, previous.check?.checkedAt);
    if (options.dryRun) return { ...previous, reused: previous.check !== null, status: "planned" };
    if (!["ready", "suspended"].includes(current.snapshot.process.status)) return { ...previous, reused: true };
    const host = new ProcessSupervisor(join(workflowDirectory(options.home), "engine"), { tools: registry(state.intent, options, true), journal: true });
    try { await host.tick(options.id); }
    catch (error) { if ((await host.inspect(options.id)).process.status !== "uncertain") throw error; }
    return toReport(host, await host.inspect(options.id), previous.check !== null);
  });
}

export function inspectWorkflow(location: WorkflowLocation): Promise<WorkflowReport> {
  return guarded(async () => { const { host, snapshot } = await openWorkflow(location); return toReport(host, snapshot); });
}
export function listWorkflows(location: { home: string; cwd?: string }): Promise<WorkflowReport[]> {
  return guarded(async () => {
    const dir = join(workflowDirectory(location.home), "engine");
    if (!await safeDirectory(dir, false)) return [];
    const snapshots = await new ProcessSupervisor(dir).list();
    const reports: WorkflowReport[] = [];
    for (const snapshot of snapshots) reports.push(await inspectWorkflow({ home: location.home, id: snapshot.process.name }));
    return reports.sort((a, b) => b.intent.createdAt - a.intent.createdAt);
  });
}
export function verifyWorkflow(location: WorkflowLocation): Promise<WorkflowVerification> {
  return guarded(async () => {
    const { host } = await openWorkflow(location);
    const result = await host.verify(location.id);
    return { version: 1, id: location.id, ok: true, processDigest: result.digest, generations: result.generations, receipts: result.receipts };
  });
}
