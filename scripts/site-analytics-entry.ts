// Browser entry for site/analytics.js. Built by scripts/build-site-analytics.ts;
// the deployed site never loads a remote script.
import posthog from "posthog-js/dist/module.slim.no-external";
import { analyticsIdentifier, POSTHOG_PROJECT_TOKEN, posthogConfig, sanitizeCapture, shouldLoad, type Capture } from "./site-analytics";

if (shouldLoad(window.location, navigator as Navigator & { globalPrivacyControl?: boolean })) {
  const referrer = document.referrer;
  posthog.init(POSTHOG_PROJECT_TOKEN, posthogConfig((capture: Capture | null) => sanitizeCapture(capture, window.location, referrer)) as never);
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-analytics-cta], [data-copy]") : null;
    if (target === null) return;
    const command = analyticsIdentifier(target.dataset.copy);
    if (command !== undefined) {
      posthog.capture("install command copied", { command_id: command }, { transport: "sendBeacon" });
      return;
    }
    const cta = analyticsIdentifier(target.dataset.analyticsCta);
    if (cta !== undefined) posthog.capture("cta clicked", { cta_id: cta }, { transport: "sendBeacon" });
  }, { capture: true, passive: true });
}
