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
  const nimble: BackendCandidate = {
    name: "nimble",
    kind: "local",
    available: true,
    models: ["nimble-latest"],
    size_b: 9,
    cost_rank: 1,
    capabilities: { maxOptions: 26, maxQuestions: 64 },
  };

  const needsWide = { maxOptions: 40, questions: 2 };
  const needsFit = { maxOptions: 20, questions: 2 };

  test("a request over a published cap skips that backend", () => {
    const choice = chooseBackend("prefer-local", undefined, [nimble, localSmall], needsWide);
    expect(choice).toMatchObject({ ok: true, backend: { name: "nanojev" } });
  });

  test("a fitting request still uses the capped backend", () => {
    const choice = chooseBackend("prefer-local", "nimble-latest", [nimble, localSmall], needsFit);
    expect(choice).toMatchObject({ ok: true, backend: { name: "nimble" } });
  });

  test("pinning a backend past its cap reports request_unsupported", () => {
    const choice = chooseBackend("auto", "nimble/nimble-latest", [nimble], needsWide);
    expect(choice).toMatchObject({ ok: false, reason: "request_unsupported" });
  });

  test("a bare model over every server's cap reports request_unsupported", () => {
    const choice = chooseBackend("auto", "nimble-latest", [hosted, nimble], needsWide);
    expect(choice).toMatchObject({ ok: false, reason: "request_unsupported" });
  });

  test("missing caps mean unbounded", () => {
    const choice = chooseBackend("auto", "nimble-latest", [localSmall], needsWide);
    expect(choice).toMatchObject({ ok: false, reason: "unknown_model" });
    const { capabilities: _dropped, ...uncapped } = nimble;
    const unlimited = chooseBackend("prefer-local", "nimble-latest", [uncapped]);
    expect(unlimited).toMatchObject({ ok: true, backend: { name: "nimble" } });
  });
});

describe("specialist routing", () => {
  const specialist: BackendCandidate = {
    name: "local-cua-s1-forms",
    kind: "local",
    available: true,
    models: ["cua-s1-forms"],
    size_b: 0.0007,
    cost_rank: 0,
    specialist: true,
    capabilities: { maxOptions: 26 },
  };

  test("unpinned requests never fall back to a specialist", () => {
    const choice = chooseBackend("prefer-local", undefined, [specialist, localBig]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "openjev" } });
  });

  test("a specialist is still reachable by bare model name", () => {
    const choice = chooseBackend("prefer-local", "cua-s1-forms", [specialist, localBig]);
    expect(choice).toMatchObject({ ok: true, backend: { name: "local-cua-s1-forms" } });
  });

  test("a specialist is reachable by backend/model pin", () => {
    const choice = chooseBackend("auto", "local-cua-s1-forms/cua-s1-forms", [hosted, specialist]);
    expect(choice).toMatchObject({
      ok: true,
      backend: { name: "local-cua-s1-forms" },
      reason: "pinned",
    });
  });

  test("a specialist alone leaves unpinned requests with no backend", () => {
    const choice = chooseBackend("local-only", undefined, [specialist]);
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
