for (const button of document.querySelectorAll("[data-copy]")) {
  const label = button.textContent;
  let reset;
  button.addEventListener("click", async () => {
    const status = document.getElementById(button.dataset.copyStatus ?? "copy-status");
    const subject = button.dataset.copySubject;
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
      status.textContent = subject ? `Copied the ${subject}.` : "Commands copied. Paste them into your terminal.";
      button.textContent = "Copied";
      clearTimeout(reset);
      reset = setTimeout(() => { button.textContent = label; }, 2000);
    } catch {
      status.textContent = subject ? "Copy is unavailable here. Select and copy the command above." : "Copy is unavailable here. Select and copy the commands above.";
    }
  });
}

// Install tabs follow the ARIA tab pattern and open on the visitor's system.
function detectPlatform() {
  const hint = String(navigator.userAgentData?.platform ?? "").toLowerCase();
  const agent = navigator.userAgent ?? "";
  if (hint === "windows" || /Windows/u.test(agent)) return "windows";
  if (hint === "macos" || (/Macintosh|Mac OS X/u.test(agent) && !/iPhone|iPad/u.test(agent))) return "macos";
  if (hint === "linux" || (/Linux|X11/u.test(agent) && !/Android|CrOS/u.test(agent))) return "linux";
  return null;
}
for (const block of document.querySelectorAll("[data-platform-install]")) {
  const tabs = [...block.querySelectorAll('[role="tab"]')];
  const select = (tab, focus) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")).hidden = !selected;
    }
    if (focus) tab.focus();
  };
  const detected = tabs.find((tab) => tab.dataset.platform === detectPlatform());
  select(detected ?? tabs[0], false);
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[(next + tabs.length) % tabs.length], true);
    });
  }
}
