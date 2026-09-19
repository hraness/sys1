const requests = document.getElementById("requests");
const tokens = document.getElementById("input-tokens");
const cost = document.getElementById("estimated-cost");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
function updateCost() {
  if (!requests.validity.valid || !tokens.validity.valid || requests.value === "" || tokens.value === "") {
    cost.textContent = "Enter whole numbers within the field limits.";
    return;
  }
  const amount = requests.valueAsNumber * tokens.valueAsNumber * 0.042 / 1_000_000;
  cost.textContent = `${money.format(amount)} / month`;
}
requests.addEventListener("input", updateCost);
tokens.addEventListener("input", updateCost);
updateCost();
