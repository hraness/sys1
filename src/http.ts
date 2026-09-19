/** A body exceeded its byte limit before it finished streaming. */
export class HttpBodyLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`HTTP body exceeds ${maxBytes} bytes`);
    this.name = "HttpBodyLimitError";
  }
}

/** Read at most maxBytes, canceling the stream on overflow or caller abort. */
export async function readBoundedText(
  source: { body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (source.body === null) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    rejectAbort?.(signal?.reason);
    // A foreign stream's cancel callback may never settle. Cancellation must
    // not keep the request alive while waiting for that callback.
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await Promise.race([reader.read(), aborted]);
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        const error = new HttpBodyLimitError(maxBytes);
        void reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
