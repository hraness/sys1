// Child-process harness for test/site-analytics.test.ts, modeled on the
// slopcamera.com harness (hraness/slopcamera PR #314). It loads the pinned
// posthog-js slim bundle under a minimal browser shape, initializes it with
// the production config and before_send, captures every allowed event, and
// prints the decoded request bodies posthog-js hands to fetch. It runs in its
// own process so the browser globals never leak into other tests.
export {};

const pageUrl = process.argv[2] ?? "https://sys1.io/";
const referrer = process.argv[3] ?? "";
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const pageLocation = new URL(pageUrl);
const listeners = { addEventListener() {}, removeEventListener() {} };
const pageDocument = {
  ...listeners,
  body: null,
  cookie: "",
  createElement: () => ({ ...listeners, setAttribute() {}, style: {} }),
  documentElement: {},
  getElementsByTagName: () => [],
  location: pageLocation,
  querySelector: () => null,
  querySelectorAll: () => [],
  readyState: "complete",
  referrer,
  title: "sys1",
  visibilityState: "visible",
};
const sent: unknown[] = [];
Object.assign(globalThis, {
  document: pageDocument,
  location: pageLocation,
  navigator: { doNotTrack: null, language: "en-US", languages: ["en-US"], onLine: true, userAgent, webdriver: false },
  screen: { height: 900, width: 1440 },
  window: globalThis,
  fetch: async (_url: string, init: { body?: unknown }) => {
    sent.push(init.body);
    return new Response('{"status":1}', { status: 200 });
  },
});
Object.assign(globalThis, { innerHeight: 900, innerWidth: 1440, ...listeners });

const { default: posthog } = await import("posthog-js/dist/module.slim.no-external");
const site = await import("./site-analytics");
const received: unknown[] = [];
const returned: unknown[] = [];
posthog.init(site.POSTHOG_PROJECT_TOKEN, {
  ...site.posthogConfig((capture) => {
    received.push(structuredClone(capture));
    const result = site.sanitizeCapture(capture, pageLocation, referrer);
    returned.push(structuredClone(result));
    return result;
  }),
  request_batching: false,
} as never);

const now = Date.now();
const error = site.sanitizeError(Object.assign(new Error("failed for dev@example.com"), {
  stack: "Error: failed for dev@example.com\n    at run (https://sys1.io/analytics.js?token=phc_abc:1:200)\n    at https://sys1.io/analytics.js:2:10",
}));
const options = { send_instantly: true, transport: "fetch" } as const;
posthog.capture("$pageleave", {}, options);
posthog.capture("$web_vitals", site.webVitalsProperties([
  { name: "LCP", value: 1200, delta: 1200, id: "v1", rating: "good", navigationType: "navigate", timestamp: now },
  { name: "CLS", value: 0.02, delta: 0.02, id: "v2", rating: "good", navigationType: "navigate", timestamp: now },
], pageUrl), options);
posthog.capture("$exception", site.exceptionProperties(error, "window_error", site.errorFingerprint(error)), options);
posthog.capture("page not found", site.notFoundEvent(pageLocation.pathname, referrer) ?? { requested_path: "/known" }, options);
posthog.capture("cta clicked", { ...site.ctaEvent("header-install-sys1") }, options);
posthog.capture("install command copied", { ...site.installEvent("install-command-macos") }, options);
posthog.capture("$autocapture", {}, options);

const expected = 7; // $pageview from init plus six captures; $autocapture is dropped.
for (const deadline = Date.now() + 5_000; sent.length < expected && Date.now() < deadline;) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await new Promise((resolve) => setTimeout(resolve, 50));
const decoder = new TextDecoder();
const bodies = sent.map((body) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body as ArrayBuffer);
  return JSON.parse(decoder.decode(bytes[0] === 0x1f && bytes[1] === 0x8b ? Bun.gunzipSync(bytes) : bytes)) as unknown;
});
process.stdout.write(JSON.stringify({ bodies, received, returned }));
process.exit(0);
