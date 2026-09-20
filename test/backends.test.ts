import { describe, expect, test } from "bun:test";
import { forwardToBackend, probeBackend, runtimeBackends, type RuntimeBackend } from "../src/backends.ts";
import { configSchema } from "../src/config.ts";
import { chooseBackend } from "../src/router.ts";

function backend(): RuntimeBackend {
  return {
    name: "external", kind: "local", available: true, models: ["test"],
    size_b: 1, cost_rank: 0, base_url: "http://127.0.0.1:18080",
    headers: {}, default_model: "test",
  };
}

describe("backend HTTP boundaries", () => {
  test("off-machine operator backends cannot receive local-only requests", () => {
    const config = configSchema.parse({ version: 1, backends: [
      { name: "remote", base_url: "https://models.example.org", model: "remote-model" },
      { name: "ipv6-local", base_url: "http://[::1]:8080", model: "local-model" },
    ] });
    const candidates = runtimeBackends(config, {}).map((candidate) => ({ ...candidate, available: true }));
    expect(candidates.find((candidate) => candidate.name === "remote")?.kind).toBe("hosted");
    expect(candidates.find((candidate) => candidate.name === "ipv6-local")?.kind).toBe("local");
    expect(chooseBackend("local-only", "remote/remote-model", candidates)).toMatchObject({
      ok: false, reason: "policy_restricted",
    });
    expect(chooseBackend("local-only", "ipv6-local/local-model", candidates)).toMatchObject({
      ok: true, backend: { name: "ipv6-local" },
    });
    expect(chooseBackend("local-only", undefined, candidates)).toMatchObject({
      ok: false, reason: "no_backend_available",
    });
  });

  test("a body reset after headers is a definitive sanitized 502", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("private answer fragment")); },
    });
    const fetchFn = (async () => new Response(body)) as unknown as typeof fetch;
    const result = await forwardToBackend(backend(), "{}", undefined, 1_000, fetchFn);
    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected a definitive response");
    expect(result.status).toBe(502);
    expect(result.body).toContain("backend_response_unreadable");
    expect(result.body).not.toContain("private answer fragment");
  });

  test("redirects cannot forward a configured local request to another origin", async () => {
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 307, headers: { location: "https://off-machine.example.org" } });
    }) as typeof fetch;
    const result = await forwardToBackend(backend(), "{}", undefined, 1_000, fetchFn);
    expect(result).toMatchObject({ kind: "response", status: 307 });
    const probe = await probeBackend(backend(), 1_000, fetchFn);
    expect(probe.available).toBe(false);
  });

  test("an oversized response is rejected rather than truncated into invalid JSON", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1_048_576)); },
      cancel() { cancelled = true; },
    });
    const fetchFn = (async () => new Response(body)) as unknown as typeof fetch;
    const result = await forwardToBackend(backend(), "{}", undefined, 1_000, fetchFn);
    expect(result).toMatchObject({ kind: "response", status: 502 });
    if (result.kind !== "response") throw new Error("expected a definitive response");
    expect(JSON.parse(result.body).error.type).toBe("backend_response_too_large");
    expect(cancelled).toBe(true);
  });

  test("model discovery stops at its body limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
      cancel() { cancelled = true; },
    });
    const fetchFn = (async () => new Response(body)) as unknown as typeof fetch;
    const result = await probeBackend(backend(), 1_000, fetchFn);
    expect(result.available).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("invalid oversized advisory limits do not erase configured caps", async () => {
    const candidate = { ...backend(), capabilities: { maxOptions: 12 } };
    const fetchFn = (async (input: RequestInfo | URL) => String(input).endsWith("/v1/models")
      ? Response.json({ data: ["test"] })
      : new Response(" ".repeat(1_048_577))) as unknown as typeof fetch;
    const result = await probeBackend(candidate, 1_000, fetchFn);
    expect(result.available).toBe(true);
    expect(candidate.capabilities).toEqual({ maxOptions: 12 });
  });
});
