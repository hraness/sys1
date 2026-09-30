// PostHog settings for the sys1.io marketing pages.
// Pure functions only: the bundle entry wires them to posthog-js, and tests
// exercise them without a browser. The site has no forms, accounts, or
// private routes. Events are cookieless and anonymous, carry no page text,
// and keep only campaign parameters from the query string.
//
// sys1.io is a static site, so it mirrors the before_send rules of
// @hraness/posthog v0.2.0 until that package ships a browser entry point a
// static bundle can import.

export const SITE_ID = "sys1" as const;
export const CANONICAL_DOMAIN = "sys1.io" as const;
export const CANONICAL_ORIGIN = `https://${CANONICAL_DOMAIN}` as const;
export const ALLOWED_HOSTS: readonly string[] = [CANONICAL_DOMAIN];
export const POSTHOG_API_HOST = "https://us.i.posthog.com" as const;
// The shared public project token for Hraness small sites (project 543691).
// PostHog designs `phc_` project tokens to be public: they can only send
// events. It stays a literal because the static site has no build step that
// could read an environment variable.
export const POSTHOG_PROJECT_TOKEN = "phc_xqEpQgmKxZDYda3DvForfnKDuVL6urqD2YTtqDPmUL4u" as const;
// Mirrors POSTHOG_SCHEMA_VERSION in @hraness/posthog v0.2.0. Change both together.
export const POSTHOG_SCHEMA_VERSION = 2 as const;

const ROUTES = new Map<string, string>([
  ["/", "home"],
  ["/skills", "skills"],
  ["/docs", "docs"],
  ["/docs/evaluations", "evaluations"],
  ["/docs/evaluations-history", "evaluations_history"],
  ["/compare", "compare"],
  ["/introducing-sys1", "article"],
]);
export const NOT_FOUND_CANONICAL_PATH = "/404" as const;

export const CUSTOM_EVENTS = ["page not found", "cta clicked", "install command copied"] as const;
export const ALLOWED_EVENTS: ReadonlySet<string> = new Set(["$pageview", "$pageleave", "$web_vitals", "$exception", ...CUSTOM_EVENTS]);
export const PLACEMENTS = ["hero", "nav", "footer", "inline", "pricing", "docs", "modal", "sticky", "not_found"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export const INSTALL_METHODS = ["brew", "curl", "npm", "bun", "pip", "go", "cargo", "other"] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];

// The CTA list: the page's data-analytics-cta value maps to a stable id and placement.
export const CTAS: Readonly<Record<string, Readonly<{ cta: string; placement: Placement }>>> = {
  "header-install-sys1": { cta: "install_sys1", placement: "nav" },
  "hero-install-sys1": { cta: "install_sys1", placement: "hero" },
  "hero-workflows": { cta: "explore_workflows", placement: "hero" },
  "benchmarks-study": { cta: "read_study", placement: "inline" },
  "benchmarks-evaluations": { cta: "browse_evaluations", placement: "inline" },
  "saved-workflows": { cta: "saved_workflows_docs", placement: "inline" },
  "skills-review": { cta: "review_skill_docs", placement: "inline" },
  "skills-verify": { cta: "verify_skill_docs", placement: "inline" },
};

// Copy buttons on install commands. Other copy buttons (usage examples) send nothing.
export const INSTALL_COMMANDS: Readonly<Record<string, Readonly<{ install_method: InstallMethod; placement: Placement }>>> = {
  "install-command": { install_method: "npm", placement: "inline" },
  "install-command-macos": { install_method: "npm", placement: "inline" },
  "install-command-linux": { install_method: "npm", placement: "inline" },
  "install-command-windows": { install_method: "npm", placement: "inline" },
  "docs-install-command-macos": { install_method: "npm", placement: "docs" },
  "docs-install-command-linux": { install_method: "npm", placement: "docs" },
  "docs-install-command-windows": { install_method: "npm", placement: "docs" },
};

// Campaign and ad click parameters kept from the query string, per the
// Hraness observability standard. Every other parameter is dropped.
export const ATTRIBUTION_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "gbraid", "wbraid", "gad_source", "fbclid", "msclkid", "ttclid", "twclid",
  "li_fat_id", "igshid", "dclid", "epik", "rdt_cid", "sccid", "irclid", "mc_cid",
] as const;
const ATTRIBUTION = new Set<string>(ATTRIBUTION_PARAMS);
const MAX_ATTRIBUTION_LENGTH = 256;
const MAX_STRING_LENGTH = 2048;
const MAX_DEPTH = 6;

// posthog-js campaign properties that are not on the keep-list, and the
// search query posthog-js reads from a referrer.
const DROPPED_QUERY_PROPERTIES = new Set(["_kx", "ref", "gclsrc", "qclid", "ph_keyword"]);
// Values that must pass through byte for byte: ingestion routing and the cookieless hash.
const VERBATIM_PROPERTIES = new Set(["token", "distinct_id", "$raw_user_agent", "$cookieless_mode"]);
const URL_PROPERTIES = new Set(["$current_url", "$initial_current_url", "$session_entry_url"]);
const REFERRER_PROPERTIES = new Set(["$referrer", "$initial_referrer", "$session_entry_referrer"]);
const PATHNAME_PROPERTIES = new Set(["$pathname", "$initial_pathname", "$session_entry_pathname", "$prev_pageview_pathname"]);

export type Capture = Readonly<{
  event: string;
  properties?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}>;

export type PageLocation = Readonly<{ protocol: string; hostname: string; pathname: string }>;

export function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/u, "").replace(/^www\./u, "");
}

export function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOSTS.includes(normalizeHost(hostname));
}

/** The real path with duplicate slashes, `.html`, `/index`, and trailing slashes removed. */
export function normalizePath(pathname: string): string {
  const raw = (pathname.split(/[?#]/u, 1)[0] ?? "/") || "/";
  const path = (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/{2,}/gu, "/").replace(/\.html$/u, "").replace(/\/index$/u, "/");
  const trimmed = path.length > 1 ? path.replace(/\/+$/u, "") : "/";
  return trimmed.slice(0, 256) || "/";
}

export function isKnownRoute(pathname: string): boolean {
  return ROUTES.has(normalizePath(pathname));
}

export function canonicalPath(pathname: string): string {
  const path = normalizePath(pathname);
  return ROUTES.has(path) ? path : NOT_FOUND_CANONICAL_PATH;
}

export function pageKind(pathname: string): string {
  return ROUTES.get(normalizePath(pathname)) ?? "not_found";
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, "Bearer [credential]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s?#]+)@/giu, "$1[credential]@")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    // Queries and fragments go; a trailing :line:column from a stack frame stays.
    .replace(/(https?:\/\/[^\s?#)]+)(?:\?[^\s#):]*)?(?:#[^\s):]*)?/giu, "$1")
    .replace(/([/][^\s?#)]+)\?[^\s#):]*/gu, "$1")
    .replace(/\b(api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password|code|state)=([^\s&]+)/giu, "$1=[redacted]");
}

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Owned URL: canonical origin, normalized path, attribution parameters only. Other URL: origin. */
export function sanitizeUrl(value: string): string | undefined {
  const url = parseUrl(value);
  if (url === null) return undefined;
  if (!isAllowedHost(url.hostname)) return url.origin;
  const query = new URLSearchParams();
  for (const [key, param] of url.searchParams) {
    if (ATTRIBUTION.has(key) && param !== "") query.append(key, param.slice(0, MAX_ATTRIBUTION_LENGTH));
  }
  const search = query.toString();
  return `${CANONICAL_ORIGIN}${normalizePath(url.pathname)}${search === "" ? "" : `?${search}`}`;
}

/** Third-party referrer: origin only. Own-host referrer: origin and path. Empty: `$direct`. */
export function sanitizeReferrer(value: unknown): string {
  if (typeof value !== "string" || value === "" || value === "$direct") return "$direct";
  const url = parseUrl(value);
  if (url === null) return "$direct";
  return isAllowedHost(url.hostname) ? `${CANONICAL_ORIGIN}${normalizePath(url.pathname)}` : url.origin;
}

export function referrerHost(value: unknown): string | undefined {
  const referrer = sanitizeReferrer(value);
  return referrer === "$direct" ? undefined : normalizeHost(new URL(referrer).hostname);
}

// Copied from @hraness/posthog src/traffic.ts classifyAnalyticsTraffic.
const AI_SOURCES = [
  ["chatgpt", ["chatgpt.com", "chat.openai.com"]],
  ["perplexity", ["perplexity.ai"]],
  ["claude", ["claude.ai"]],
  ["gemini", ["gemini.google.com"]],
  ["copilot", ["copilot.microsoft.com"]],
  ["poe", ["poe.com"]],
  ["you.com", ["you.com"]],
  ["meta_ai", ["meta.ai"]],
] as const;
const SEARCH_SOURCES = [
  ["google", ["google.com", "google.co.uk", "google.ca", "google.com.au"]],
  ["bing", ["bing.com"]],
  ["duckduckgo", ["duckduckgo.com"]],
  ["yahoo", ["search.yahoo.com", "yahoo.com"]],
  ["brave", ["search.brave.com"]],
  ["ecosia", ["ecosia.org"]],
  ["baidu", ["baidu.com"]],
  ["yandex", ["yandex.com", "yandex.ru"]],
] as const;
const SOCIAL_SOURCES = [
  ["reddit", ["reddit.com"]],
  ["x", ["x.com", "twitter.com", "t.co"]],
  ["linkedin", ["linkedin.com"]],
  ["facebook", ["facebook.com", "fb.com"]],
  ["instagram", ["instagram.com"]],
  ["youtube", ["youtube.com", "youtu.be"]],
  ["mastodon", ["mastodon.social"]],
  ["threads", ["threads.net"]],
] as const;
type Sources = readonly (readonly [string, readonly string[]])[];
const CHANNELS = [["ai_referral", AI_SOURCES], ["organic_search", SEARCH_SOURCES], ["social", SOCIAL_SOURCES]] as const;

const hostnameMatches = (hostname: string, domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
const sourceFor = (hostname: string, sources: Sources) => sources.find(([, domains]) => domains.some((domain) => hostnameMatches(hostname, domain)))?.[0] ?? null;

export type TrafficContext = Readonly<{ traffic_channel: string; traffic_source: string; referrer_host?: string }>;

export function classifyTraffic(referrer: unknown, currentUrl: unknown): TrafficContext {
  const utmSource = typeof currentUrl === "string" ? parseUrl(currentUrl)?.searchParams.get("utm_source")?.trim().toLowerCase().replace(/^www\./u, "") : undefined;
  if (utmSource) {
    for (const [channel, sources] of CHANNELS) {
      const source = sources.find(([name, domains]) => utmSource === name || domains.some((domain) => hostnameMatches(utmSource, domain)))?.[0];
      if (source) return { traffic_channel: channel, traffic_source: source };
    }
  }
  const host = referrerHost(referrer);
  if (host === undefined) return { traffic_channel: "direct", traffic_source: "direct" };
  if (isAllowedHost(host)) return { traffic_channel: "internal", traffic_source: "internal", referrer_host: host };
  for (const [channel, sources] of CHANNELS) {
    const source = sourceFor(host, sources);
    if (source) return { traffic_channel: channel, traffic_source: source, referrer_host: host };
  }
  return { traffic_channel: "referral", traffic_source: host, referrer_host: host };
}

function baseKey(key: string): string {
  return key.replace(/^\$(?:initial|session_entry)_/u, "");
}

function scrubValue(key: string, value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (URL_PROPERTIES.has(key)) return sanitizeUrl(value);
    if (REFERRER_PROPERTIES.has(key)) return sanitizeReferrer(value);
    if (PATHNAME_PROPERTIES.has(key)) return normalizePath(value);
    return redactSensitiveText(value).slice(0, MAX_STRING_LENGTH);
  }
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => scrubValue("", item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value === "object") return scrubObject(value as Record<string, unknown>, depth + 1);
  return undefined;
}

function scrubObject(source: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const attribution = baseKey(key);
    if (DROPPED_QUERY_PROPERTIES.has(attribution)) continue;
    if (ATTRIBUTION.has(attribution)) {
      if (typeof value === "string" && value !== "") result[key] = value.slice(0, MAX_ATTRIBUTION_LENGTH);
      continue;
    }
    if (VERBATIM_PROPERTIES.has(key) && depth === 0) {
      result[key] = value;
      continue;
    }
    const scrubbed = scrubValue(key, value, depth);
    if (scrubbed !== undefined) result[key] = scrubbed;
  }
  return result;
}

/**
 * The before_send hook. Drops events outside the allowlist and everything on
 * a host that is not sys1.io, then scrubs every property value in place of
 * rebuilding the property set, so PostHog keeps the fields web analytics needs.
 */
export function sanitizeCapture(capture: Capture | null, location: PageLocation, documentReferrer: string, token: string = POSTHOG_PROJECT_TOKEN): Capture | null {
  if (capture === null || !ALLOWED_EVENTS.has(capture.event)) return null;
  if (!token.startsWith("phc_") || location.protocol !== "https:" || !isAllowedHost(location.hostname)) return null;
  const source = capture.properties ?? {};
  const properties = scrubObject(source, 0);
  const pathname = normalizePath(location.pathname);
  const rawReferrer = source.$referrer ?? documentReferrer;
  properties.$host = normalizeHost(typeof source.$host === "string" && source.$host !== "" ? source.$host : location.hostname);
  properties.$current_url ??= `${CANONICAL_ORIGIN}${pathname}`;
  properties.$pathname ??= pathname;
  properties.$referrer = sanitizeReferrer(rawReferrer);
  properties.$referring_domain = referrerHost(rawReferrer) ?? "$direct";
  // Cookieless posthog-js stores no campaign state, so it sends no utm_* or
  // click-ID properties. Produce them from the page URL's query instead.
  const pageUrl = typeof source.$current_url === "string" ? parseUrl(source.$current_url) : null;
  for (const name of ATTRIBUTION_PARAMS) {
    const param = pageUrl?.searchParams.get(name);
    if (properties[name] === undefined && param) properties[name] = param.slice(0, MAX_ATTRIBUTION_LENGTH);
  }
  const traffic = classifyTraffic(rawReferrer, source.$current_url);
  Object.assign(properties, {
    $process_person_profile: false,
    analytics_schema_version: POSTHOG_SCHEMA_VERSION,
    site_id: SITE_ID,
    canonical_domain: CANONICAL_DOMAIN,
    canonical_path: canonicalPath(pathname),
    page_kind: pageKind(pathname),
    traffic_channel: traffic.traffic_channel,
    traffic_source: traffic.traffic_source,
  });
  if (traffic.referrer_host !== undefined) properties.referrer_host = traffic.referrer_host;
  const { $set: _set, $set_once: _setOnce, ...rest } = capture;
  return { ...rest, properties };
}

export function shouldLoad(location: { protocol: string; hostname: string }, navigatorValue: { doNotTrack?: string | null; globalPrivacyControl?: boolean }): boolean {
  return location.protocol === "https:"
    && isAllowedHost(location.hostname)
    && navigatorValue.doNotTrack !== "1"
    && navigatorValue.globalPrivacyControl !== true;
}

export function ctaEvent(value: string | undefined) {
  return value === undefined ? undefined : CTAS[value];
}

export function installEvent(value: string | undefined) {
  return value === undefined ? undefined : INSTALL_COMMANDS[value];
}

export function notFoundEvent(pathname: string, referrer: string): Readonly<{ requested_path: string; referrer_host?: string }> | undefined {
  if (isKnownRoute(pathname)) return undefined;
  const host = referrerHost(referrer);
  return { requested_path: normalizePath(pathname), ...(host === undefined ? {} : { referrer_host: host }) };
}

// Exceptions: 20 per minute in total and 2 per fingerprint, as in @hraness/posthog.
export function sanitizeError(value: unknown): Error {
  try {
    if (!(value instanceof Error)) return new Error("Non-Error rejection");
    const sanitized = new Error(redactSensitiveText(value.message || "Unknown error").slice(0, 500));
    sanitized.name = redactSensitiveText(value.name || "Error").slice(0, 80) || "Error";
    if (value.stack) sanitized.stack = redactSensitiveText(value.stack).slice(0, 4000);
    return sanitized;
  } catch {
    return new Error("Uninspectable rejection");
  }
}

export function errorFingerprint(error: Error): string {
  const input = `${error.name}\n${error.message}\n${error.stack?.split("\n").slice(1, 3).join("\n") ?? ""}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `e_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class ExceptionBudget {
  #all: number[] = [];
  #byFingerprint = new Map<string, number[]>();
  constructor(readonly totalLimit = 20, readonly perFingerprintLimit = 2, readonly windowMs = 60_000) {}

  allow(fingerprint: string, now = Date.now()): boolean {
    const threshold = now - this.windowMs;
    this.#all = this.#all.filter((time) => time > threshold);
    const matching = (this.#byFingerprint.get(fingerprint) ?? []).filter((time) => time > threshold);
    if (this.#all.length >= this.totalLimit || matching.length >= this.perFingerprintLimit) return false;
    this.#all.push(now);
    matching.push(now);
    this.#byFingerprint.set(fingerprint, matching);
    return true;
  }
}

// Web vitals. The slim posthog-js core has no web-vitals extension, and the
// extension bundle doubles the script, so the entry reads the locally bundled
// web-vitals callbacks and sends $web_vitals in the shape posthog-js uses.
export const WEB_VITALS_METRICS = ["LCP", "CLS", "FCP", "INP"] as const;
export const WEB_VITALS_FLUSH_MS = 5_000;
// posthog-js ignores values at or above 15 minutes; so does this site.
export const WEB_VITALS_MAX_VALUE = 900_000;
export type WebVitalMetric = Readonly<{ name: string; value: number; delta?: number; id?: string; rating?: string; navigationType?: string }>;

export function webVitalsProperties(metrics: readonly (WebVitalMetric & { timestamp: number })[], currentUrl: string): Record<string, unknown> {
  const properties: Record<string, unknown> = { $current_url: currentUrl };
  for (const metric of metrics) {
    const { name, value, delta, id, rating, navigationType, timestamp } = metric;
    properties[`$web_vitals_${name}_event`] = { name, value, delta, id, rating, navigationType, $current_url: currentUrl, timestamp };
    properties[`$web_vitals_${name}_value`] = value;
  }
  return properties;
}

export function acceptWebVital(metric: WebVitalMetric | undefined): metric is WebVitalMetric {
  return metric !== undefined
    && (WEB_VITALS_METRICS as readonly string[]).includes(metric.name)
    && Number.isFinite(metric.value)
    && metric.value >= 0
    && metric.value < WEB_VITALS_MAX_VALUE;
}

// Exceptions in the $exception_list shape posthog-js builds, from a
// sanitized error whose stack keeps file and line but no query strings.
const STACK_FRAME = /^\s*(?:at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?|(.*?)@(.*?):(\d+):(\d+))\s*$/u;

export function stackFrames(stack: string | undefined): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  for (const line of (stack ?? "").split("\n").slice(0, 30)) {
    const match = STACK_FRAME.exec(line);
    if (match === null) continue;
    const fn = match[1] ?? match[5] ?? "";
    const filename = match[2] ?? match[6] ?? "";
    frames.push({
      platform: "web:javascript",
      filename,
      function: fn === "" ? "?" : fn,
      lineno: Number(match[3] ?? match[7]),
      colno: Number(match[4] ?? match[8]),
      in_app: true,
    });
  }
  // posthog-js lists frames oldest first.
  return frames.reverse();
}

export function exceptionProperties(error: Error, origin: "window_error" | "unhandled_rejection", fingerprint: string): Record<string, unknown> {
  const frames = stackFrames(error.stack);
  return {
    $exception_level: "error",
    $exception_list: [{
      type: error.name,
      value: error.message,
      mechanism: { handled: false, synthetic: false, type: origin === "window_error" ? "onerror" : "onunhandledrejection" },
      ...(frames.length === 0 ? {} : { stacktrace: { type: "raw", frames } }),
    }],
    error_surface: "client",
    error_origin: origin,
    error_fingerprint: fingerprint,
  };
}

export function posthogConfig(before_send: (capture: Capture | null) => Capture | null) {
  return {
    api_host: POSTHOG_API_HOST,
    ui_host: "https://us.posthog.com",
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    // Consent is checked for every event; do not retain a queue after a changed choice.
    request_batching: false,
    // The slim core cannot load the web-vitals extension; the entry sends
    // $web_vitals itself (see webVitalsProperties).
    capture_performance: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    rageclick: false,
    cookieless_mode: "always",
    persistence: "memory",
    person_profiles: "never",
    respect_dnt: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: false,
    properties_string_max_length: MAX_STRING_LENGTH,
    rate_limiting: { events_per_second: 2, events_burst_limit: 12 },
    before_send,
  } as const;
}
