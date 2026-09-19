import { describe, expect, test } from "bun:test";
import { chooseBackend, type BackendCandidate } from "../src/router.ts";

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
