const examples = {
  choice: {
    question: "What should the agent do next?",
    state: "The build failed after a dependency update.",
    options: ["repair", "continue"],
    answer: { type: "choice", choice: "repair", probabilities: { repair: 0.94, continue: 0.06 }, confidence: 0.88 },
  },
  noul: {
    question: "Is this a visual change?",
    state: "The diff changes a CSS color. No runtime code changed.",
    options: ["yes", "no"],
    answer: { type: "noul", noul: 0.97 },
  },
  score: {
    question: "How complete is the release note?",
    state: "The note explains the change but omits migration steps.",
    options: ["0 · Missing", "1 · Partial", "2 · Complete"],
    answer: { type: "score", score: 1.15, legend: { 0: "Missing", 1: "Partial", 2: "Complete" }, probabilities: { 0: 0.1, 1: 0.65, 2: 0.25 }, confidence: 0.475 },
  },
};

for (const button of document.querySelectorAll("[data-example]")) {
  button.addEventListener("click", () => {
    const example = examples[button.dataset.example];
    if (!example) return;
    document.querySelectorAll("[data-example]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    document.getElementById("example-question").textContent = example.question;
    document.getElementById("example-state").textContent = `“${example.state}”`;
    document.getElementById("example-answer").textContent = JSON.stringify(example.answer, null, 2);
    document.getElementById("example-type").textContent = example.answer.type;
    document.getElementById("example-options").replaceChildren(...example.options.map((label) => {
      const option = document.createElement("span");
      option.textContent = label;
      return option;
    }));
  });
}

const appearance = document.getElementById("appearance");
const systemAppearance = matchMedia("(prefers-color-scheme: dark)");
function updateThemeColor() {
  const mode = document.documentElement.dataset.theme;
  const dark = mode === "dark" || (mode !== "light" && systemAppearance.matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#12100f" : "#f8f7f4";
}
appearance.value = document.documentElement.dataset.theme || "system";
appearance.addEventListener("change", () => {
  const mode = appearance.value;
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("sys1-appearance", mode); } catch { /* Appearance still works for this visit. */ }
  updateThemeColor();
});
systemAppearance.addEventListener("change", updateThemeColor);
updateThemeColor();

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const status = document.getElementById("copy-status");
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
      status.textContent = "Commands copied. Paste them into your terminal.";
    } catch {
      status.textContent = "Copy is unavailable here. Select and copy the commands above.";
    }
  });
}
