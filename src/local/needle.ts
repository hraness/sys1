import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Cactus Needle process engine. The upstream native binary runs one toolset
 * per process, so each System One request spawns a short-lived engine:
 * questions are rendered as the arguments of a single `evaluate` tool, the
 * state is the prompt, and the grammar-constrained JSON call becomes the
 * answers.
 *
 * Needle's `confidence` is a real calibrated score, but it is per-turn, not
 * per-option: the adapter reports it as answer confidence and distributes
 * remaining mass uniformly — disclosed as `needle-extract`, never presented
 * as a true per-option distribution.
 *
 * The engine binary phones anonymous telemetry home by default upstream;
 * sysone always spawns it with NEEDLE_TELEMETRY=0 and DO_NOT_TRACK=1.
 */

export const NEEDLE_LIMITS = {
  maxStdoutBytes: 1_048_576,
  maxToolsBytes: 262_144,
  maxPromptBytes: 65_536,
  maxArguments: 64,
} as const;

const needleCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const needleTurnSchema = z.object({
  type: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().nullable().optional(),
  function_calls: z.array(needleCallSchema).default([]),
  suppressed_calls: z.array(needleCallSchema).default([]),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export interface NeedleCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface NeedleTurn {
  calls: NeedleCall[];
  suppressed: NeedleCall[];
  /** Calibrated turn confidence, or null when the engine withheld it. */
  confidence: number | null;
}

export interface NeedleEngineOptions {
  /** Path to the platform `needle` binary. */
  enginePath: string;
  /** Path to `needle3.cact` weights. */
  weightsPath: string;
  /** State directory for the bounded tools temp file. */
  home: string;
  /** Per-request wall clock bound. */
  timeoutMs: number;
  /** Injectable spawn for tests. */
  spawnFn?: typeof Bun.spawn;
}

export class NeedleEngineError extends Error {}

function tmpDir(home: string): string {
  const dir = join(home, "tmp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Run one Needle turn: write the tools file, spawn the engine with telemetry
 * disabled, read the bounded JSON result, and remove the temp file. The
 * engine gets `--forced` so a below-floor but well-formed call still ships —
 * the suppressed/held distinction remains visible through the returned lists.
 */
export async function runNeedleTurn(
  options: NeedleEngineOptions,
  toolsJson: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<NeedleTurn> {
  if (new TextEncoder().encode(toolsJson).byteLength > NEEDLE_LIMITS.maxToolsBytes) {
    throw new NeedleEngineError("tools schema exceeds the needle bound");
  }
  if (new TextEncoder().encode(prompt).byteLength > NEEDLE_LIMITS.maxPromptBytes) {
    throw new NeedleEngineError("prompt exceeds the needle bound");
  }
  const dir = tmpDir(options.home);
  const toolsPath = join(dir, `needle-tools-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`);
  writeFileSync(toolsPath, toolsJson, { mode: 0o600 });
  const spawnFn = options.spawnFn ?? Bun.spawn;
  const proc = spawnFn(
    [
      options.enginePath,
      "--model",
      options.weightsPath,
      "--tools",
      toolsPath,
      "--prompt",
      prompt,
      "--forced",
      "--max",
      "1024",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NEEDLE_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        HF_HUB_OFFLINE: "1",
      },
    },
  );
  const timeout = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, options.timeoutMs);
  const onAbort = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).slice(0, 2_048);
      throw new NeedleEngineError(`needle engine exited ${code}${stderr === "" ? "" : `: ${stderr.trim()}`}`);
    }
    if (Buffer.byteLength(stdout) > NEEDLE_LIMITS.maxStdoutBytes) {
      throw new NeedleEngineError("needle output exceeds the bound");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new NeedleEngineError("needle engine returned non-JSON output");
    }
    const turn = needleTurnSchema.safeParse(parsed);
    if (!turn.success) {
      throw new NeedleEngineError("needle engine returned an unrecognized turn");
    }
    return {
      calls: turn.data.function_calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
      suppressed: turn.data.suppressed_calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
      confidence: turn.data.confidence ?? null,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    rmSync(toolsPath, { force: true });
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  }
}
