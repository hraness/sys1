#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import type { CliUpdateOptions, StartupResult } from "@hraness/cli-update";
import { sys1UpdatePolicy } from "./cli-args.ts";
import { daemonPreventsUpdate } from "./cli-service-update.ts";
import { SYS1_VERSION } from "./version.ts";

type EntryPorts = {
  update(options: CliUpdateOptions): Promise<StartupResult>;
  main(): Promise<void>;
  daemonActive(): boolean;
};

export async function runSys1Entrypoint(argv = process.argv.slice(2), ports: Partial<EntryPorts> = {}): Promise<void> {
  // The product renders its own command help; the updater sees an inert help request.
  const gateArgv = argv[0] === "update" && argv.slice(1).some(arg => arg === "--help" || arg === "-h")
    ? ["help", "update"] : argv;
  const policy = sys1UpdatePolicy(gateArgv, process.env);
  const serviceActive = !policy.effectFree && (ports.daemonActive ?? daemonPreventsUpdate)();
  if (serviceActive && argv[0] === "update" && !["status", "check", "disable", "--help", "-h"].includes(argv[1] ?? "")) {
    process.stderr.write("Stop the Sys1 gateway with sys1 down before updating. Stop a foreground sys1 serve with Ctrl-C.\n");
  }
  const update = await (ports.update ?? (async options => (await import("@hraness/cli-update")).runCliUpdate(options)))({
    packageName: "@hraness/sys1", version: SYS1_VERSION, binName: "sys1",
    entrypoint: fileURLToPath(import.meta.url), argv: gateArgv,
    provider: { kind: "github", repository: "hraness/sys1", assetName: "hraness-sys1-{version}.tgz" },
    ...policy, pinned: serviceActive,
  });
  if (update.handled) { process.exitCode = update.exitCode; return; }
  try { await (ports.main ?? (async () => (await import("./cli.ts")).runSys1Main()))(); }
  finally { await update.release(); }
}

if (import.meta.main) await runSys1Entrypoint();
