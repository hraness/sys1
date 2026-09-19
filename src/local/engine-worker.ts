/** Private worker entry. Requests arrive on stdin; replies use stdout. */
import { z } from "zod";
import { NativeLlamaEngine, runNativeProbe } from "./engine-core.ts";
import { ENGINE_IPC_LIMITS } from "./engine-types.ts";
import { writeEngineMessage as send } from "./engine-ipc.ts";
import { LocalInputError } from "./input.ts";

const requestSchema = z.discriminatedUnion("op", [
  z.object({ id: z.number().int().positive(), op: z.literal("probe") }).strict(),
  z.object({
    id: z.number().int().positive(),
    op: z.literal("evaluate"),
    options: z.object({
      modelPath: z.string().min(1).max(4096),
      modelId: z.string().min(1).max(128),
      contextSize: z.number().int().min(256).max(65_536),
      evalTimeoutMs: z.number().int().min(1).max(300_000),
    }).strict(),
    prompt: z.string().refine((text) => Buffer.byteLength(text) <= ENGINE_IPC_LIMITS.maxPromptBytes),
  }).strict(),
]);

let engine: NativeLlamaEngine | undefined;
let identity: string | undefined;
let busy = false;
let chunks: Buffer[] = [];
let bytes = 0;

async function handle(wire: string): Promise<void> {
  const parsed = requestSchema.safeParse(JSON.parse(wire));
  if (!parsed.success) process.exit(1);
  const request = parsed.data;
  try {
    if (request.op === "probe") {
      const result = await runNativeProbe();
      await send({ id: request.id, kind: "probe", value: result.ok ? result : { ok: false, message: "native runtime unavailable" } });
    } else {
      const nextIdentity = JSON.stringify(request.options);
      if (identity !== undefined && nextIdentity !== identity) process.exit(1);
      identity = nextIdentity;
      engine ??= new NativeLlamaEngine(request.options);
      await send({ id: request.id, kind: "distribution", value: await engine.firstTokenDistribution(request.prompt) });
    }
  } catch (error) {
    // Do not echo native exception messages: they may include prompt/model data.
    await send({ id: request.id, kind: error instanceof LocalInputError ? "unsupported" : "error", detail: error instanceof LocalInputError ? "context_limit" : "native_inference_failed" });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  if (busy) process.exit(1);
  bytes += chunk.byteLength;
  if (bytes > ENGINE_IPC_LIMITS.requestBytes) process.exit(1);
  chunks.push(chunk);
  const newline = chunk.indexOf(10);
  if (newline < 0) return;
  if (newline !== chunk.length - 1) process.exit(1);
  const wire = Buffer.concat(chunks, bytes).toString("utf8");
  chunks = [];
  bytes = 0;
  busy = true;
  void handle(wire).then(() => { busy = false; }, () => process.exit(1));
});
// Parent exit closes this pipe; quit when the worker event loop observes EOF.
// Active cancellation is enforced by the parent's kill-and-collect boundary.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(1));
