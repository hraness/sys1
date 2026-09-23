// Bundled from the pinned shared browser export by build-site-appearance.ts.
import { attachFoil, attachHeroLight, installAppearanceMenus } from "@hraness/design-kit/browser";

document.documentElement.classList.add("has-js");
attachFoil(document.documentElement);
installAppearanceMenus({
  storageKey: "sys1-appearance",
  lightThemeColor: "#e1e2e7",
  darkThemeColor: "#1a1b26",
});

const enhanceHeroes = () => document.querySelectorAll("[data-hraness-hero]").forEach(attachHeroLight);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhanceHeroes, { once: true });
else enhanceHeroes();
