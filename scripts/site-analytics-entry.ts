// Browser entry for site/analytics.js. Built by scripts/build-site-analytics.ts;
// the deployed site never loads a remote script.
import posthog from "posthog-js/dist/module.slim.no-external";
import { getBrowserConsent } from "@hraness/posthog/consent";
import { initHranessCookieConsent } from "@hraness/site-footer/consent";
// Registers the web-vitals library on window.__PosthogExtensions__ locally.
import "posthog-js/dist/web-vitals.js";
import {
  acceptWebVital,
  ctaEvent,
  errorFingerprint,
  ExceptionBudget,
  exceptionProperties,
  installEvent,
  notFoundEvent,
  POSTHOG_PROJECT_TOKEN,
  posthogConfig,
  sanitizeCapture,
  sanitizeError,
  shouldLoad,
  WEB_VITALS_FLUSH_MS,
  WEB_VITALS_METRICS,
  webVitalsProperties,
  type Capture,
  type WebVitalMetric,
} from "./site-analytics";

type VitalsCallbacks = Record<"onLCP" | "onCLS" | "onFCP" | "onINP", (report: (metric: WebVitalMetric) => void) => void>;

initHranessCookieConsent();
const consent = getBrowserConsent();

function startAnalytics(): void {
  const referrer = document.referrer;
  posthog.init(POSTHOG_PROJECT_TOKEN, posthogConfig((capture: Capture | null) =>
    consent?.allowed() ? sanitizeCapture(capture, window.location, referrer) : null) as never);

  const notFound = notFoundEvent(window.location.pathname, referrer);
  if (notFound !== undefined) posthog.capture("page not found", notFound);

  document.addEventListener("click", (event) => {
    if (!consent?.allowed()) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-analytics-cta], [data-copy]") : null;
    if (target === null) return;
    const install = installEvent(target.dataset.copy);
    if (install !== undefined) {
      posthog.capture("install command copied", { ...install }, { transport: "sendBeacon" });
      return;
    }
    const cta = ctaEvent(target.dataset.analyticsCta);
    if (cta !== undefined) posthog.capture("cta clicked", { ...cta }, { transport: "sendBeacon" });
  }, { capture: true, passive: true });

  // Web vitals: buffer per page, flush when all four arrive, after 5 s, or on hide.
  const callbacks = (window as unknown as { __PosthogExtensions__?: { postHogWebVitalsCallbacks?: VitalsCallbacks } }).__PosthogExtensions__?.postHogWebVitalsCallbacks;
  if (callbacks !== undefined) {
    let buffer: (WebVitalMetric & { timestamp: number })[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (buffer.length === 0) return;
      const metrics = buffer;
      buffer = [];
      if (!consent?.allowed()) return;
      posthog.capture("$web_vitals", webVitalsProperties(metrics, window.location.href), { transport: "sendBeacon" });
    };
    const report = (metric: WebVitalMetric) => {
      if (!consent?.allowed()) return;
      if (!acceptWebVital(metric)) return;
      buffer = [...buffer.filter((item) => item.name !== metric.name), { ...metric, timestamp: Date.now() }];
      if (buffer.length === WEB_VITALS_METRICS.length) flush();
      else timer ??= setTimeout(flush, WEB_VITALS_FLUSH_MS);
    };
    for (const name of WEB_VITALS_METRICS) callbacks[`on${name}`](report);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    window.addEventListener("pagehide", flush);
  }

  // Exceptions: budgeted and scrubbed; capture_exceptions stays off.
  const budget = new ExceptionBudget();
  const reportError = (value: unknown, origin: "window_error" | "unhandled_rejection") => {
    if (!consent?.allowed()) return;
    const error = sanitizeError(value);
    const fingerprint = errorFingerprint(error);
    if (budget.allow(fingerprint)) posthog.capture("$exception", exceptionProperties(error, origin, fingerprint));
  };
  window.addEventListener("error", (event) => reportError(event.error, "window_error"));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason, "unhandled_rejection"));
}

if (shouldLoad(window.location, navigator as Navigator & { globalPrivacyControl?: boolean })) {
  let started = false;
  consent?.subscribe(() => {
    if (started || !consent?.allowed()) return;
    started = true;
    startAnalytics();
  });
}
