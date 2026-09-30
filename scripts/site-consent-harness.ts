// Exercise the real browser entry, regional consent, footer signal, and PostHog
// transport together. A child process keeps browser globals out of other tests.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";

const scenario = process.argv[2] ?? "required";
assert(["required", "exempt", "unavailable"].includes(scenario));
// Browser performance observers are unrelated to this consent transport check.
mock.module("posthog-js/dist/web-vitals.js", () => ({}));
const windowEvents = new EventTarget();
const documentEvents = new EventTarget();
const location = new URL("https://sys1.io/");
const storage = new Map<string, string>();
const listeners = (target: EventTarget) => ({
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
  dispatchEvent: target.dispatchEvent.bind(target),
});
const documentValue = {
  ...listeners(documentEvents), body: null, cookie: "", documentElement: {},
  createElement: () => ({ ...listeners(new EventTarget()), setAttribute() {}, style: {} }),
  getElementsByTagName: () => [], querySelector: () => null, querySelectorAll: () => [],
  location, readyState: "complete", referrer: "", title: "sys1", visibilityState: "visible",
};
const sent: unknown[] = [];
const pendingRegion: (() => void)[] = [];
Object.assign(globalThis, {
  ...listeners(windowEvents), window: globalThis, document: documentValue, location,
  navigator: { doNotTrack: null, globalPrivacyControl: false, language: "en-US", languages: ["en-US"], onLine: true, userAgent: "Mozilla/5.0", webdriver: false },
  screen: { height: 900, width: 1440 }, innerHeight: 900, innerWidth: 1440,
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  fetch: async (url: string, options: { body?: unknown } = {}) => {
    if (url === "https://account.hraness.com/api/consent/region") {
      return new Promise<Response>((resolve, reject) => pendingRegion.push(() => {
        if (scenario === "unavailable") reject(new Error("Fixture region unavailable"));
        else resolve(Response.json({ required: scenario === "required" }));
      }));
    }
    assert.equal(new URL(url).origin, "https://us.i.posthog.com");
    sent.push(options.body);
    return Response.json({ status: 1 });
  },
});

await import("./site-analytics-entry");
assert(pendingRegion.length > 0, "the deployed entry must request regional policy");
assert.equal(sent.length, 0, "no collection while regional policy is unresolved");
for (const settle of pendingRegion) settle();
if (scenario === "exempt") {
  for (const deadline = Date.now() + 5_000; sent.length < 1 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 10));
}
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(sent.length, scenario === "exempt" ? 1 : 0, "only an exempt region starts automatically");
storage.set("hraness-consent-cookies-v1", "accepted");
windowEvents.dispatchEvent(new Event("hraness-consent-accepted"));
for (const deadline = Date.now() + 5_000; sent.length < 1 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(sent.length, 1, "acceptance emits one initial pageview");
windowEvents.dispatchEvent(new Event("hraness-consent-accepted"));
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(sent.length, 1, "repeated acceptance cannot initialize the SDK twice");

const { default: posthog } = await import("posthog-js/dist/module.slim.no-external");
storage.set("hraness-consent-cookies-v1", "declined");
windowEvents.dispatchEvent(Object.assign(new Event("storage"), { key: "hraness-consent-cookies-v1" }));
posthog.capture("$pageleave", {}, { send_instantly: true, transport: "fetch" });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(sent.length, 1, "a changed choice blocks subsequent collection");
console.log(JSON.stringify({ scenario, regionRequests: pendingRegion.length, analyticsRequests: sent.length, passed: true }));
process.exit(0);
