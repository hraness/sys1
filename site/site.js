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
