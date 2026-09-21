import { estimateCost, LOCAL_ROUTES } from "./compare-math.js";

const byId = (id) => document.getElementById(id);
const metric = byId("benchmark-metric");
const metrics = {
  accuracy: { caption: "Hard-tier accuracy · 220 decisions · higher is better", description: "Correct decisions on JevBench’s frozen hard tier: 111 public and 109 held-out items. This percentage is separate from its overall four-axis score." },
  intelligence: { caption: "Intelligence score · 534 decisions · higher is better", description: "A weighted quality score across the easy, standard, judge, and hard tiers. This is JevBench’s intelligence axis, not a simple percentage correct." },
  calibration: { caption: "Calibration score · hard-tier distributions · higher is better", description: "JevBench combines expected calibration error and probability-distribution fidelity on the hard tier. A higher score is better; it is not an accuracy percentage." },
  composite: { caption: "Overall JevBench score · four equal axes · higher is better", description: "The geometric mean of intelligence, calibration, speed, and cost (25% each). It includes estimated prices and an assumed self-hosted latency adjustment. This is not an accuracy percentage." },
};
metric.addEventListener("change", () => {
  const selected = metrics[metric.value];
  if (!selected) return;
  byId("chart-caption").textContent = selected.caption;
  byId("metric-description").textContent = selected.description;
  document.querySelectorAll(".benchmark-row").forEach(row => {
    const value = Number(row.dataset[metric.value]);
    row.querySelector(".bar-value").setAttribute("width", String(value));
    row.querySelector(".benchmark-value strong").textContent = `${value.toFixed(1)}${metric.value === "accuracy" ? "%" : ""}`;
    row.querySelector(".benchmark-value span").textContent = metric.value === "accuracy" ? `${row.dataset.correct} / 220 correct` : "score out of 100";
  });
});

const form = byId("cost-planner");
const model = byId("cost-model");
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const preciseMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
function amount(value) { return value > 0 && value < 0.01 ? "< $0.01" : money.format(value); }
function updateCost() {
  const local = LOCAL_ROUTES.includes(model.value);
  const custom = model.value === "custom";
  byId("token-fields").hidden = local;
  byId("token-fields").disabled = local;
  byId("machine-fields").hidden = !local;
  byId("machine-fields").disabled = !local;
  byId("custom-fields").hidden = !custom;
  byId("custom-fields").querySelectorAll("input").forEach(input => { input.disabled = !custom; });
  byId("model-cost-note").textContent = local
    ? "Local inference has no per-token API bill. Estimate the machine cost you allocate to this workload."
    : custom ? "Enter rates for a compatible service you operate or use. No provider price or integration is implied."
    : "Jev bills $0.042 per million input tokens. Output tokens are free.";
  byId("price-source").hidden = local || custom;
  byId("estimate-kind").textContent = local ? "Allocated machine cost" : custom ? "Estimated service cost" : "Estimated Jev input cost";
  byId("cost-note").textContent = local
    ? "An operating-budget estimate, not a speed or capacity prediction. Changing volume changes the unit cost, not the allocated machine bill."
    : "Usage arithmetic, not a quote. Excludes retries, taxes, and price changes.";
  const result = estimateCost({ model: model.value, requests: byId("requests").value, inputTokens: byId("input-tokens").value, inputRate: byId("input-rate").value, outputTokens: byId("output-tokens").value, outputRate: byId("output-rate").value, hourly: byId("hourly-cost").value, hours: byId("machine-hours").value });
  document.querySelectorAll("[data-volume]").forEach(button => { button.setAttribute("aria-pressed", String(Number(button.dataset.volume) === Number(byId("requests").value) && byId("requests").value !== "")); });
  const output = byId("estimated-cost");
  output.replaceChildren();
  if (result.error) {
    output.textContent = "Estimate needs inputs";
    byId("unit-cost").textContent = result.error;
    byId("cost-formula").textContent = "";
    return;
  }
  output.append(document.createTextNode(amount(result.monthly)));
  const period = document.createElement("span");
  period.textContent = "per month";
  output.append(period);
  byId("unit-cost").textContent = result.perThousand === null ? "No unit cost at zero requests" : `${result.perThousand > 0 && result.perThousand < 0.000001 ? "< $0.000001" : preciseMoney.format(result.perThousand)} per 1,000 requests`;
  byId("cost-formula").textContent = result.kind === "machine"
    ? `${number.format(result.hours)} hours × ${preciseMoney.format(result.hourly)} per hour`
    : `${number.format(result.requests)} requests × (${number.format(result.inputTokens)} input tokens × $${number.format(result.inputRate)}${custom ? ` + ${number.format(result.outputTokens)} output tokens × $${number.format(result.outputRate)}` : ""}) / million`;
}
form.addEventListener("submit", event => event.preventDefault());
form.addEventListener("input", updateCost);
form.addEventListener("change", updateCost);
document.querySelectorAll("[data-volume]").forEach(button => button.addEventListener("click", () => { byId("requests").value = button.dataset.volume; updateCost(); }));
updateCost();
