import type { VerifyTurn } from "./message.ts";

/** Deterministic evidence for claims a final agent message makes. Every check
 * is bounded, local-first, and advisory; unreachable evidence is reported as
 * unverifiable rather than contradicted. */

export const EVIDENCE_LIMITS = {
  maxUrls: 4,
  maxPageBytes: 24 * 1024,
  fetchTimeoutMs: 10_000,
  gitTimeoutMs: 10_000,
  maxGitOutputBytes: 64 * 1024,
  maxRedirects: 3,
} as const;

export type CommandRunner = (command: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; out: string }>;

export const defaultRunner: CommandRunner = async (command, cwd, timeoutMs) => {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", PAGER: "cat" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const out = await new Response(child.stdout).text();
    const code = await child.exited;
    return { code, out: out.slice(0, EVIDENCE_LIMITS.maxGitOutputBytes) };
  } finally {
    clearTimeout(timer);
  }
};

export interface GitEvidence {
  repo: boolean;
  uncommitted_files: number;
  unpushed_commits: number;
  upstream: string | null;
}

export async function gitEvidence(cwd: string, run: CommandRunner = defaultRunner): Promise<GitEvidence> {
  const top = await run(["git", "rev-parse", "--show-toplevel"], cwd, EVIDENCE_LIMITS.gitTimeoutMs);
  if (top.code !== 0) return { repo: false, uncommitted_files: 0, unpushed_commits: 0, upstream: null };
  const status = await run(["git", "-c", "core.fsmonitor=false", "status", "--porcelain"], cwd, EVIDENCE_LIMITS.gitTimeoutMs);
  const uncommitted = status.code === 0 ? status.out.split("\n").filter(line => line.trim() !== "").length : 0;
  const upstream = await run(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], cwd, EVIDENCE_LIMITS.gitTimeoutMs);
  if (upstream.code !== 0) return { repo: true, uncommitted_files: uncommitted, unpushed_commits: 0, upstream: null };
  const ahead = await run(["git", "rev-list", "--count", "@{upstream}..HEAD"], cwd, EVIDENCE_LIMITS.gitTimeoutMs);
  return {
    repo: true,
    uncommitted_files: uncommitted,
    unpushed_commits: ahead.code === 0 ? Number.parseInt(ahead.out.trim(), 10) || 0 : 0,
    upstream: upstream.out.trim() || null,
  };
}

export interface PrEvidence {
  url: string;
  state: string | null;
  merged: boolean | null;
  reachable: boolean;
}

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

export function prUrls(text: string): string[] {
  return [...new Set(text.match(PR_URL) ?? [])].slice(0, 3);
}

export async function prEvidence(url: string, run: CommandRunner = defaultRunner): Promise<PrEvidence> {
  const empty = { url, state: null, merged: null, reachable: false };
  let parsed;
  try {
    parsed = JSON.parse((await run(["gh", "pr", "view", url, "--json", "state,mergedAt"], process.cwd(), EVIDENCE_LIMITS.gitTimeoutMs)).out) as unknown;
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;
  return {
    url,
    state: typeof record["state"] === "string" ? record["state"] : null,
    merged: typeof record["mergedAt"] === "string" && record["mergedAt"] !== "",
    reachable: true,
  };
}

const PAGE_URL = /https:\/\/[^\s"'`)\]}>]+/g;

export function pageUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PAGE_URL)) {
    let url = match[0].replace(/[.,;:]+$/, "");
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (parsed.username !== "" || parsed.password !== "") continue;
      if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")
        || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host === "0.0.0.0") continue;
      found.add(url);
    } catch { /* not a usable URL */ }
    if (found.size >= EVIDENCE_LIMITS.maxUrls) break;
  }
  return [...found];
}

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PageEvidence {
  url: string;
  ok: boolean;
  status: number | null;
  excerpt: string | null;
  failure: string | null;
}

export async function fetchPage(
  url: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = EVIDENCE_LIMITS.fetchTimeoutMs,
): Promise<PageEvidence> {
  const evidence: PageEvidence = { url, ok: false, status: null, excerpt: null, failure: null };
  let current = url;
  for (let redirect = 0; redirect <= EVIDENCE_LIMITS.maxRedirects; redirect++) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "sys1-verify/1 (+https://sys1.io)", accept: "text/html,application/xhtml+xml" },
      });
    } catch (error) {
      evidence.failure = error instanceof Error ? error.name === "TimeoutError" ? "timeout" : "transport" : "transport";
      return evidence;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) { evidence.failure = "redirect_without_location"; return evidence; }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        evidence.failure = "invalid_redirect";
        return evidence;
      }
      if (next.protocol !== "https:") { evidence.failure = "insecure_redirect"; return evidence; }
      void response.body?.cancel().catch(() => {});
      current = next.toString();
      continue;
    }
    evidence.status = response.status;
    if (!response.ok) { evidence.failure = `http_${response.status}`; return evidence; }
    try {
      // Truncate long pages at the cap rather than discarding them: the first
      // bytes carry the visible evidence a claim check needs.
      if (response.body === null) { evidence.failure = "empty_body"; return evidence; }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const deadline = AbortSignal.timeout(timeoutMs);
      for (;;) {
        deadline.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        chunks.push(next.value);
        if (bytes >= EVIDENCE_LIMITS.maxPageBytes) {
          void reader.cancel().catch(() => {});
          break;
        }
      }
      reader.releaseLock();
      const whole = new Uint8Array(Math.min(bytes, EVIDENCE_LIMITS.maxPageBytes));
      let offset = 0;
      for (const chunk of chunks) {
        const room = Math.max(0, whole.byteLength - offset);
        whole.set(chunk.subarray(0, Math.min(chunk.byteLength, room)), offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(whole);
      evidence.ok = true;
      evidence.excerpt = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, EVIDENCE_LIMITS.maxPageBytes);
      return evidence;
    } catch {
      evidence.failure = "body_too_large_or_aborted";
      return evidence;
    }
  }
  evidence.failure = "too_many_redirects";
  return evidence;
}

/** A check-like command from the turn that ended in failure. */
export function checkFailures(turn: VerifyTurn | null): { ran: number; failed: { command: string; excerpt: string }[] } {
  if (turn === null) return { ran: 0, failed: [] };
  const failed = turn.outputs.filter(output => output.failed).map(output => ({ command: output.command, excerpt: output.excerpt.slice(-400) }));
  return { ran: turn.outputs.length, failed };
}
