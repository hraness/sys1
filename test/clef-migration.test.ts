import { describe, expect, test } from "bun:test";
import { configSchema } from "../src/config.ts";
import { runtimeBackends, probeBackend, forwardToBackend } from "../src/backends.ts";
import { createFetchHandler } from "../src/gateway.ts";
import { createClient } from "../src/client.ts";
import { systemOneRequestSchema } from "../src/protocol.ts";

const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "private-token", TYPESAFE_API_KEY: "legacy-token" };
const image = { content_type: "image/png" as const, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=" };
const request = { state: "Screenshot", images: [image], questions: { urgent: { type: "noul" as const, instructions: "Is this urgent?" } } };
const answer = { model: "clef", answers: { urgent: { type: "noul" as const, noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 0 } };
const catalog = { success: true, result: [{ name: "@cf/cloudflare/clef" }, { name: "@cf/cloudflare/clef-flash" }] };

describe("Clef migration", () => {
  test("fresh defaults are disabled Clef, legacy configuration stays on its endpoint and token", () => {
    const fresh = configSchema.parse({ version: 1 });
    expect(fresh.hosted).toMatchObject({ enabled: false, provider: "cloudflare", model: "clef" });
    expect(runtimeBackends(fresh, env)).toHaveLength(0);
    const legacy = configSchema.parse({ version: 1, hosted: { enabled: true, base_url: "https://api.typesafe.ai", model: "jev-1.13.0", api_key_env: "TYPESAFE_API_KEY" } });
    expect(legacy.hosted.provider).toBe("legacy");
    expect(runtimeBackends(legacy, env)[0]).toMatchObject({ name: "typesafe", base_url: "https://api.typesafe.ai", headers: { authorization: "Bearer legacy-token" } });
    expect(configSchema.parse({ version: 1, hosted: { provider: "legacy" } }).hosted).toMatchObject({ base_url: "https://api.typesafe.ai", model: "jev-1.13.0", api_key_env: "TYPESAFE_API_KEY" });
  });

  test("requires a valid account and Cloudflare token, supports the AUTH_TOKEN alias", () => {
    const config = configSchema.parse({ version: 1, hosted: { provider: "cloudflare", enabled: true } });
    expect(runtimeBackends(config, { TYPESAFE_API_KEY: "legacy" })).toHaveLength(0);
    expect(runtimeBackends(config, { ...env, CLOUDFLARE_ACCOUNT_ID: "bad" })).toHaveLength(0);
    expect(runtimeBackends(config, { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AUTH_TOKEN: "alias" })[0]?.headers.authorization).toBe("Bearer alias");
  });

  test("catalog probing never calls inference or System One discovery", async () => {
    const config = configSchema.parse({ version: 1, hosted: { provider: "cloudflare", enabled: true } });
    const backend = runtimeBackends(config, env)[0]!;
    const calls: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push(String(url)); expect(init?.method).toBe("GET"); return Response.json(catalog); }) as unknown as typeof fetch;
    const result = await probeBackend(backend, 1000, fetchFn);
    expect(result).toMatchObject({ available: true, models: ["clef", "clef-flash"] });
    expect(calls).toEqual([`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?search=clef`]);
    expect((await probeBackend(backend, 1000, (async () => Response.json({ success: false, result: catalog.result })) as unknown as typeof fetch)).available).toBe(false);
  });

  test("provider discovery and inference deadlines bound a transport that ignores abort", async () => {
    const config = configSchema.parse({ version: 1, hosted: { provider: "cloudflare", enabled: true } });
    const backend = runtimeBackends(config, env)[0]!;
    const stalled = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    for (const pending of [
      probeBackend(backend, 10, stalled),
      forwardToBackend(backend, JSON.stringify(request), "clef", 10, stalled),
    ]) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([pending, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("deadline not enforced"), 100); })]);
        expect(result).not.toBe("deadline not enforced");
      } finally { clearTimeout(timer); }
    }
  });

  test("client to gateway to REST preserves images and unwraps the response", async () => {
    const config = configSchema.parse({ version: 1, hosted: { provider: "cloudflare", enabled: true }, routing: { policy: "hosted-only" } });
    const calls: string[] = [];
    const handler = createFetchHandler({ config, env, fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(url));
      if (init?.method === "GET") return Response.json(catalog);
      expect(String(url)).toEndWith("/ai/run/@cf/cloudflare/clef");
      expect(JSON.parse(String(init?.body))).toEqual({ ...request, model: "clef" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-token");
      return Response.json({ success: true, result: answer, errors: [] });
    }) as unknown as typeof fetch });
    const client = createClient({ fetch: (async (url: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(url), init))) as unknown as typeof fetch });
    expect(await client.evaluate(request)).toMatchObject({ response: answer, metadata: { backend: "cloudflare", attempts: 1 } });
    expect(calls).toHaveLength(2);
  });

  test("direct REST client selects models per concurrent request and unwraps envelopes", async () => {
    const calls: string[] = [];
    const client = createClient({ adapter: "clef", cloudflare: { accountId: env.CLOUDFLARE_ACCOUNT_ID }, headers: { authorization: "Bearer private-token" }, fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { model: string; images: unknown[] };
      calls.push(String(url));
      expect(input.images).toEqual(request.images);
      expect(String(url)).toEndWith(`/${input.model}`);
      return Response.json({ success: true, result: { ...answer, model: input.model }, errors: [] });
    }) as unknown as typeof fetch });
    const results = await Promise.all([client.evaluate({ ...request, model: "clef" }), client.evaluate({ ...request, model: "clef-flash" })]);
    expect(results.map((result) => result.response.model)).toEqual(["clef", "clef-flash"]);
    expect(calls).toHaveLength(2);
  });

  test("valid JPEG, WebP and PNG images pass while truncated headers fail", async () => {
    const sharp = (await import("sharp")).default;
    for (const format of ["jpeg", "webp", "png"] as const) {
      const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "red" } }).toFormat(format).toBuffer();
      const embedded = { content_type: `image/${format}`, base64: bytes.toString("base64") };
      expect(systemOneRequestSchema.safeParse({ ...request, images: [embedded] }).success).toBe(true);
      expect(systemOneRequestSchema.safeParse({ ...request, images: [{ ...embedded, base64: bytes.subarray(0, 16).toString("base64") }] }).success).toBe(false);
    }
  });

  test("image requests larger than the old 1 MiB limit survive client and gateway intact", async () => {
    const sharp = (await import("sharp")).default;
    const pixels = Buffer.alloc(800 * 800 * 3);
    let seed = 12345;
    for (let index = 0; index < pixels.length; index++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; pixels[index] = seed >>> 24; }
    const bytes = await sharp(pixels, { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer();
    expect(bytes.length).toBeGreaterThan(1_048_576);
    const images = [{ content_type: "image/png" as const, base64: bytes.toString("base64") }];
    const handler = createFetchHandler({ config: configSchema.parse({ version: 1, hosted: { provider: "cloudflare", enabled: true } }), env, fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json(catalog);
      expect(JSON.parse(String(init?.body)).images).toEqual(images);
      return Response.json({ success: true, result: answer });
    }) as unknown as typeof fetch });
    const client = createClient({ fetch: (async (url: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(url), init))) as unknown as typeof fetch });
    expect((await client.evaluate({ ...request, images })).response.model).toBe("clef");
    const largerPixels = Buffer.alloc(1000 * 1000 * 3);
    for (let index = 0; index < largerPixels.length; index++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; largerPixels[index] = seed >>> 24; }
    const largerBytes = await sharp(largerPixels, { raw: { width: 1000, height: 1000, channels: 3 } }).png().toBuffer();
    const largerImage = { content_type: "image/png" as const, base64: largerBytes.toString("base64") };
    expect(systemOneRequestSchema.safeParse({ ...request, images: [largerImage] }).success).toBe(true);
    expect(systemOneRequestSchema.safeParse({ ...request, images: [largerImage, largerImage, largerImage] }).success).toBe(false);
    const response = await handler(new Request("http://127.0.0.1:13900/v1/systemone", { method: "POST", body: JSON.stringify({ ...request, images: [largerImage, largerImage, largerImage] }) }));
    expect(response.status).toBe(422);
  });

  test("invalid image headers, MIME mismatch and huge dimensions fail locally", () => {
    for (const invalid of [{ ...image, base64: "AAAA" }, { ...image, content_type: "image/jpeg" }, "https://example.com/private.png"]) {
      expect(systemOneRequestSchema.safeParse({ ...request, images: [invalid] }).success).toBe(false);
    }
    const invalidChecksum = Buffer.from(image.base64, "base64");
    invalidChecksum[29] = invalidChecksum[29]! ^ 1;
    expect(systemOneRequestSchema.safeParse({ ...request, images: [{ ...image, base64: invalidChecksum.toString("base64") }] }).success).toBe(false);
    const bytes = Buffer.from(image.base64, "base64");
    bytes.writeUInt32BE(16_000_001, 16);
    expect(systemOneRequestSchema.safeParse({ ...request, images: [{ ...image, base64: bytes.toString("base64") }] }).success).toBe(false);
  });

  test("images never reach text-only backends", async () => {
    const config = configSchema.parse({ version: 1, backends: [{ name: "text", model: "text", base_url: "http://127.0.0.1:8080" }] });
    let inference = 0;
    const handler = createFetchHandler({ config, env: {}, fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") inference++;
      return Response.json({ data: [{ id: "text" }] });
    }) as unknown as typeof fetch });
    const response = await handler(new Request("http://127.0.0.1:13900/v1/systemone", { method: "POST", body: JSON.stringify({ ...request, model: "text/text" }) }));
    expect(response.status).toBe(422);
    expect(inference).toBe(0);
  });

  test("a Clef transport rejection is uncertain and never eligible for redispatch", async () => {
    const config = configSchema.parse({ version: 1, hosted: { provider: "cloudflare", enabled: true } });
    const backend = runtimeBackends(config, env)[0]!;
    let calls = 0;
    const result = await forwardToBackend(backend, JSON.stringify(request), "clef", 1000, (async () => {
      calls++;
      throw new Error("private-token private-state");
    }) as unknown as typeof fetch);
    expect(result.kind).toBe("response");
    expect(result).toMatchObject({ status: 503, content_type: "application/json" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(calls).toBe(1);
    const handler = createFetchHandler({ config, env, fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json(catalog);
      throw new Error("private-token private-state");
    }) as unknown as typeof fetch });
    const response = await handler(new Request("http://127.0.0.1:13900/v1/systemone", { method: "POST", body: JSON.stringify(request) }));
    expect(response.status).toBe(503);
    expect(response.headers.get("x-sys1-attempts")).toBe("1");
    expect(await response.json()).toMatchObject({ error: { type: "backend_outcome_uncertain" } });
  });

  test("failed REST envelopes and model mismatches are definitive and private", async () => {
    for (const value of [{ success: false, errors: [{ message: "private-error" }] }, { success: true, result: { ...answer, model: "clef-flash" } }]) {
      let inference = 0;
      const config = configSchema.parse({ version: 1, hosted: { provider: "cloudflare", enabled: true } });
      const handler = createFetchHandler({ config, env, fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "GET") return Response.json(catalog);
        inference++;
        return Response.json(value);
      }) as unknown as typeof fetch });
      const response = await handler(new Request("http://127.0.0.1:13900/v1/systemone", { method: "POST", body: JSON.stringify(request) }));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("private-error");
      expect(inference).toBe(1);
    }
  });
});
