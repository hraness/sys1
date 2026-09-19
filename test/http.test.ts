import { describe, expect, test } from "bun:test";
import { HttpBodyLimitError, readBoundedText } from "../src/http.ts";

describe("bounded HTTP bodies", () => {
  test("counts bytes rather than characters and cancels without buffering the tail", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode("éé")); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedText({ body }, 5)).rejects.toBeInstanceOf(HttpBodyLimitError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  test("decodes UTF-8 split between stream chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0xa9]));
        controller.close();
      },
    });
    expect(await readBoundedText({ body }, 2)).toBe("é");
  });

  test("abort rejects even when a stream's cancel never settles", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const result = readBoundedText({ body }, 100, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
  });
});
