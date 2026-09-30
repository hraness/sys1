export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--") && VALUE_FLAGS.has(arg)) {
          flags.set(arg.slice(2), next);
          i += 1;
        } else {
          flags.set(arg.slice(2), true);
        }
      }
    } else if (arg === "-h" || arg === "-V" || arg === "-v") {
      flags.set(arg === "-h" ? "help" : "version", true);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const VALUE_FLAGS = new Set([
  "--port",
  "--name",
  "--url",
  "--model",
  "--adapter",
  "--profile",
  "--size-b",
  "--cost-rank",
  "--tier",
  "--file",
  "--sha256",
  "--days",
]);

/** Child argv and paths after -- are never Sys1 flags. */
export function parseInvocation(raw: readonly string[]): ParsedArgs {
  const separator = raw.indexOf("--");
  const beforePaths = parseArgs(separator === -1 ? raw : raw.slice(0, separator));
  return ["audit", "review", "rules", "verify", "workflow"].includes(beforePaths.positional[0] ?? "")
    ? beforePaths : parseArgs(raw);
}

export function sys1UpdatePolicy(argv: readonly string[], env: NodeJS.ProcessEnv): { effectFree: boolean; nested: boolean } {
  const { positional, flags } = parseInvocation(argv);
  const command = positional[0];
  return {
    effectFree: command === undefined || command === "help" || command === "version"
      || flags.get("help") === true || flags.get("version") === true,
    nested: env.SYS1_UPDATE_NESTED === "1" || flags.get("daemon-child") === true,
  };
}
