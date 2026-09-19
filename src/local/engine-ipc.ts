import { write } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ENGINE_IPC_LIMITS } from "./engine-types.ts";

/** Backpressure-aware writes to the standard stdout pipe, including Bun. */
export async function writeEngineMessage(value: unknown): Promise<void> {
  const wire = Buffer.from(`${JSON.stringify(value)}\n`);
  if (wire.length > ENGINE_IPC_LIMITS.responseBytes) throw new Error("worker_response_limit");
  let offset = 0;
  while (offset < wire.length) {
    const written = await new Promise<number>((resolve, reject) => {
      write(1, wire, offset, wire.length - offset, null, (error, count) => {
        if (error !== null) {
          if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") resolve(0);
          else reject(error);
        } else resolve(count);
      });
    });
    if (written === 0) await delay(1);
    offset += written;
  }
}
