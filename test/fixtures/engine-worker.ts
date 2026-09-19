import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { writeEngineMessage as send } from "../../src/local/engine-ipc.ts";

let count = 0;
process.on("SIGTERM", () => {});
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: number; prompt: string; op?: string };
  if (request.op === "probe") {
    const mode = process.argv[2];
    if (mode === "exit") process.exit(17);
    if (mode === "timeout") await new Promise(() => {});
    if (mode === "invalid") {
      writeSync(1, "private diagnostic must not escape\n");
      continue;
    }
    await send({ id: request.id, kind: "probe", value: mode === "unavailable" ? { ok: false, message: "private diagnostic must not escape" } : { ok: true, backend: "cpu", supported_backends: ["cpu"] } });
    continue;
  }
  count += 1;
  if (request.prompt === "hang") {
    process.stderr.write("ready\n");
    await new Promise(() => {});
  }
  if (request.prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 80));
  if (request.prompt === "exit") process.exit(1);
  if (request.prompt === "vocabulary") {
    await send({ id: request.id, kind: "distribution", value: { entries: Array.from({ length: 150_000 }, (_, index) => [`token-${index}`, 1 / 150_000]), inputTokens: count } });
    continue;
  }
  if (request.prompt === "invalid") {
    writeSync(1, `${JSON.stringify({ id: request.id, kind: "distribution", value: { entries: [["yes", 3]], inputTokens: 1 } })}\n`);
    continue;
  }
  if (request.prompt === "oversize") {
    const chunk = Buffer.alloc(256 * 1024, 120);
    for (let i = 0; i < 70; i += 1) writeSync(1, chunk);
    continue;
  }
  if (request.prompt === "context_limit") {
    await send({ id: request.id, kind: "unsupported", detail: "context_limit" });
    continue;
  }
  await send({ id: request.id, kind: "distribution", value: { entries: [["yes", 0.8], ["no", 0.2]], inputTokens: count } });
}
