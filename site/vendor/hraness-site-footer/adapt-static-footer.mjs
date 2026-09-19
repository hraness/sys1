/**
 * Sys1-owned adapter for the pinned v0.15.0 static renderer. That renderer
 * unconditionally includes a hidden consent subtree and has no opt-out.
 * Sys1 configures no consent runtime, so omit its inactive action and copy.
 */
export function adaptStaticFooter(html) {
  const consent = /<div class="hraness-site-footer__consent [^"]*" data-slot="hraness-cookie-consent" hidden="">[\s\S]*?<\/details><\/div>/g;
  const matches = [...html.matchAll(consent)];
  if (matches.length !== 1 || matches[0][0].includes("<nav")) {
    throw new Error("Pinned footer consent structure changed");
  }
  const adapted = html.replace(consent, "");
  if (/<(?:form|script|button)\b/i.test(adapted) || /hraness-cookie-consent|Accept cookies/.test(adapted)) {
    throw new Error("Unexpected active static footer content");
  }
  return adapted;
}
