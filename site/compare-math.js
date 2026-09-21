// Cost assumptions are explicit inputs. Missing machine prices never mean zero.
export const JEV_INPUT_RATE = 0.042;
export const LOCAL_ROUTES = ["qwen06", "qwen17", "qwen35", "openjev"];

export function boundedNumber(value, max, integer = false) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max && (!integer || Number.isInteger(number)) ? number : null;
}

export function estimateCost(values) {
  const requests = boundedNumber(values.requests, 1e12, true);
  if (requests === null) return { error: "Enter a whole request count from 0 to 1 trillion." };
  if (LOCAL_ROUTES.includes(values.model)) {
    const hourly = boundedNumber(values.hourly, 1e6);
    const hours = boundedNumber(values.hours, 744);
    if (hourly === null || hours === null) return { error: "Enter your hourly machine cost and 0–744 allocated hours." };
    const monthly = hourly * hours;
    return { monthly, perThousand: requests > 0 ? monthly / requests * 1000 : null, requests, kind: "machine", hourly, hours };
  }
  if (values.model !== "jev" && values.model !== "custom") return { error: "Choose a supported cost model." };
  const inputTokens = boundedNumber(values.inputTokens, 1e9, true);
  const inputRate = values.model === "jev" ? JEV_INPUT_RATE : boundedNumber(values.inputRate, 1e6);
  const outputTokens = values.model === "jev" ? 0 : boundedNumber(values.outputTokens, 1e9, true);
  const outputRate = values.model === "jev" ? 0 : boundedNumber(values.outputRate, 1e6);
  if ([inputTokens, inputRate, outputTokens, outputRate].some(value => value === null)) return { error: "Enter non-negative token counts and rates within the field limits." };
  const perRequest = (inputTokens * inputRate + outputTokens * outputRate) / 1e6;
  return { monthly: requests * perRequest, perThousand: perRequest * 1000, requests, kind: "tokens", inputTokens, inputRate, outputTokens, outputRate };
}
