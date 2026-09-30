import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALLOWED_EVENTS,
  canonicalPath,
  CTAS,
  CUSTOM_EVENTS,
  errorFingerprint,
  ExceptionBudget,
  exceptionProperties,
  INSTALL_COMMANDS,
  INSTALL_METHODS,
  notFoundEvent,
  pageKind,
  PLACEMENTS,
  POSTHOG_API_HOST,
  POSTHOG_SCHEMA_VERSION,
  posthogConfig,
  sanitizeCapture,
  sanitizeError,
  sanitizeReferrer,
  shouldLoad,
  webVitalsProperties,
  type Capture,
} from "../scripts/site-analytics.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const pages = [...new Bun.Glob("**/*.html").scanSync(resolve(root, "site"))];
const live = { protocol: "https:", hostname: "sys1.io", pathname: "/skills" };

type Wire = { event: string; properties: Record<string, unknown> };
function runHarness(pageUrl: string, referrer: string): { bodies: Wire[]; received: Capture[] } {
  const child = Bun.spawnSync([process.execPath, resolve(root, "scripts/site-analytics-harness.ts"), pageUrl, referrer], { cwd: root, stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const output = JSON.parse(child.stdout.toString()) as { bodies: unknown[]; received: Capture[] };
  // posthog-js sends { api_key, batch: [event], sent_at } per request.
  const bodies = output.bodies.flatMap((body) => (body as { batch: Wire[] }).batch);
  return { bodies, received: output.received };
}

test("every page loads the local analytics bundle and no remote script", () => {
  expect(pages.length).toBe(8);
  for (const page of pages) {
    const html = read(`site/${page}`);
    expect(html).toContain('<script src="/analytics.js" defer></script>');
    expect(html).not.toMatch(/<script[^>]+src="https?:/u);
  }
});

test("CSP allows the PostHog ingest host and Accounts consent policy", () => {
  const policy: string = JSON.parse(read("vercel.json")).headers.flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers)
    .find((header: { key: string }) => header.key === "Content-Security-Policy").value;
  expect(policy.match(/(?:^|;\s*)connect-src ([^;]+)/u)?.[1]?.split(" ").sort()).toEqual([POSTHOG_API_HOST, "https://account.hraness.com"].sort());
  expect(policy.match(/(?:^|;\s*)script-src ([^;]+)/u)?.[1]).toBe("'self'");
});

test("analytics loads only on the canonical https host without DNT or GPC", () => {
  expect(shouldLoad(live, {})).toBe(true);
  expect(shouldLoad({ protocol: "https:", hostname: "www.sys1.io" }, {})).toBe(true);
  expect(shouldLoad(live, { doNotTrack: "1" })).toBe(false);
  expect(shouldLoad(live, { globalPrivacyControl: true })).toBe(false);
  expect(shouldLoad({ protocol: "http:", hostname: "localhost" }, {})).toBe(false);
  expect(shouldLoad({ protocol: "https:", hostname: "sys1-git-branch.vercel.app" }, {})).toBe(false);
});

test("config matches the portfolio baseline", () => {
  const config = posthogConfig((capture) => capture);
  expect(config).toMatchObject({
    api_host: "https://us.i.posthog.com",
    defaults: "2026-05-30",
    cookieless_mode: "always",
    persistence: "memory",
    person_profiles: "never",
    autocapture: false,
    rageclick: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_pageview: true,
    capture_pageleave: true,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_flags: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: false,
    respect_dnt: true,
    disable_external_dependency_loading: true,
    rate_limiting: { events_per_second: 2, events_burst_limit: 12 },
  });
  expect(POSTHOG_SCHEMA_VERSION).toBe(2);
});

// The standard's test contract: real posthog-js events through the real
// before_send, asserted on the request body handed to fetch.
test("posthog-js request bodies keep web analytics properties and drop personal data", () => {
  const { bodies } = runHarness(
    "https://www.sys1.io/skills?utm_source=newsletter&gclid=click-1&email=dev@example.com&code=oauth-code&q=private#frag",
    "https://news.ycombinator.com/item?id=1",
  );
  const events = bodies.map((body) => body.event).sort();
  expect(events).toEqual(["$exception", "$pageleave", "$pageview", "$web_vitals", "cta clicked", "install command copied", "page not found"].sort());
  for (const body of bodies) {
    const properties = body.properties;
    expect(properties).toMatchObject({
      $host: "sys1.io",
      $current_url: "https://sys1.io/skills?utm_source=newsletter&gclid=click-1",
      $pathname: "/skills",
      $referrer: "https://news.ycombinator.com",
      $referring_domain: "news.ycombinator.com",
      token: expect.stringMatching(/^phc_/u),
      site_id: "sys1",
      analytics_schema_version: POSTHOG_SCHEMA_VERSION,
      canonical_domain: "sys1.io",
      canonical_path: "/skills",
      page_kind: "skills",
      utm_source: "newsletter",
      gclid: "click-1",
      $cookieless_mode: true,
      distinct_id: "$posthog_cookieless",
      $process_person_profile: false,
      traffic_channel: "referral",
      referrer_host: "news.ycombinator.com",
    });
    expect(properties.$raw_user_agent).toContain("Mozilla/5.0");
    // posthog-js cookieless mode ("always") creates no client session or
    // window id; PostHog ingestion assigns sessions from the cookieless hash.
    expect(properties).not.toHaveProperty("$session_id");
    const serialized = JSON.stringify(body);
    for (const leak of ["dev@example.com", "oauth-code", "q=private", "frag", "item?id=1", "phc_abc"]) expect(serialized).not.toContain(leak);
  }
  const byEvent = Object.fromEntries(bodies.map((body) => [body.event, body.properties]));
  expect(byEvent["$web_vitals"]).toMatchObject({ $web_vitals_LCP_value: 1200, $web_vitals_CLS_value: 0.02 });
  expect(byEvent["$exception"]).toMatchObject({ error_surface: "client", error_origin: "window_error", error_fingerprint: expect.stringMatching(/^e_[0-9a-f]{8}$/u) });
  expect(byEvent["cta clicked"]).toMatchObject({ cta: "install_sys1", placement: "nav" });
  expect(byEvent["install command copied"]).toMatchObject({ install_method: "npm", placement: "hero" });
});

test("a 404 render sends page not found with the requested path and referrer host", () => {
  const { bodies } = runHarness("https://sys1.io/old/page?utm_id=spring&token=secret", "https://sys1.io/docs?ref=1");
  const notFound = bodies.find((body) => body.event === "page not found")?.properties;
  expect(notFound).toMatchObject({ requested_path: "/old/page", referrer_host: "sys1.io", canonical_path: "/404", page_kind: "not_found", $referrer: "https://sys1.io/docs", traffic_channel: "internal" });
  expect(bodies.find((body) => body.event === "$pageview")?.properties).toMatchObject({ page_kind: "not_found", $pathname: "/old/page" });
  expect(JSON.stringify(bodies)).not.toContain("secret");
});

test("before_send keeps posthog-js session, window, and attribution properties when present", () => {
  const result = sanitizeCapture({
    event: "$pageview",
    properties: {
      $session_id: "s1", $window_id: "w1", $pageview_id: "p1", $prev_pageview_pathname: "/docs.html",
      $session_entry_utm_source: "x", $initial_gclid: "g", _kx: "person", ref: "friend",
      $el_text: "Contact dev@example.com", nested: { key: "Bearer abc.def", list: ["api_key=123"] },
    },
    $set: { email: "a@b.c" },
  }, live, "");
  expect(result?.properties).toMatchObject({
    $session_id: "s1", $window_id: "w1", $pageview_id: "p1", $prev_pageview_pathname: "/docs",
    $session_entry_utm_source: "x", $initial_gclid: "g", $referrer: "$direct", $referring_domain: "$direct",
    traffic_channel: "direct", $el_text: "Contact [email]", nested: { list: ["api_key=[redacted]"] },
  });
  expect(result?.properties).not.toHaveProperty("_kx");
  expect(result?.properties).not.toHaveProperty("ref");
  expect(result?.$set).toBeUndefined();
});

test("before_send drops unknown events and every event off the production host", () => {
  expect(sanitizeCapture({ event: "$autocapture", properties: {} }, live, "")).toBeNull();
  expect(sanitizeCapture({ event: "$identify", properties: {} }, live, "")).toBeNull();
  for (const hostname of ["localhost", "sys1-git-branch.vercel.app", "preview.sys1.dev"]) {
    expect(sanitizeCapture({ event: "$pageview", properties: {} }, { ...live, hostname }, "")).toBeNull();
  }
  expect(sanitizeCapture({ event: "$pageview", properties: {} }, { ...live, protocol: "http:" }, "")).toBeNull();
});

test("custom events are allowlisted and follow the naming rule", () => {
  for (const event of CUSTOM_EVENTS) {
    expect(ALLOWED_EVENTS.has(event)).toBe(true);
    expect(event).toMatch(/^[a-z]+(?: [a-z]+)+$/u);
  }
  for (const value of Object.values(CTAS)) {
    expect(value.cta).toMatch(/^[a-z][a-z0-9_]*$/u);
    expect(PLACEMENTS).toContain(value.placement);
  }
  for (const value of Object.values(INSTALL_COMMANDS)) {
    expect(INSTALL_METHODS).toContain(value.install_method);
    expect(PLACEMENTS).toContain(value.placement);
  }
});

test("every CTA and install copy button on the pages maps to the event vocabulary", () => {
  const ctas = new Set<string>();
  const copies = new Set<string>();
  for (const page of pages) {
    const html = read(`site/${page}`);
    for (const match of html.matchAll(/data-analytics-cta="([^"]*)"/gu)) ctas.add(match[1]!);
    for (const match of html.matchAll(/data-copy="([^"]*install-command[^"]*)"/gu)) copies.add(match[1]!);
  }
  expect([...ctas].sort()).toEqual(Object.keys(CTAS).sort());
  expect([...copies].sort()).toEqual(Object.keys(INSTALL_COMMANDS).sort());
});

test("paths keep real public routes and class 404s", () => {
  expect(canonicalPath("/index.html")).toBe("/");
  expect(canonicalPath("/docs/evaluations/")).toBe("/docs/evaluations");
  expect(canonicalPath("/private/token")).toBe("/404");
  expect(pageKind("/introducing-sys1")).toBe("article");
  expect(notFoundEvent("/skills", "")).toBeUndefined();
  expect(notFoundEvent("/x".repeat(200), "https://t.co/abc")).toEqual({ requested_path: "/x".repeat(128), referrer_host: "t.co" });
  expect(sanitizeReferrer("javascript:alert(1)")).toBe("$direct");
});

test("web vitals and exceptions use the posthog-js shapes and the package budget", () => {
  expect(webVitalsProperties([{ name: "INP", value: 80, timestamp: 1 }], "https://sys1.io/")).toEqual({
    $current_url: "https://sys1.io/",
    $web_vitals_INP_value: 80,
    $web_vitals_INP_event: { name: "INP", value: 80, delta: undefined, id: undefined, rating: undefined, navigationType: undefined, $current_url: "https://sys1.io/", timestamp: 1 },
  });
  const error = sanitizeError(Object.assign(new Error("token phc_secret for a@b.co"), { stack: "Error\n    at f (https://sys1.io/analytics.js?x=1:1:2)" }));
  expect(error.message).toBe("token [credential] for [email]");
  const properties = exceptionProperties(error, "unhandled_rejection", errorFingerprint(error));
  expect(properties.$exception_list).toEqual([{
    type: "Error",
    value: "token [credential] for [email]",
    mechanism: { handled: false, synthetic: false, type: "onunhandledrejection" },
    stacktrace: { type: "raw", frames: [{ platform: "web:javascript", filename: "https://sys1.io/analytics.js", function: "f", lineno: 1, colno: 2, in_app: true }] },
  }]);
  expect(sanitizeError("plain").message).toBe("Non-Error rejection");
  const budget = new ExceptionBudget();
  expect([budget.allow("a", 0), budget.allow("a", 1), budget.allow("a", 2)]).toEqual([true, true, false]);
  for (let index = 0; index < 18; index += 1) budget.allow(`b${index}`, 3);
  expect(budget.allow("c", 4)).toBe(false);
  expect(budget.allow("c", 60_010)).toBe(true);
});


test("before_send drops nested personal fields and redacts retained attribution", () => {
  const result = sanitizeCapture({ event: "$pageview", properties: {
    token: "phc_public", distinct_id: "$posthog_cookieless",
    email: "opaque-person", $initial_access_token: "opaque-secret", AUTHORIZATION: "opaque-auth",
    $set: { display: "profile" }, nested: { token: "opaque-nested", "api-key": "opaque-key", items: [{ password: "opaque-password", useful: true }] },
    $current_url: "https://sys1.io/skills?utm_source=dev%40example.com&utm_campaign=token%3Dprivate-campaign",
  } }, live, "");
  expect(result?.properties).toMatchObject({ token: "phc_public", distinct_id: "$posthog_cookieless", utm_source: "[email]", utm_campaign: "token=[redacted]", nested: { items: [{ useful: true }] } });
  const serialized = JSON.stringify(result);
  for (const value of ["opaque-", "dev@example.com", "private-campaign", '"display"']) expect(serialized).not.toContain(value);
});

test("private current or historical paths remove all retained campaign properties", () => {
  for (const properties of [
    { $current_url: "https://sys1.io/%61ccount/person?utm_source=private-campaign" },
    { $current_url: "https://sys1.io/skills?utm_source=private-campaign", $initial_current_url: "https://sys1.io/oauth/callback/person?gclid=private-click" },
    { $session_entry_pathname: "/account/person" },
  ]) {
    const result = sanitizeCapture({ event: "$pageview", properties: { ...properties, utm_source: "private-campaign", $initial_gclid: "private-click", $session_entry_utm_campaign: "private-campaign", nested: { utm_source: "private-campaign" } } }, live, "https://sys1.io/account/person");
    expect(result?.properties?.$referrer).toBe("https://sys1.io/private");
    for (const value of ["/person", "private-campaign", "private-click"]) expect(JSON.stringify(result)).not.toContain(value);
  }
});

test("actual SDK request bodies collapse private paths without attribution", () => {
  const { bodies } = runHarness("https://sys1.io/account/private-person?utm_source=private-campaign&gclid=private-click", "https://sys1.io/oauth/callback/private-person");
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body.properties.$pathname).toBe("/private");
    for (const value of ["private-person", "private-campaign", "private-click"]) expect(JSON.stringify(body)).not.toContain(value);
  }
});
