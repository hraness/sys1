// Privacy-preserving PostHog settings for the sys1.io marketing pages.
// Pure functions only: the bundle entry wires them to posthog-js, and tests
// exercise them without a browser. Nothing here reads cookies, storage, page
// text, form fields, or query strings.

export const SITE_ID = "sys1" as const;
export const CANONICAL_DOMAIN = "sys1.io" as const;
export const CANONICAL_ORIGIN = `https://${CANONICAL_DOMAIN}` as const;
export const POSTHOG_API_HOST = "https://us.i.posthog.com" as const;
// The shared public project token for Hraness small sites (project 543691).
// It is a write-only ingestion token that PostHog designs to be public.
export const POSTHOG_PROJECT_TOKEN = "phc_xqEpQgmKxZDYda3DvForfnKDuVL6urqD2YTtqDPmUL4u" as const;
export const SCHEMA_VERSION = 1 as const;

const ROUTES = new Map<string, string>([
  ["/", "product_landing"],
  ["/skills", "skills"],
  ["/docs", "docs"],
  ["/docs/evaluations", "evaluations"],
  ["/docs/evaluations-history", "evaluations_history"],
  ["/compare", "compare"],
  ["/introducing-sys1", "launch_article"],
]);

export const ALLOWED_EVENTS = new Set(["$pageview", "$pageleave", "cta clicked", "install command copied"]);
const CUSTOM_PROPERTIES = new Set(["cta_id", "command_id"]);
// PostHog's own technical properties that carry no page content or identity.
const PASSTHROUGH_PROPERTIES = new Set([
  "token", "distinct_id", "$lib", "$lib_version", "$browser", "$browser_version", "$os", "$os_version",
  "$device_type", "$screen_height", "$screen_width", "$viewport_height", "$viewport_width", "$insert_id",
  "$time", "$timezone", "$timezone_offset", "$session_id", "$window_id", "$pageview_id", "$prev_pageview_id",
  "$prev_pageview_duration", "$prev_pageview_max_scroll_percentage", "$prev_pageview_max_content_percentage",
  "$prev_pageview_last_scroll_percentage", "$prev_pageview_last_content_percentage", "$is_identified",
  "$process_person_profile", "$cookieless_mode", "$raw_user_agent", "$lib_custom_api_host", "$configured_session_timeout_ms",
]);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,47}$/u;

export type Capture = Readonly<{
  event: string;
  properties?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}>;

export function canonicalPath(pathname: string): string {
  const path = (pathname.split(/[?#]/u, 1)[0] ?? "/").replace(/\/{2,}/gu, "/").replace(/\.html$/u, "").replace(/\/index$/u, "/");
  const trimmed = path.length > 1 ? path.replace(/\/+$/u, "") : "/";
  return ROUTES.has(trimmed) ? trimmed : "/not-found";
}

export function pageKind(path: string): string {
  return ROUTES.get(path) ?? "not_found";
}

/** Keep only the referring site's origin, never its path or query. */
export function referrerOrigin(referrer: unknown): string {
  if (typeof referrer !== "string" || referrer === "" || referrer === "$direct") return "$direct";
  try {
    const url = new URL(referrer);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "$direct";
  } catch {
    return "$direct";
  }
}

/**
 * The before_send hook: drop anything outside the allowlist, then rebuild the
 * properties from scratch so URLs carry no query string or fragment.
 */
export function sanitizeCapture(capture: Capture | null, location: { pathname: string }, referrer: string): Capture | null {
  if (capture === null || !ALLOWED_EVENTS.has(capture.event)) return null;
  const source = capture.properties ?? {};
  const path = canonicalPath(location.pathname);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (PASSTHROUGH_PROPERTIES.has(key) && (typeof value !== "object" || value === null)) properties[key] = value;
    else if (CUSTOM_PROPERTIES.has(key) && typeof value === "string" && IDENTIFIER.test(value)) properties[key] = value;
  }
  const origin = referrerOrigin(source.$referrer ?? referrer);
  Object.assign(properties, {
    $current_url: `${CANONICAL_ORIGIN}${path}`,
    $host: CANONICAL_DOMAIN,
    $pathname: path,
    $referrer: origin,
    $referring_domain: origin === "$direct" ? "$direct" : new URL(origin).hostname,
    $process_person_profile: false,
    analytics_schema_version: SCHEMA_VERSION,
    canonical_domain: CANONICAL_DOMAIN,
    canonical_path: path,
    page_kind: pageKind(path),
    site_id: SITE_ID,
  });
  return { ...capture, properties, $set: undefined, $set_once: undefined };
}

export function shouldLoad(location: { protocol: string; hostname: string }, navigatorValue: { doNotTrack?: string | null; globalPrivacyControl?: boolean }): boolean {
  return location.protocol === "https:"
    && location.hostname === CANONICAL_DOMAIN
    && navigatorValue.doNotTrack !== "1"
    && navigatorValue.globalPrivacyControl !== true;
}

/** An identifier from a data attribute, or undefined when it is not a short slug. */
export function analyticsIdentifier(value: string | undefined): string | undefined {
  return value !== undefined && IDENTIFIER.test(value) ? value : undefined;
}

export function posthogConfig(before_send: (capture: Capture | null) => Capture | null) {
  return {
    api_host: POSTHOG_API_HOST,
    ui_host: "https://us.posthog.com",
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
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
    mask_personal_data_properties: true,
    rate_limiting: { events_per_second: 2, events_burst_limit: 12 },
    before_send,
  } as const;
}
