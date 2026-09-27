import { createClient } from "../../src/client.ts";
import { evaluateReviewerCorpus } from "./corpus.ts";

const args = process.argv.slice(2);
const live = args[0] === "--live";
if (args[0] !== "--validate" && !live) throw new Error("Usage: bun benchmarks/reviewer/run.ts --validate|--live ROUTE GATEWAY_URL MAX_REQUESTS");
const [route, baseUrl, budget] = args.slice(1);
if (route === undefined || baseUrl === undefined || budget === undefined || args.length !== 4) throw new Error("explicit route, gateway URL, and request budget required");
const maxRequests = Number(budget);
if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw new Error("request budget must be 1..100");
const url = new URL(baseUrl);
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
  throw new Error("use an isolated loopback HTTP Sys1 gateway root");
}
const report = await evaluateReviewerCorpus({ route, maxRequests, timeoutMs: 300_000,
  validateOnly: !live, ...(live ? { decider: createClient({ baseUrl, timeoutMs: 120_000 }) } : {}),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (live && !report.complete) process.exitCode = 1;
