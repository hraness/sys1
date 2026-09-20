import { describe, expect, spyOn, test } from "bun:test";
import { createRouter } from "../src/runtime.ts";
import { configSchema } from "../src/config.ts";
import { LocalRunner, defaultEngineFactory } from "../src/local/runner.ts";

const input = { model: "local/small", state: "private input", questions: { q: { type: "noul" as const } } };
const output = { model: "small", answers: { q: { type: "noul", noul: 0.75 } }, usage: { input_tokens: 1, output_tokens: 0 } };

describe("embedded router", () => {
  test("routes in process with explicit config and returns metadata", async () => {
    const targets: string[] = [];
    const router = createRouter({
      config: configSchema.parse({ version: 1, backends: [{ name: "local", base_url: "http://127.0.0.1:18080", model: "small" }] }),
      env: {},
      fetchFn: (async (target: RequestInfo | URL, init?: RequestInit) => {
        const url = String(target);
        targets.push(url);
        if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "small" }] });
        if (url.endsWith("/v1/limits")) return new Response(null, { status: 404 });
        expect(JSON.parse(String(init?.body))).toEqual({ ...input, model: "small" });
        return Response.json(output);
      }) as typeof fetch,
    });
    try {
      const result = await router.evaluate(input);
      expect(result.response.model).toBe("small");
      expect(result.metadata).toEqual({ backend: "local", attempts: 1 });
      expect(targets.every((url) => url.startsWith("http://127.0.0.1:18080/"))).toBe(true);
      expect((await router.fetch(new Request("http://embedded/healthz"))).status).toBe(200);
    } finally {
      await router.dispose();
    }
  });

  test("does not activate hosted service implicitly and rejects use after disposal", async () => {
    let calls = 0;
    const router = createRouter({
      config: configSchema.parse({ version: 1 }), env: { TYPESAFE_API_KEY: "explicit-but-disabled" },
      fetchFn: (async () => { calls++; throw new Error("unexpected network"); }) as unknown as typeof fetch,
    });
    await expect(router.evaluate(input)).rejects.toMatchObject({ code: "http_error", status: 503 });
    expect(calls).toBe(0);
    await router.dispose();
    expect((await router.fetch(new Request("http://embedded/healthz"))).status).toBe(503);
    await expect(router.evaluate(input)).rejects.toMatchObject({ code: "http_error", status: 503 });
    await router.dispose();
  });

  test("disposes its owned runner exactly once", async () => {
    const dispose = spyOn(LocalRunner.prototype, "dispose").mockResolvedValue();
    try {
      const router = createRouter({ config: configSchema.parse({ version: 1 }), env: {}, home: "/unused-model-store" });
      await Promise.all([router.dispose(), router.dispose()]);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      dispose.mockRestore();
    }
  });

  test("preserves caller ownership of an injected runner", async () => {
    const runner = new LocalRunner({ home: "/unused-model-store", maxLoadedModels: 1, engineFactory: defaultEngineFactory(2048, 1000) });
    const dispose = spyOn(runner, "dispose");
    try {
      const router = createRouter({ config: configSchema.parse({ version: 1 }), env: {}, home: "/unused-model-store", localRunner: runner });
      await router.dispose();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      dispose.mockRestore();
      await runner.dispose();
    }
  });
});
