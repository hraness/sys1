import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { estimateCost, LOCAL_ROUTES } from "../site/compare-math.js";

const hosted = { model: "jev", requests: "100000", inputTokens: "1000" };
const custom = {
  model: "custom", requests: "100000", inputTokens: "1000", inputRate: "0.25",
  outputTokens: "200", outputRate: "2",
};

describe("comparison cost planner", () => {
  test("prices the published Jev example using input tokens only", () => {
    const result = estimateCost({ ...hosted, outputTokens: "99999", outputRate: "999" });
    expect(result.monthly).toBeCloseTo(4.2, 10);
    expect(result.perThousand).toBeCloseTo(0.042, 10);
    expect(result.outputTokens).toBe(0);
    expect(result.outputRate).toBe(0);
  });

  test("includes separately priced custom output tokens", () => {
    const result = estimateCost(custom);
    // 100 million input tokens at $0.25 + 20 million output tokens at $2.
    expect(result.monthly).toBeCloseTo(65, 10);
    expect(result.perThousand).toBeCloseTo(0.65, 10);
    expect(estimateCost({ ...custom, outputRate: "0" }).monthly).toBeCloseTo(25, 10);
  });

  test("does not silently turn blank or invalid request counts into zero", () => {
    for (const requests of ["", " ", null, undefined, "abc", "NaN", "Infinity", "-1", "0.5", "1000000000001"]) {
      expect(estimateCost({ ...hosted, requests }).error, `request count ${String(requests)}`).toBeString();
    }
    expect(estimateCost({ ...hosted, requests: "1000000000000" }).error).toBeUndefined();
  });

  test("zero requests and zero token counts are deliberate valid inputs", () => {
    expect(estimateCost({ ...hosted, requests: "0" }).monthly).toBe(0);
    expect(estimateCost({ ...hosted, inputTokens: "0" }).monthly).toBe(0);
    expect(estimateCost({ ...custom, inputTokens: "0", outputTokens: "0" }).monthly).toBe(0);
  });

  test("requires valid whole token counts and explicit custom rates", () => {
    for (const field of ["inputTokens", "outputTokens"]) {
      for (const value of ["", "-1", "1.5", "1000000001", "Infinity"]) {
        expect(estimateCost({ ...custom, [field]: value }).error, `${field}=${value}`).toBeString();
      }
    }
    for (const field of ["inputRate", "outputRate"]) {
      for (const value of ["", " ", "-0.01", "1000001", "NaN"]) {
        expect(estimateCost({ ...custom, [field]: value }).error, `${field}=${value}`).toBeString();
      }
    }
    expect(estimateCost({ ...custom, inputRate: "0", outputRate: "0" }).monthly).toBe(0);
  });

  test.each(LOCAL_ROUTES)("%s stays unpriced until machine assumptions are supplied", (model) => {
    expect(estimateCost({ model, requests: "100000", hourly: "", hours: "744" }).error).toBeString();
    expect(estimateCost({ model, requests: "100000", hourly: "0.25", hours: "" }).error).toBeString();
    expect(estimateCost({ model, requests: "100000", hourly: "0", hours: "744" }).monthly).toBe(0);
  });

  test("local volume affects unit cost without inventing machine capacity or changing the bill", () => {
    const machine = { model: "openjev", hourly: "0.5", hours: "200" };
    expect(estimateCost({ ...machine, requests: "10000" })).toMatchObject({ monthly: 100, perThousand: 10 });
    expect(estimateCost({ ...machine, requests: "100000" })).toMatchObject({ monthly: 100, perThousand: 1 });
    expect(estimateCost({ ...machine, requests: "0" })).toMatchObject({ monthly: 100, perThousand: null });
  });

  test("local allocated hours are bounded by a 31-day month", () => {
    const machine = { model: "qwen17", requests: "100000", hourly: "0.25" };
    expect(estimateCost({ ...machine, hours: "744" }).monthly).toBe(186);
    expect(estimateCost({ ...machine, hours: "0" }).monthly).toBe(0);
    expect(estimateCost({ ...machine, hours: "1.5" }).monthly).toBe(0.375);
    for (const hours of ["744.01", "-1", "Infinity"]) {
      expect(estimateCost({ ...machine, hours }).error).toBeString();
    }
    expect(estimateCost({ ...machine, hours: "10", hourly: "-1" }).error).toBeString();
  });

  test("unknown models do not inherit a price", () => {
    expect(estimateCost({ ...hosted, model: "unknown" }).error).toBeString();
  });
});

const comparison = readFileSync(new URL("../site/compare.html", import.meta.url), "utf8");

async function select(html, selector) {
  const elements = [];
  await new HTMLRewriter().on(selector, {
    element(element) { elements.push(Object.fromEntries(element.attributes)); },
  }).transform(new Response(html)).text();
  return elements;
}

// Minimal independently copied JevBench v1.2.6 data, not read from the page under test.
// Source: https://github.com/fstandhartinger/jevbench/blob/275763201a29d6083d4ee1431d709c296ef81281/results/v1.2/jevbench-v1.2-results.json
// Keeping the selected fields here makes this regression test offline and portable.
const SOURCE_REVISION = "275763201a29d6083d4ee1431d709c296ef81281";
const pinned = [
  {
    key: "jev-1.13.0", hard: 0.740909090909091, correct: 163,
    intelligence: 90.4013594852636, calibration: 82.6528888888889, composite: 75.40638246358375,
  },
  {
    key: "openjev-razorback16", hard: 0.6545454545454545, correct: 144,
    intelligence: 85.97654628476548, calibration: 64.76011611808524, composite: 67.74973515791666,
  },
];

describe("comparison evidence contract", () => {
  test("only scored supported routes use exact pinned data, with hard accuracy separate from the composite", async () => {
    const rows = await select(comparison, ".benchmark-row");
    expect(rows.map(row => row["data-key"])).toEqual(pinned.map(row => row.key));
    for (const [index, reference] of pinned.entries()) {
      const row = rows[index];
      expect(Number(row["data-accuracy"])).toBe(reference.hard * 100);
      expect(Number(row["data-correct"])).toBe(reference.correct);
      expect(reference.hard * 220).toBeCloseTo(reference.correct, 10);
      for (const metric of ["intelligence", "calibration", "composite"]) {
        expect(Number(row[`data-${metric}`])).toBe(reference[metric]);
      }
    }
    const bars = await select(comparison, ".benchmark-row .bar-value");
    expect(bars.map(bar => Number(bar.width))).toEqual(pinned.map(row => row.hard * 100));
    expect(comparison).toContain("163 / 220 correct");
    expect(comparison).toContain("144 / 220 correct");
    expect(comparison).toContain(`/${SOURCE_REVISION}/results/v1.2/jevbench-v1.2-results.json`);
  });

  test("Qwen is visibly unscored and external scores do not imply runs through Sys1 or Apple MLX", () => {
    expect(comparison).toContain("No matching JevBench result for Sys1’s GGUF adapter");
    expect(comparison).toContain("not runs through Sys1");
    expect(comparison).toContain("does not measure its Apple MLX backend");
  });

  test("legacy case leaderboards live in linked documentation instead of the comparison", async () => {
    expect(comparison).not.toMatch(/forms-v1|decisions-v[23]/);
    expect(await select(comparison, "table.results-table")).toEqual([]);
    const hrefs = (await select(comparison, "a[href]")).map(link => link.href);
    for (const path of ["/docs/evaluations", "/docs/evaluations-history", "/docs/evaluations#jevbench"]) {
      expect(hrefs).toContain(path);
      const [route, fragment] = path.split("#");
      const page = readFileSync(new URL(`../site${route}.html`, import.meta.url), "utf8");
      if (fragment) expect(await select(page, `[id="${fragment}"]`)).toHaveLength(1);
    }
    const evaluations = readFileSync(new URL("../site/docs/evaluations.html", import.meta.url), "utf8");
    expect(evaluations).toContain("forms-v1");
    expect(evaluations).toContain("decisions-v3");
  });

  test("the calculator exposes every priced route without pre-filling a free machine", async () => {
    const options = await select(comparison, "#cost-model option");
    expect(options.map(option => option.value).sort()).toEqual(["jev", "custom", ...LOCAL_ROUTES].sort());
    const machineFields = await select(comparison, "#hourly-cost, #machine-hours");
    expect(machineFields).toHaveLength(2);
    for (const input of machineFields) expect(input.value ?? "").toBe("");
    const requests = (await select(comparison, "#requests"))[0];
    const tokens = (await select(comparison, "#input-tokens"))[0];
    expect(estimateCost({ model: "jev", requests: requests.value, inputTokens: tokens.value }).monthly).toBeCloseTo(4.2, 10);
    expect(comparison).toContain("$4.20<span>per month</span>");
  });
});
