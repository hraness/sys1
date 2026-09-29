import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalPath, posthogConfig, referrerOrigin, sanitizeCapture, shouldLoad, analyticsIdentifier, POSTHOG_API_HOST } from "../scripts/site-analytics.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const pages = [...new Bun.Glob("**/*.html").scanSync(resolve(root, "site"))];

test("every page loads the local analytics bundle and no remote script", () => {
  for (const page of pages) {
    const html = read(`site/${page}`);
    expect(html).toContain('<script src="/analytics.js" defer></script>');
    expect(html).not.toMatch(/<script[^>]+src="https?:/u);
  }
});

test("CSP allows only the PostHog ingest host beyond self", () => {
  const policy: string = JSON.parse(read("vercel.json")).headers.flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers)
    .find((header: { key: string }) => header.key === "Content-Security-Policy").value;
  expect(policy.match(/(?:^|;\s*)connect-src ([^;]+)/u)?.[1]).toBe(POSTHOG_API_HOST);
  expect(policy.match(/(?:^|;\s*)script-src ([^;]+)/u)?.[1]).toBe("'self'");
});

test("analytics loads only on the canonical https host without DNT or GPC", () => {
  const live = { protocol: "https:", hostname: "sys1.io" };
  expect(shouldLoad(live, {})).toBe(true);
  expect(shouldLoad(live, { doNotTrack: "1" })).toBe(false);
  expect(shouldLoad(live, { globalPrivacyControl: true })).toBe(false);
  expect(shouldLoad({ protocol: "http:", hostname: "127.0.0.1" }, {})).toBe(false);
  expect(shouldLoad({ protocol: "https:", hostname: "sys1-git-branch.vercel.app" }, {})).toBe(false);
});

test("config is cookieless and disables capture beyond the allowlist", () => {
  const config = posthogConfig(capture => capture);
  expect(config).toMatchObject({ cookieless_mode: "always", persistence: "memory", person_profiles: "never", autocapture: false, disable_session_recording: true, respect_dnt: true, disable_external_dependency_loading: true });
});

test("sanitizer drops unknown events and strips query strings, paths, and page content", () => {
  const location = { pathname: "/skills" };
  expect(sanitizeCapture({ event: "$autocapture", properties: {} }, location, "")).toBeNull();
  expect(sanitizeCapture({ event: "$identify", properties: {} }, location, "")).toBeNull();
  const result = sanitizeCapture({
    event: "install command copied",
    properties: { command_id: "install-command", $current_url: "https://sys1.io/skills?email=a@b.c#x", $el_text: "secret", $referrer: "https://news.example/item?id=1", cta_id: "Bad Value!" },
    $set: { email: "a@b.c" },
  }, location, "");
  expect(result?.properties).toMatchObject({ command_id: "install-command", $current_url: "https://sys1.io/skills", $pathname: "/skills", $referrer: "https://news.example", $referring_domain: "news.example", site_id: "sys1", page_kind: "skills", $process_person_profile: false });
  expect(result?.properties).not.toHaveProperty("$el_text");
  expect(result?.properties).not.toHaveProperty("cta_id");
  expect(result?.$set).toBeUndefined();
});

test("paths canonicalize to known routes", () => {
  expect(canonicalPath("/index.html")).toBe("/");
  expect(canonicalPath("/docs/evaluations/")).toBe("/docs/evaluations");
  expect(canonicalPath("/private/token")).toBe("/not-found");
  expect(referrerOrigin("javascript:alert(1)")).toBe("$direct");
  expect(analyticsIdentifier("hero-install-skills")).toBe("hero-install-skills");
  expect(analyticsIdentifier("x".repeat(60))).toBeUndefined();
});

test("every CTA id on the pages is a valid identifier", () => {
  for (const page of pages) for (const match of read(`site/${page}`).matchAll(/data-analytics-cta="([^"]*)"/gu)) expect(analyticsIdentifier(match[1])).toBe(match[1]);
});
