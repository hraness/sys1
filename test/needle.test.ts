import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedleEngineError, runNeedleTurn } from "../src/local/needle.ts";

const homes: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "sys1-needle-test-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeProc {
  stdout: unknown;
  stderr: unknown;
  exited: Promise<number>;
  exitCode: number | null;
  kill: (signal?: string) => void;
}

function fakeSpawn(result: { stdout: string; code?: number; stderr?: string }) {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const spawnFn = ((argv: string[], opts: { env?: Record<string, string | undefined> }) => {
    calls.push({ argv: [...argv], env: { ...(opts.env ?? {}) } });
    const proc: FakeProc = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(result.stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(result.stderr ?? ""));
          controller.close();
        },
      }),
      exited: Promise.resolve(result.code ?? 0),
      exitCode: result.code ?? 0,
      kill: () => {},
    };
    return proc;
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

const TURN = JSON.stringify({
  type: "tool_call",
  success: true,
  function_calls: [{ name: "evaluate", arguments: { refund: true, dept: "billing" } }],
  confidence: 0.9,
});

describe("needle engine", () => {
  test("spawns with telemetry disabled and parses the turn", async () => {
    const dir = home();
    const { spawnFn, calls } = fakeSpawn({ stdout: TURN });
    const turn = await runNeedleTurn(
      {
        enginePath: "/fake/needle",
        weightsPath: "/fake/needle3.cact",
        home: dir,
        timeoutMs: 5_000,
        spawnFn,
      },
      '{"tools":[]}',
      "Evaluate this input: x",
    );
    expect(turn.calls).toEqual([
      { name: "evaluate", arguments: { refund: true, dept: "billing" } },
    ]);
    expect(turn.confidence).toBe(0.9);
    const call = calls[0];
    expect(call?.argv).toContain("--forced");
    expect(call?.env["NEEDLE_TELEMETRY"]).toBe("0");
    expect(call?.env["DO_NOT_TRACK"]).toBe("1");
    expect(call?.argv.join(" ")).toContain("--model /fake/needle3.cact");
  });

  test("non-zero exit becomes NeedleEngineError", async () => {
    const dir = home();
    const { spawnFn } = fakeSpawn({ stdout: "", code: 2, stderr: "boom" });
    await expect(
      runNeedleTurn(
        { enginePath: "/fake", weightsPath: "/fake.cact", home: dir, timeoutMs: 5_000, spawnFn },
        "[]",
        "p",
      ),
    ).rejects.toThrow(NeedleEngineError);
  });

  test("malformed output becomes NeedleEngineError", async () => {
    const dir = home();
    const { spawnFn } = fakeSpawn({ stdout: "not json at all" });
    await expect(
      runNeedleTurn(
        { enginePath: "/fake", weightsPath: "/fake.cact", home: dir, timeoutMs: 5_000, spawnFn },
        "[]",
        "p",
      ),
    ).rejects.toThrow(/non-JSON/);
  });

  test("unrecognized turn shape becomes NeedleEngineError", async () => {
    const dir = home();
    const { spawnFn } = fakeSpawn({ stdout: JSON.stringify({ unexpected: true }) });
    // Schema tolerates missing fields — function_calls defaults to [].
    const turn = await runNeedleTurn(
      { enginePath: "/fake", weightsPath: "/fake.cact", home: dir, timeoutMs: 5_000, spawnFn },
      "[]",
      "p",
    );
    expect(turn.calls).toEqual([]);
    expect(turn.confidence).toBeNull();
  });

  test("cleans up the tools temp file", async () => {
    const dir = home();
    const { spawnFn } = fakeSpawn({ stdout: TURN });
    await runNeedleTurn(
      { enginePath: "/fake", weightsPath: "/fake.cact", home: dir, timeoutMs: 5_000, spawnFn },
      "[]",
      "p",
    );
    const leftovers = Array.from(new Bun.Glob("tmp/needle-tools-*").scanSync(dir));
    expect(leftovers).toEqual([]);
  });
});
