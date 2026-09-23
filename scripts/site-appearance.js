// Bundled from the pinned shared browser export by build-site-appearance.ts.
import { attachFoil, installAppearanceMenus } from "@hraness/design-kit/browser";

document.documentElement.classList.add("has-js");
attachFoil(document.documentElement);
installAppearanceMenus({
  storageKey: "sys1-appearance",
  lightThemeColor: "#f8f7f4",
  darkThemeColor: "#12100f",
});
