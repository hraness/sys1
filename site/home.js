// An illustrative, offline explanation of the three question forms.
// These values are authored examples, not inference or benchmark results.
const examples = {
  noul: {
    question: "Is a missing configuration file causing the failure?",
    answer: '"noul": 0.94',
    detail: "A probability for the condition you described.",
  },
  choice: {
    question: "Which category fits: configuration, code, or network?",
    answer: '"choice": "configuration"',
    detail: "One of your named options, with probabilities in the full response.",
  },
  score: {
    question: "How much evidence is present, from absent (0) to direct (2)?",
    answer: '"score": 1.8',
    detail: "A score over the ordered criteria you supplied.",
  },
};
const demo = document.querySelector("[data-decision-demo]");
if (demo) {
  const controls = demo.querySelectorAll("[data-question-type]");
  for (const control of controls) {
    control.addEventListener("click", () => {
      const example = examples[control.dataset.questionType];
      if (!example) return;
      for (const button of controls) button.setAttribute("aria-pressed", String(button === control));
      demo.querySelector("[data-demo-question]").textContent = example.question;
      demo.querySelector("[data-demo-answer]").textContent = example.answer;
      demo.querySelector("[data-demo-detail]").textContent = example.detail;
    });
  }
}
