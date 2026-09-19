import { describe, expect, test } from "bun:test";
import { configSchema } from "../src/config.ts";
import { createNetworkFetchHandler, startGateway } from "../src/gateway.ts";
import { readBoundedText } from "../src/http.ts";

const requestBody = JSON.stringify({ state: "synthetic fixture", questions: { q: { type: "noul" } } });
const answer = {
  model: "jev-latest", answers: { q: { type: "noul", noul: 0.5 } },
  usage: { input_tokens: 0, output_tokens: 0 },
};

function fixture() {
  const config = configSchema.parse({ version: 1, hosted: { enabled: true } });
  let backendCalls = 0;
  const deps = {
    config, env: { TYPESAFE_API_KEY: "test-only-placeholder" },
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      backendCalls += 1;
      if (init?.method === "POST") return Response.json(answer);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return url.pathname === "/v1/models" ? Response.json({ data: ["jev-latest"] }) : new Response(null, { status: 404 });
    }) as unknown as typeof fetch,
  };
  return { deps, handle: createNetworkFetchHandler(deps), backendCalls: () => backendCalls };
}

function decision(headers: Record<string, string> = {}, url = "http://127.0.0.1:13900/v1/systemone") {
  return new Request(url, {
    method: "POST", body: requestBody, headers: { "content-type": "application/json", ...headers },
  });
}

describe("network gateway admission", () => {
  const browserHeaders: Record<string, string>[] = [
    { origin: "https://untrusted.example", "content-type": "text/plain" },
    { origin: "null" },
    { origin: "http://127.0.0.1:13900" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "none" },
  ];
  test.each(browserHeaders)("browser metadata is rejected before hosted probing or dispatch: %j", async (headers) => {
    const app = fixture();
    const response = await app.handle(decision(headers));
    expect(response.status).toBe(403);
    expect(app.backendCalls()).toBe(0);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  test.each([
    "http://untrusted.example:13900/v1/systemone",
    "http://127.0.0.1.untrusted.example:13900/v1/systemone",
    "http://localhost.untrusted.example:13900/v1/systemone",
  ])("DNS-rebinding request authorities are rejected: %s", async (url) => {
    const app = fixture();
    expect((await app.handle(decision({}, url))).status).toBe(403);
    expect(app.backendCalls()).toBe(0);
  });

  test.each(["untrusted.example:13900", "127.0.0.1:13900/path", "127.0.0.1:13900#fragment"])(
    "a conflicting or malformed Host is rejected: %s", async (host) => {
      const app = fixture();
      expect((await app.handle(decision({ host }))).status).toBe(403);
      expect(app.backendCalls()).toBe(0);
    },
  );

  test.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])(
    "simple request content types are rejected even without browser metadata: %s", async (contentType) => {
      const app = fixture();
      expect((await app.handle(decision({ "content-type": contentType }))).status).toBe(415);
      expect(app.backendCalls()).toBe(0);
    },
  );

  test("native fetch mode metadata and JSON parameters remain supported", async () => {
    const app = fixture();
    const response = await app.handle(decision({
      "sec-fetch-mode": "cors", "content-type": "Application/JSON; charset=utf-8", host: "127.0.0.1:13900",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
  });

  test("native IPv6 loopback authorities remain supported", async () => {
    const app = fixture();
    const response = await app.handle(decision({ host: "[::1]:13900" }, "http://[::1]:13900/v1/systemone"));
    expect(response.status).toBe(200);
  });

  test("actual Node fetch reaches startGateway with native headers", async () => {
    const app = fixture();
    const gateway = startGateway({ ...app.deps, port: 0 });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn(["node", "--input-type=module", "--eval", `
        const response = await fetch(process.argv[1] + "/v1/systemone", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "synthetic fixture", questions: { q: { type: "noul" } } }),
          signal: AbortSignal.timeout(3000),
        });
        const value = await response.json();
        if (response.status !== 200 || value.answers?.q?.noul !== 0.5) process.exitCode = 1;
        console.log(JSON.stringify({ status: response.status, model: value.model }));
      `, gateway.url], { stdout: "pipe", stderr: "pipe" });
      const activeChild = child;
      timer = setTimeout(() => activeChild.kill(), 5_000);
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        readBoundedText({ body: child.stdout as ReadableStream<Uint8Array> }, 16_384),
        readBoundedText({ body: child.stderr as ReadableStream<Uint8Array> }, 16_384),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ status: 200, model: "jev-latest" });
      expect(app.backendCalls()).toBe(3);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (child !== undefined) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
      await gateway.stop();
    }
  }, 10_000);
});
