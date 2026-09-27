/** Opt-in fixture evaluation. No private source discovery, model downloads, or writes. */
import { resolve } from "node:path";
import { loadConfig, sys1Home } from "../src/config.ts";
import { createRouter } from "../src/runtime.ts";
import { loadPack } from "../src/audit/pack.ts";
import {
  AuditBenchmarkError, benchmarkPack, loadBenchmarkFixtures, validateBenchmarkLimits,
  type BenchmarkSplit,
} from "../src/audit/benchmark.ts";

export function parseAuditBenchmarkOptions(args: readonly string[]) {
  const values = new Map<string, string>();
  let validateOnly = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--validate-only") {
      if (validateOnly) throw new AuditBenchmarkError("duplicate benchmark option");
      validateOnly = true;
      continue;
    }
    const value = args[++index];
    if (!["--pack", "--route", "--split", "--max-requests", "--timeout-ms"].includes(key) ||
        value === undefined || value === "" || value.startsWith("--") || values.has(key)) {
      throw new AuditBenchmarkError("invalid benchmark option");
    }
    values.set(key, value);
  }
  const pack = values.get("--pack"), route = values.get("--route"), split = values.get("--split");
  const maxRequestsText = values.get("--max-requests"), timeoutText = values.get("--timeout-ms");
  if (pack === undefined || pack.length > 4_096 || route === undefined ||
      (split !== "calibration" && split !== "heldout") || maxRequestsText === undefined || timeoutText === undefined ||
      !/^[1-9]\d*$/.test(maxRequestsText) || !/^[1-9]\d*$/.test(timeoutText)) {
    throw new AuditBenchmarkError("required: --pack directory --route backend/model --split calibration|heldout --max-requests N --timeout-ms N");
  }
  const maxRequests = Number(maxRequestsText), timeoutMs = Number(timeoutText);
  validateBenchmarkLimits(route, maxRequests, timeoutMs);
  return { packDir: resolve(pack), route, split: split as BenchmarkSplit, maxRequests, timeoutMs, validateOnly };
}

async function main(): Promise<void> {
  const options = parseAuditBenchmarkOptions(process.argv.slice(2));
  const pack = await loadPack(options.packDir, "repo");
  const fixtures = await loadBenchmarkFixtures(options.packDir, options.split);
  const common = { pack, fixtures, route: options.route, maxRequests: options.maxRequests, timeoutMs: options.timeoutMs };
  if (options.validateOnly) {
    console.log(JSON.stringify(await benchmarkPack({ ...common, validateOnly: true })));
    return;
  }
  const loaded = loadConfig(sys1Home(process.env));
  if (!loaded.ok) throw new AuditBenchmarkError("benchmark configuration is invalid");
  // Explicit routes do not activate hosted access. The operator must enable the
  // configured backend first. Omitting home excludes installed local models.
  const router = createRouter({ config: loaded.config, env: process.env });
  try {
    const report = await benchmarkPack({ ...common, decider: router });
    console.log(JSON.stringify(report));
    process.exitCode = report.complete ? 0 : 1;
  } finally { await router.dispose(); }
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof AuditBenchmarkError ? error.message : "audit benchmark input or configuration is invalid");
  process.exitCode = 2;
});
