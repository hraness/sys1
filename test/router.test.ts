import { describe, expect, test } from "bun:test";
import {
  chooseBackend,
  requestNeeds,
  type BackendCandidate,
} from "../src/router.ts";

const hosted: BackendCandidate = {
  name: "typesafe",
  kind: "hosted",
  available: true,
  models: ["jev-latest", "jev-1.13.0"],
  size_b: null,
  cost_rank: 0,
};

const localSmall: BackendCandidate = {
  name: "nanojev",
  kind: "local",
  available: true,
  models: ["nanojev-0.6b"],
  size_b: 0.6,
  cost_rank: 0,
};

const localBig: BackendCandidate = {
  name: "openjev",
  kind: "local",
  available: true,
  models: ["openjev-4b"],
  size_b: 4,
  cost_rank: 0,
};

describe("chooseBackend policy order", () => {
  test("auto prefers reachable hosted", () => {
    const choice = chooseBackend("auto", undefined, [localSmall, hosted]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "typesafe" } });
  });

  test("auto falls back to cheapest smallest local when hosted is down", () => {
    const down = { ...hosted, available: false };
    const choice = chooseBackend("auto", undefined, [localBig, down, localSmall]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "nanojev" } });
  });

  test("prefer-local picks smallest local even when hosted is up", () => {
    const choice = chooseBackend("prefer-local", undefined, [hosted, localBig, localSmall]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "nanojev" } });
  });

  test("prefer-local falls back to hosted when no local is up", () => {
    const choice = chooseBackend("prefer-local", undefined, [
      hosted,
      { ...localSmall, available: false },
    ]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "typesafe" } });
  });

  test("local-only never picks hosted", () => {
    const choice = chooseBackend("local-only", undefined, [
      hosted,
      { ...localSmall, available: false },
    ]);
    expect(choice).toMatchObject({ ok: false, reason: "no_backend_available" });
  });

  test("hosted-only never picks local", () => {
    const choice = chooseBackend("hosted-only", undefined, [
      { ...hosted, available: false },
      localSmall,
    ]);
    expect(choice).toMatchObject({ ok: false, reason: "no_backend_available" });
  });

  test("nothing reachable reports no_backend_available", () => {
    const choice = chooseBackend("auto", undefined, [
      { ...hosted, available: false },
      { ...localSmall, available: false },
    ]);
    expect(choice).toMatchObject({ ok: false, reason: "no_backend_available" });
  });
});

describe("chooseBackend model routing", () => {
  const all = [hosted, localSmall, localBig];

  test("bare model picks its backend", () => {
    const choice = chooseBackend("auto", "openjev-4b", all);
    expect(choice).toMatchObject({ ok: true, backend: { name: "openjev" } });
  });

  test("auto is treated as no model", () => {
    const choice = chooseBackend("prefer-local", "auto", all);
    expect(choice).toMatchObject({ ok: true, backend: { name: "nanojev" } });
  });

  test("backend/model pins an exact backend", () => {
    const choice = chooseBackend("auto", "openjev/openjev-4b", all);
    expect(choice).toMatchObject({ ok: true, backend: { name: "openjev" }, reason: "pinned" });
  });

  test("an exact pin cannot override a local-only or hosted-only policy", () => {
    expect(chooseBackend("local-only", "typesafe/jev-latest", all)).toMatchObject({
      ok: false, reason: "policy_restricted",
    });
    expect(chooseBackend("hosted-only", "openjev/openjev-4b", all)).toMatchObject({
      ok: false, reason: "policy_restricted",
    });
  });

  test("a bare model excluded by policy reports policy_restricted", () => {
    expect(chooseBackend("local-only", "jev-latest", all)).toMatchObject({
      ok: false, reason: "policy_restricted",
    });
  });

  test("pinned backend that is down reports model_unavailable", () => {
    const choice = chooseBackend("auto", "openjev/openjev-4b", [
      hosted,
      { ...localBig, available: false },
    ]);
    expect(choice).toMatchObject({ ok: false, reason: "model_unavailable" });
  });

  test("unknown model reports unknown_model", () => {
    const choice = chooseBackend("auto", "gpt-9", all);
    expect(choice).toMatchObject({ ok: false, reason: "unknown_model" });
  });

  test("known but unreachable model reports model_unavailable", () => {
    const choice = chooseBackend("auto", "openjev-4b", [
      hosted,
      { ...localBig, available: false },
    ]);
    expect(choice).toMatchObject({ ok: false, reason: "model_unavailable" });
  });
});

describe("capability-aware routing", () => {
  const capped: BackendCandidate = {
    name: "capped-service",
    kind: "local",
    available: true,
    models: ["capped-model"],
    size_b: 9,
    cost_rank: 1,
    capabilities: { maxOptions: 26, maxQuestions: 64 },
  };

  const needsWide = { maxOptions: 40, questions: 2 };
  const needsFit = { maxOptions: 20, questions: 2 };

  test("a request over a published cap skips that backend", () => {
    const choice = chooseBackend("prefer-local", undefined, [capped, localSmall], needsWide);
    expect(choice).toMatchObject({ ok: true, backend: { name: "nanojev" } });
  });

  test("a fitting request still uses the capped backend", () => {
    const choice = chooseBackend("prefer-local", "capped-model", [capped, localSmall], needsFit);
    expect(choice).toMatchObject({ ok: true, backend: { name: "capped-service" } });
  });

  test("pinning a backend past its cap reports request_unsupported", () => {
    const choice = chooseBackend("auto", "capped-service/capped-model", [capped], needsWide);
    expect(choice).toMatchObject({ ok: false, reason: "request_unsupported" });
  });

  test("a bare model over every server's cap reports request_unsupported", () => {
    const choice = chooseBackend("auto", "capped-model", [hosted, capped], needsWide);
    expect(choice).toMatchObject({ ok: false, reason: "request_unsupported" });
  });

  test("missing caps mean unbounded", () => {
    const choice = chooseBackend("auto", "capped-model", [localSmall], needsWide);
    expect(choice).toMatchObject({ ok: false, reason: "unknown_model" });
    const { capabilities: _dropped, ...uncapped } = capped;
    const unlimited = chooseBackend("prefer-local", "capped-model", [uncapped]);
    expect(unlimited).toMatchObject({ ok: true, backend: { name: "capped-service" } });
  });
});

describe("explicit model routing", () => {
  const explicitOnly: BackendCandidate = {
    name: "local-qwen3-0.6b",
    kind: "local",
    available: true,
    models: ["qwen3-0.6b"],
    size_b: 0.6,
    cost_rank: 0,
    explicitOnly: true,
    capabilities: { maxOptions: 26 },
  };

  test("unpinned requests never fall back to an unselected model", () => {
    const choice = chooseBackend("prefer-local", undefined, [explicitOnly, localBig]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "openjev" } });
  });

  test("an unselected model is still reachable by bare model name", () => {
    const choice = chooseBackend("prefer-local", "qwen3-0.6b", [explicitOnly, localBig]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "local-qwen3-0.6b" } });
  });

  test("an unselected model is reachable by backend/model pin", () => {
    const choice = chooseBackend("auto", "local-qwen3-0.6b/qwen3-0.6b", [hosted, explicitOnly]);
    expect(choice).toMatchObject({
      ok: true,
      backend: { name: "local-qwen3-0.6b" },
      reason: "pinned",
    });
  });

  test("an unselected model alone leaves unpinned requests with no backend", () => {
    const choice = chooseBackend("local-only", undefined, [explicitOnly]);
    expect(choice).toMatchObject({ ok: false, reason: "no_backend_available" });
  });
});

describe("requestNeeds", () => {
  test("summarizes the largest criteria count and question count", () => {
    const needs = requestNeeds({
      state: "s",
      questions: {
        a: { type: "noul" },
        b: { type: "choice", criteria: { x: null, y: null, z: null } },
        c: { type: "score", criteria: ["l1", "l2", "l3", "l4"] },
      },
    });
    expect(needs).toEqual({ maxOptions: 4, questions: 3 });
  });
});
