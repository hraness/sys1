import type { Sys1Client } from "../client.ts";
import type { SystemOneRequest } from "../protocol.ts";
import { validateResponseForRequest } from "../response.ts";
import {
  checkFailures, fetchPage, gitEvidence, pageUrls, prEvidence, prUrls,
  type CommandRunner, defaultRunner, EVIDENCE_LIMITS, type FetchLike,
} from "./evidence.ts";
import { resolveMessage, VERIFY_LIMITS, VerifyError, type VerifyMessage } from "./message.ts";

/**
 * Checks the claims an agent's final message makes against reachable evidence:
 * the repository, any linked pull requests, and fetched live pages. Advisory
 * only; unverifiable claims are never reported as contradictions. Message and
 * page text stay in memory and are never persisted.
 */

export const CLAIM_PROBABILITY = 0.5;
export const CONFIRMED_AT = 0.7;
export const CONTRADICTED_AT = 0.3;

export const CLAIMS = {
  deployed_or_live:
    "The message asserts that a site, service, page, or change is now live, deployed, or publicly visible to the user.",
  merged_or_pushed:
    "The message asserts that changes were pushed to a remote branch, merged, or landed in a pull request.",
  committed:
    "The message asserts that the work was committed to version control.",
  checks_passed:
    "The message asserts that tests, checks, builds, or CI ran and passed.",
  complete:
    "The message asserts the requested work is finished or complete.",
} as const;
export type ClaimKind = keyof typeof CLAIMS;

export interface VerifyClaim {
  kind: ClaimKind;
  /** The model's probability that the message makes this claim; null in dry-run. */
  probability: number | null;
  verdict: "confirmed" | "contradicted" | "unverifiable" | "not_claimed";
  evidence: string[];
}

export interface VerifyReport {
  version: 1;
  advisory: true;
  experimental: true;
  status: "planned" | "complete" | "incomplete";
  message_source: "file" | "stdin" | "devin";
  route: string;
  requests: number;
  complete: boolean;
  claims: VerifyClaim[];
  contradictions: number;
}

export interface VerifyOptions {
  home: string;
  cwd: string;
  route: string;
  messageFile?: string;
  urls?: readonly string[];
  devinDb?: string;
  decider?: Sys1Client;
  run?: CommandRunner;
  fetchImpl?: FetchLike;
  dryRun?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const claimQuestions = (): Record<string, { type: "noul"; instructions: string }> =>
  Object.fromEntries(
    (Object.keys(CLAIMS) as ClaimKind[]).map(kind => [
      `claim_${kind}`,
      { type: "noul" as const, instructions: `${CLAIMS[kind]} Answer true only when the message asserts this about work it just did.` },
    ]),
  );

async function ask(decider: Sys1Client, request: SystemOneRequest, signal?: AbortSignal) {
  const result = await decider.evaluate(request, signal === undefined ? undefined : { signal });
  return validateResponseForRequest(request, result.response);
}

function noulProbability(answers: ReturnType<typeof validateResponseForRequest>, name: string): number {
  const answer = answers.answers[name];
  if (answer === undefined || answer.type !== "noul") throw new VerifyError("backend", `The backend did not answer ${name}`, 5);
  return answer.noul;
}

export async function runVerify(options: VerifyOptions): Promise<VerifyReport> {
  const message: VerifyMessage = await resolveMessage({
    cwd: options.cwd,
    ...(options.messageFile === undefined ? {} : { messageFile: options.messageFile }),
    ...(options.devinDb === undefined ? {} : { devinDb: options.devinDb }),
  });
  const run = options.run ?? defaultRunner;
  const tail = message.text.slice(-VERIFY_LIMITS.maxTailBytes);
  const report: VerifyReport = {
    version: 1, advisory: true, experimental: true,
    status: "planned", message_source: message.source, route: options.route,
    requests: 0, complete: true, claims: [], contradictions: 0,
  };

  // Deterministic local evidence is collected even in dry-run so the plan is real.
  const git = await gitEvidence(options.cwd, run).catch(() => null);
  const urls = [...new Set([...(options.urls ?? []), ...pageUrls(message.text)])].slice(0, EVIDENCE_LIMITS.maxUrls);
  const prs = prUrls(message.text);

  if (options.dryRun) {
    report.claims = (Object.keys(CLAIMS) as ClaimKind[]).map(kind => ({ kind, probability: null, verdict: "unverifiable", evidence: [] }));
    return report;
  }
  if (options.decider === undefined) throw new VerifyError("config", "Verify needs a model route to read the message", 3);

  const request: SystemOneRequest = { model: options.route, state: { message_tail: tail }, questions: claimQuestions() };
  let probabilities: Partial<Record<ClaimKind, number>>;
  try {
    const answers = await ask(options.decider, request, options.signal);
    report.requests += 1;
    probabilities = Object.fromEntries(
      (Object.keys(CLAIMS) as ClaimKind[]).map(kind => [kind, noulProbability(answers, `claim_${kind}`)]),
    );
  } catch (error) {
    if (error instanceof VerifyError) throw error;
    report.status = "incomplete";
    report.complete = false;
    const reason = error instanceof Error ? error.message : "request failed";
    report.claims = (Object.keys(CLAIMS) as ClaimKind[]).map(kind => ({ kind, probability: null, verdict: "unverifiable", evidence: [`claim extraction failed: ${reason}`] }));
    return report;
  }

  const claims: VerifyClaim[] = [];
  for (const kind of Object.keys(CLAIMS) as ClaimKind[]) {
    const probability = probabilities[kind] ?? 0;
    const claim: VerifyClaim = { kind, probability, verdict: "not_claimed", evidence: [] };
    if (probability < CLAIM_PROBABILITY) {
      claims.push(claim);
      continue;
    }
    claim.verdict = "confirmed";
    switch (kind) {
      case "merged_or_pushed":
      case "committed":
      case "complete": {
        if (git === null || !git.repo) {
          claim.verdict = "unverifiable";
          claim.evidence.push("current directory is not inside a git worktree");
          break;
        }
        if (kind === "merged_or_pushed" && git.unpushed_commits > 0) {
          claim.verdict = "contradicted";
          claim.evidence.push(`${git.unpushed_commits} commit${git.unpushed_commits === 1 ? " is" : "s are"} ahead of ${git.upstream ?? "upstream"}`);
        }
        if ((kind === "committed" || kind === "complete") && git.uncommitted_files > 0) {
          claim.verdict = "contradicted";
          claim.evidence.push(`${git.uncommitted_files} uncommitted file${git.uncommitted_files === 1 ? "" : "s"} remain in the worktree`);
        }
        if (git.upstream === null && kind === "merged_or_pushed") {
          claim.verdict = "unverifiable";
          claim.evidence.push("branch has no upstream to compare against");
        }
        if (claim.verdict === "confirmed") {
          claim.evidence.push(
            ...(git.unpushed_commits === 0 && git.upstream !== null ? [`0 commits ahead of ${git.upstream}`] : []),
            ...(git.uncommitted_files === 0 ? ["worktree is clean"] : []),
          );
        }
        break;
      }
      case "checks_passed": {
        const checks = checkFailures(message.turn);
        if (checks.ran === 0) {
          claim.verdict = "unverifiable";
          claim.evidence.push(message.turn === null
            ? "no transcript was checked; rerun with the harness session or compare the reported check command"
            : "no check-like command ran in the final turn");
        } else if (checks.failed.length > 0) {
          claim.verdict = "contradicted";
          claim.evidence.push(...checks.failed.slice(0, 3).map(item => `check command failed: ${item.command}`));
        } else {
          claim.evidence.push(`${checks.ran} check-like command${checks.ran === 1 ? "" : "s"} completed without failure markers`);
        }
        break;
      }
      case "deployed_or_live": {
        if (urls.length === 0) {
          claim.verdict = "unverifiable";
          claim.evidence.push("no URL was found in the message; pass --url <url>");
          break;
        }
        let sawUnverifiable = false;
        for (const url of urls) {
          const page = await fetchPage(url, options.fetchImpl).catch(() => null);
          if (page === null || !page.ok || page.excerpt === null) {
            sawUnverifiable = true;
            claim.evidence.push(`${url}: fetch ${page?.failure ?? "failed"}`);
            continue;
          }
          const judge: SystemOneRequest = {
            model: options.route,
            state: { url, message_tail: tail, page_excerpt: page.excerpt },
            questions: {
              page_reflects: {
                type: "noul",
                instructions: "Does the fetched page show, contain, or make true the thing the message claims about it? Answer true when the claimed state or content is present on the page. Answer false only when it is clearly absent, contradicted, or the page is an error or placeholder.",
              },
            },
          };
          try {
            const answers = await ask(options.decider, judge, options.signal);
            report.requests += 1;
            const probability = noulProbability(answers, "page_reflects");
            if (probability <= CONTRADICTED_AT) {
              claim.verdict = "contradicted";
              claim.evidence.push(`${url}: page does not reflect the claimed change (p=${probability.toFixed(2)})`);
            } else if (probability >= CONFIRMED_AT) {
              claim.evidence.push(`${url}: page reflects the claim (p=${probability.toFixed(2)})`);
            } else {
              sawUnverifiable = true;
              claim.evidence.push(`${url}: page match is uncertain (p=${probability.toFixed(2)})`);
            }
          } catch {
            sawUnverifiable = true;
            claim.evidence.push(`${url}: model judgment unavailable`);
          }
        }
        if (claim.verdict !== "contradicted" && sawUnverifiable) claim.verdict = "unverifiable";
        break;
      }
    }
    claims.push(claim);
  }

  // Pull-request links are checked whenever present, independently of the claim map.
  for (const url of prs) {
    const pr = await prEvidence(url, run).catch(() => null);
    if (pr === null || !pr.reachable) continue;
    const claim = claims.find(item => item.kind === "merged_or_pushed" && item.verdict !== "not_claimed");
    if (pr.merged !== true) {
      const target = claim ?? { kind: "merged_or_pushed" as const, probability: null, verdict: "unverifiable" as const, evidence: [] };
      if (claim === undefined) claims.push(target);
      target.verdict = "contradicted";
      target.evidence.push(`${url}: pull request state is ${pr.state ?? "unknown"}, not merged`);
    } else if (claim !== undefined) {
      claim.evidence.push(`${url}: merged`);
    }
  }

  report.claims = claims;
  report.contradictions = claims.filter(item => item.verdict === "contradicted").length;
  report.status = "complete";
  return report;
}
