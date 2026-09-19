(() => {
  document.documentElement.classList.add("has-js");
  try {
    const saved = localStorage.getItem("sys1-appearance");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch { /* The system appearance remains available without storage. */ }
})();
