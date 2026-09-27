import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, loadPacks, packRoots, Sys1PackError } from "../src/audit/pack.ts";
import {
  DEFAULT_TIERS,
  PACK_LIMITS,
  canonicalJson,
  packFileSchema,
  ruleRevision,
  ruleSchema,
  type Rule,
} from "../src/audit/schema.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "packs");
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sys1-packs-"));
  temporary.push(dir);
  return dir;
}

function writePack(root: string, name: string, yaml: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.yaml"), yaml);
  return dir;
}

function packYaml(name: string, rules: string): string {
  return `version: 1\npack: ${name}\nrevision: r1\ndescription: Test pack.\nrules:\n${rules}`;
}

const ENSURE_RULE = (id: string, extra = ""): string =>
  `  - id: ${id}\n    applies: { paths: ["**/*"] }\n    ensure: It holds.\n    breaks: It is broken.\n${extra}`;

async function packError(promise: Promise<unknown>): Promise<Sys1PackError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Sys1PackError) return error;
    throw error;
  }
  throw new Error("expected a Sys1PackError");
}

describe("rule pack loader", () => {
  test("merges built-in, user, and repository packs by rule id with provenance", async () => {
    const set = await loadPacks({
      builtinDir: join(FIXTURES, "builtin"),
      userDir: join(FIXTURES, "user"),
      repoDir: join(FIXTURES, "repo"),
    });
    expect(set.packs.map((pack) => [pack.layer, pack.name])).toEqual([["builtin", "core"], ["user", "extra"], ["repo", "local"]]);
    expect(set.rules.map((rule) => rule.id)).toEqual([
      "shared-rule", "builtin-only", "exposed", "injection", "defect-kind", "defect-severity", "user-only", "repo-only",
    ]);

    const shared = set.get("shared-rule");
    if (shared === undefined || shared.rule.type !== "noul" || !("ensure" in shared.rule)) throw new Error("missing shared-rule");
    expect(shared.rule.ensure).toBe("The repository wording holds.");
    expect(shared.pack.name).toBe("local");
    expect(shared.pack.layer).toBe("repo");
    expect(shared.overrides.map((override) => [override.layer, override.pack])).toEqual([["builtin", "core"], ["user", "extra"]]);
    expect(shared.revision).toBe(ruleRevision(shared.rule));
    expect(shared.overrides[0]?.revision).not.toBe(shared.revision);

    expect(set.get("user-only")?.pack.layer).toBe("user");
    expect(set.get("builtin-only")?.overrides).toEqual([]);
  });

  test("repository packs override user packs, which override built-in packs", async () => {
    const builtin = tempRoot();
    const user = tempRoot();
    const repo = tempRoot();
    const rule = (text: string): string =>
      `  - id: layered\n    applies: { paths: ["**/*"] }\n    ensure: ${text}\n    breaks: Not ${text}\n`;
    writePack(builtin, "base", packYaml("base", rule("builtin.")));
    writePack(user, "mine", packYaml("mine", rule("user.")));
    writePack(repo, "ours", packYaml("ours", rule("repo.")));
    const ensure = async (roots: Parameters<typeof loadPacks>[0]): Promise<string> => {
      const loaded = (await loadPacks(roots)).get("layered")?.rule;
      if (loaded === undefined || !("ensure" in loaded)) throw new Error("missing layered rule");
      return loaded.ensure;
    };
    expect(await ensure({ builtinDir: builtin })).toBe("builtin.");
    expect(await ensure({ builtinDir: builtin, userDir: user })).toBe("user.");
    expect(await ensure({ builtinDir: builtin, userDir: user, repoDir: repo })).toBe("repo.");
    expect(await ensure({ builtinDir: builtin, repoDir: repo })).toBe("repo.");
    // Load order is fixed by layer, not by argument order.
    expect(await ensure({ repoDir: repo, userDir: user, builtinDir: builtin })).toBe("repo.");
  });

  test("applies defaults for type, unit, tiers, and gate", async () => {
    const set = await loadPacks({ builtinDir: join(FIXTURES, "builtin") });
    const rule = set.get("builtin-only")?.rule;
    expect(rule).toMatchObject({ type: "noul", unit: "hunk", gate: false, tiers: DEFAULT_TIERS });
    expect(set.get("exposed")?.rule.gate).toBe(false);
  });

  test("missing roots are empty layers and plain files beside packs are ignored", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gitkeep"), "");
    writeFileSync(join(root, "README.md"), "notes");
    const set = await loadPacks({ builtinDir: root, userDir: join(root, "missing"), repoDir: undefined });
    expect(set.packs).toEqual([]);
    expect(set.rules).toEqual([]);
  });

  test("packRoots derives the user and repository directories", () => {
    expect(packRoots({ sys1Home: "/home/u/.sys1", repoRoot: "/work/repo", builtinDir: "/pkg/packs" })).toEqual({
      builtinDir: "/pkg/packs",
      userDir: join("/home/u/.sys1", "rules"),
      repoDir: join("/work/repo", ".sys1", "rules"),
    });
  });

  test("loaded packs and rules are frozen", async () => {
    const set = await loadPacks({ builtinDir: join(FIXTURES, "builtin") });
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.rules)).toBe(true);
    expect(Object.isFrozen(set.packs[0])).toBe(true);
    expect(Object.isFrozen(set.get("builtin-only")?.rule.applies.paths)).toBe(true);
  });

});

describe("rule pack validation", () => {
  test("exposes fixture locations without loading qualification records", async () => {
    const root = tempRoot();
    const dir = writePack(root, "plain", packYaml("plain", ENSURE_RULE("x")));
    // Legacy records cannot promote a rule or influence advisory loading.
    mkdirSync(join(dir, "admission"));
    writeFileSync(join(dir, "admission", "malformed.json"), "not valid JSON");
    const pack = await loadPack(dir, "repo");
    expect(pack.calibrationFile).toBe(join(dir, "fixtures", "calibration.jsonl"));
    expect(pack.heldoutFile).toBe(join(dir, "fixtures", "heldout.jsonl"));
    expect("admissions" in pack).toBe(false);
    expect("admissionDir" in pack).toBe(false);
  });

  test("rejects dependent rules, execution gates, and unsupported file units clearly", async () => {
    for (const [field, value] of [["when", "other"], ["gate", true], ["unit", "file"]] as const) {
      const root = tempRoot();
      const dir = writePack(root, "p", packYaml("p", ENSURE_RULE("x", `    ${field}: ${value}\n`)));
      const error = await packError(loadPack(dir, "repo"));
      expect(error.issues[0]?.path).toBe(`rules[0].${field}`);
      if (field === "when") expect(error.message).toContain("independent advisory questions");
    }
  });

  test("rejects a noul ensure without breaks", async () => {
    const root = tempRoot();
    const dir = writePack(root, "p", packYaml("p", `  - id: lonely\n    applies: { paths: ["**/*"] }\n    ensure: It holds.\n`));
    const error = await packError(loadPack(dir, "repo"));
    expect(error.issues).toEqual([{
      file: join(dir, "pack.yaml"),
      path: "rules[0].breaks",
      message: "a noul rule with ensure needs a breaks sentence naming what violates it",
    }]);
  });

  test("rejects duplicate rule ids within a pack", async () => {
    const root = tempRoot();
    const dir = writePack(root, "p", packYaml("p", ENSURE_RULE("twice") + ENSURE_RULE("twice")));
    const error = await packError(loadPack(dir, "repo"));
    expect(error.issues.map((issue) => [issue.path, issue.message])).toEqual([["rules[1].id", "duplicate rule id twice"]]);
  });

  test("rejects duplicate rule ids across packs in the same layer", async () => {
    const root = tempRoot();
    writePack(root, "a", packYaml("a", ENSURE_RULE("same")));
    writePack(root, "b", packYaml("b", ENSURE_RULE("same")));
    const error = await packError(loadPacks({ repoDir: root }));
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.message).toBe("rule id same is also defined by pack a in the same repo layer");
  });

  test("bounds the merged unique rule count across otherwise valid packs", async () => {
    const root = tempRoot();
    const rules = Array.from({ length: PACK_LIMITS.maxMergedRules }, (_, index) => ENSURE_RULE(`rule-${index}`)).join("");
    writePack(root, "a", packYaml("a", rules));
    writePack(root, "b", packYaml("b", ENSURE_RULE("one-too-many")));
    const error = await packError(loadPacks({ repoDir: root }));
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.message).toBe(`merged packs define more than ${PACK_LIMITS.maxMergedRules} unique rules`);
  });

  test("layer overrides do not consume additional merged rule slots", async () => {
    const builtin = tempRoot();
    const repo = tempRoot();
    const rules = Array.from({ length: PACK_LIMITS.maxMergedRules }, (_, index) => ENSURE_RULE(`rule-${index}`)).join("");
    writePack(builtin, "base", packYaml("base", rules));
    writePack(repo, "local", packYaml("local", rules));
    const set = await loadPacks({ builtinDir: builtin, repoDir: repo });
    expect(set.rules).toHaveLength(PACK_LIMITS.maxMergedRules);
    expect(set.rules.every(rule => rule.pack.layer === "repo" && rule.overrides.length === 1)).toBe(true);
  });

  test("rejects unknown fields on a rule", async () => {
    const root = tempRoot();
    const dir = writePack(root, "p", packYaml("p", ENSURE_RULE("typo", "    serverity: P1\n")));
    const error = await packError(loadPack(dir, "repo"));
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("rules[0]");
    expect(error.issues[0]?.message).toContain("serverity");
  });

  test("rejects unknown fields on the pack, applies, tiers, and source", async () => {
    const cases: [string, string][] = [
      [`version: 1\npack: p\nrevision: r1\ndescription: d\nowner: me\nrules:\n${ENSURE_RULE("x")}`, "owner"],
      [packYaml("p", `  - id: x\n    applies: { paths: ["**/*"], include: ["a"] }\n    ensure: a\n    breaks: b\n`), "include"],
      [packYaml("p", ENSURE_RULE("x", "    tiers: { high: 0.9, low: 0.1 }\n")), "low"],
      [packYaml("p", ENSURE_RULE("x", "    source: { kind: guide, column: 3 }\n")), "column"],
    ];
    for (const [yaml, field] of cases) {
      const root = tempRoot();
      const error = await packError(loadPack(writePack(root, "p", yaml), "repo"));
      expect(error.message).toContain(field);
    }
  });

  test("rejects mixing ensure with longhand fields", async () => {
    const root = tempRoot();
    const dir = writePack(root, "p", packYaml("p", ENSURE_RULE("mixed", "    ask: Also this?\n")));
    const error = await packError(loadPack(dir, "repo"));
    expect(error.message).toContain("ask");
  });

  test("rejects a pack whose name differs from its directory", async () => {
    const root = tempRoot();
    const dir = writePack(root, "folder", packYaml("other", ENSURE_RULE("x")));
    const error = await packError(loadPack(dir, "repo"));
    expect(error.issues[0]?.message).toBe("pack other must live in a directory named other, not folder");
  });

  test("rejects a missing pack.yaml, invalid YAML, and non-mapping documents", async () => {
    const root = tempRoot();
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect((await packError(loadPack(empty, "repo"))).issues[0]?.message).toBe("is missing");
    const broken = writePack(root, "broken", "rules: [\n");
    expect((await packError(loadPack(broken, "repo"))).issues[0]?.message).toBe("is not valid YAML");
    const listed = writePack(root, "listed", "- a\n- b\n");
    expect((await packError(loadPack(listed, "repo"))).issues.length).toBeGreaterThan(0);
    const multi = writePack(root, "multi", `${packYaml("multi", ENSURE_RULE("x"))}---\nversion: 1\n`);
    expect((await packError(loadPack(multi, "repo"))).issues.length).toBeGreaterThan(0);
  });

  test("rejects an oversized pack.yaml without reading past the bound", async () => {
    const root = tempRoot();
    const dir = writePack(root, "big", `# ${"x".repeat(PACK_LIMITS.maxPackFileBytes)}\n`);
    expect((await packError(loadPack(dir, "repo"))).issues[0]?.message).toBe(`exceeds ${PACK_LIMITS.maxPackFileBytes} bytes`);
  });

  test("rejects YAML alias expansion beyond the node budget", async () => {
    const root = tempRoot();
    const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level <= 8; level++) {
      const previous = `*a${level - 1}`;
      lines.push(`a${level}: &a${level} [${Array(10).fill(previous).join(", ")}]`);
    }
    const dir = writePack(root, "bomb", `${lines.join("\n")}\n`);
    expect((await packError(loadPack(dir, "repo"))).issues[0]?.message).toBe("document is too large or too deeply nested");
  });

  test.skipIf(process.platform === "win32")("rejects a symlinked pack.yaml", async () => {
    const root = tempRoot();
    const target = join(root, "elsewhere.yaml");
    writeFileSync(target, packYaml("linked", ENSURE_RULE("x")));
    const dir = join(root, "linked");
    mkdirSync(dir);
    symlinkSync(target, join(dir, "pack.yaml"));
    expect((await packError(loadPack(dir, "repo"))).issues[0]?.message).toBe("must be a regular file, not a symbolic link");
  });

  test("rejects criteria over the protocol byte limit and blank sentences", async () => {
    const root = tempRoot();
    const long = "é".repeat(513);
    const dir = writePack(root, "p", packYaml("p", `  - id: x\n    applies: { paths: ["**/*"] }\n    ensure: ${long}\n    breaks: "  "\n`));
    const error = await packError(loadPack(dir, "repo"));
    expect(error.issues.map((issue) => [issue.path, issue.message])).toEqual([
      ["rules[0].ensure", "must be at most 1024 bytes"],
      ["rules[0].breaks", "must not be empty"],
    ]);
  });

  test("rejects invalid ids, globs, and tiers", async () => {
    const cases: [string, string][] = [
      [packYaml("p", ENSURE_RULE("Not_Kebab")), "rules[0].id"],
      [packYaml("p", `  - id: x\n    applies: { paths: ["/etc/**"] }\n    ensure: a\n    breaks: b\n`), "rules[0].applies.paths[0]"],
      [packYaml("p", `  - id: x\n    applies: { paths: ["../**"] }\n    ensure: a\n    breaks: b\n`), "rules[0].applies.paths[0]"],
      [packYaml("p", `  - id: x\n    applies: { paths: [] }\n    ensure: a\n    breaks: b\n`), "rules[0].applies.paths"],
      [packYaml("p", ENSURE_RULE("x", "    tiers: { high: 0.5, medium: 0.7 }\n")), "rules[0].tiers"],
      [packYaml("p", ENSURE_RULE("x", "    tiers: { high: 1.5 }\n")), "rules[0].tiers.high"],
      [packYaml("p", ENSURE_RULE("x", "    severity: P9\n")), "rules[0].severity"],
    ];
    for (const [yaml, path] of cases) {
      const root = tempRoot();
      const error = await packError(loadPack(writePack(root, "p", yaml), "repo"));
      expect(error.issues.map((issue) => issue.path)).toContain(path);
    }
  });

  test("rejects choice violations that are unknown, repeated, or cover every option", async () => {
    const choice = (violations: string): string =>
      `  - id: c\n    type: choice\n    applies: { paths: ["**/*"] }\n    ask: Which?\n    options: { a: A, b: B }\n    violations: ${violations}\n`;
    const messages = async (violations: string): Promise<string[]> => {
      const root = tempRoot();
      return (await packError(loadPack(writePack(root, "p", packYaml("p", choice(violations))), "repo"))).issues.map((issue) => issue.message);
    };
    expect(await messages("[z]")).toEqual(["names unknown option z"]);
    expect(await messages("[constructor]")).toEqual(["names unknown option constructor"]);
    expect(await messages("[toString]")).toContain("must be a lowercase option key");
    expect(await messages("[b, b]")).toEqual(["repeats option b"]);
    expect(await messages("[a, b]")).toEqual(["must leave at least one option that is not a violation"]);
  });

  test("rejects a score violation_at outside the levels", async () => {
    const root = tempRoot();
    const dir = writePack(root, "p", packYaml("p",
      `  - id: s\n    type: score\n    applies: { paths: ["**/*"] }\n    ask: How bad?\n    levels: [fine, bad]\n    violation_at: 2\n`));
    expect((await packError(loadPack(dir, "repo"))).issues.map((issue) => issue.path)).toEqual(["rules[0].violation_at"]);
  });

  test("rejects an unknown rule type", async () => {
    const root = tempRoot();
    const dir = writePack(root, "p", packYaml("p", `  - id: x\n    type: maybe\n    applies: { paths: ["**/*"] }\n    ask: Hm?\n`));
    expect((await packError(loadPack(dir, "repo"))).issues[0]?.message).toBe("must be noul, choice, or score");
  });

  test("reports issues from every broken pack together", async () => {
    const root = tempRoot();
    writePack(root, "a", packYaml("a", `  - id: x\n    applies: { paths: ["**/*"] }\n    ensure: a\n`));
    writePack(root, "b", packYaml("b", ENSURE_RULE("y", "    bogus: 1\n")));
    const error = await packError(loadPacks({ userDir: root }));
    expect(error.issues.map((issue) => issue.file)).toEqual([join(root, "a", "pack.yaml"), join(root, "b", "pack.yaml")]);
    expect(error.message).toContain("(and 1 more)");
  });
});

// ---------------------------------------------------------------------------
// Revision hash properties. A seeded generator keeps failures reproducible.
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const words = ["the", "code", "error", "input", "caller", "state", "it's", "\"quoted\"", "#hash", "key: value", "yes", "null", "émoji ✓", "- dash"];
const phrase = (random: Random): string => Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(random, words)).join(" ") + ".";

function randomRule(random: Random, index: number): Record<string, unknown> {
  const rule: Record<string, unknown> = {
    id: `rule-${index}-${Math.floor(random() * 1000)}`,
    applies: {
      paths: pick(random, [["**/*"], ["src/**/*.ts", "lib/**"], ["**/*.{ts,tsx}"]]),
      ...(random() < 0.5 ? { except: ["**/*.test.ts"] } : {}),
      ...(random() < 0.3 ? { languages: ["typescript", "tsx"] } : {}),
    },
  };
  const form = pick(random, ["ensure", "ask", "choice", "score"]);
  if (form === "ensure") {
    if (random() < 0.5) rule["type"] = "noul";
    rule["ensure"] = phrase(random);
    rule["breaks"] = phrase(random);
  } else if (form === "ask") {
    if (random() < 0.5) rule["type"] = "noul";
    rule["ask"] = phrase(random);
    rule["true"] = phrase(random);
    rule["false"] = phrase(random);
  } else if (form === "choice") {
    rule["type"] = "choice";
    rule["ask"] = phrase(random);
    rule["options"] = { none: phrase(random), boundary: phrase(random), leak: phrase(random) };
    rule["violations"] = random() < 0.5 ? ["boundary"] : ["boundary", "leak"];
  } else {
    rule["type"] = "score";
    rule["ask"] = phrase(random);
    rule["levels"] = [phrase(random), phrase(random), phrase(random)];
    rule["violation_at"] = pick(random, [1, 2]);
  }
  if (random() < 0.5) rule["unit"] = "hunk";
  if (random() < 0.5) rule["tiers"] = { high: 0.9, medium: 0.5 };
  if (random() < 0.5) rule["gate"] = false;
  if (random() < 0.5) rule["severity"] = pick(random, ["P0", "P1", "P2", "P3"]);
  if (random() < 0.3) rule["overlaps"] = ["eslint/no-unused-vars"];
  if (random() < 0.3) rule["source"] = { kind: "guide", file: "AGENTS.md", line: 1 + Math.floor(random() * 99) };
  return rule;
}

function shuffle<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/** Emit YAML with random key order, block or flow style, indentation, quoting, comments, and blank lines. */
function toYaml(random: Random, value: unknown, indent: string, step: string): string {
  const scalar = (item: unknown): string => {
    if (typeof item === "string") return random() < 0.5 ? JSON.stringify(item) : `'${item.replace(/'/g, "''")}'`;
    return JSON.stringify(item);
  };
  const flow = (item: unknown): string => {
    const gap = random() < 0.5 ? " " : "";
    if (Array.isArray(item)) return `[${gap}${item.map(flow).join(`,${gap}`)}${gap}]`;
    if (item !== null && typeof item === "object") {
      const entries = shuffle(random, Object.entries(item));
      return `{${gap}${entries.map(([key, child]) => `${JSON.stringify(key)}:${" "}${flow(child)}`).join(`,${gap}`)}${gap}}`;
    }
    return scalar(item);
  };
  if (value === null || typeof value !== "object") return scalar(value);
  if (random() < 0.3) return flow(value);
  const decorate = (): string => (random() < 0.15 ? `${indent}# note\n` : random() < 0.1 ? "\n" : "");
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "\n" + value.map((item) => {
      const rendered = toYaml(random, item, indent + step, step);
      return `${decorate()}${indent}-${rendered.startsWith("\n") ? rendered : ` ${rendered}`}`;
    }).join("\n");
  }
  const entries = shuffle(random, Object.entries(value));
  if (entries.length === 0) return "{}";
  return "\n" + entries.map(([key, child]) => {
    const rendered = toYaml(random, child, indent + step, step);
    const name = random() < 0.5 ? JSON.stringify(key) : key;
    return `${decorate()}${indent}${name}:${rendered.startsWith("\n") ? rendered : ` ${rendered}`}`;
  }).join("\n");
}

function parseRuleFromYaml(yaml: string): Rule {
  const pack = packFileSchema.parse(Bun.YAML.parse(yaml));
  const rule = pack.rules[0];
  if (rule === undefined) throw new Error("no rule parsed");
  return rule;
}

function packDocument(random: Random, rule: Record<string, unknown>): string {
  const step = pick(random, ["  ", "    ", "   "]);
  const document = { version: 1, pack: "prop", revision: "r1", description: "Property pack.", rules: [rule] };
  return toYaml(random, document, "", step).replace(/^\n/, "") + "\n";
}

/** Every leaf mutation that keeps the rule valid, each producing a semantically different rule. */
function mutations(rule: Record<string, unknown>): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
      return;
    }
    const replacements: unknown[] = [];
    const last = path[path.length - 1];
    if (typeof value === "string") {
      if (last === "unit") return;
      else if (last === "severity") replacements.push(value === "P0" ? "P1" : "P0");
      else if (last === "kind") replacements.push(value === "guide" ? "builtin" : "guide");
      else if (last === "id") replacements.push(`${value}-x`);
      else if (last === "type") return;
      else if (path.includes("violations")) return;
      else if (path.includes("paths") || path.includes("except")) replacements.push(`x/${value}`);
      else if (path.includes("languages") || path.includes("overlaps")) replacements.push(`${value}x`);
      else replacements.push(`${value} more`);
    } else if (typeof value === "number") {
      if (last === "violation_at") replacements.push(value === 1 ? 2 : 1);
      else if (last === "line") replacements.push(value + 1);
      else if (last === "medium") replacements.push(value - 0.05);
      else if (last === "high") replacements.push(value + 0.05);
    }
    for (const replacement of replacements) {
      const copy = structuredClone(rule);
      let cursor: unknown = copy;
      for (const part of path.slice(0, -1)) cursor = (cursor as Record<string | number, unknown>)[part];
      (cursor as Record<string | number, unknown>)[last as string | number] = replacement;
      results.push(copy);
    }
  };
  visit(rule, []);
  // Adding an optional field, or setting a default explicitly to a non-default value, is also a change.
  if (rule["severity"] === undefined) results.push({ ...structuredClone(rule), severity: "P3" });
  return results;
}

describe("rule revision hash", () => {
  test("is the SHA-256 of canonical JSON", () => {
    const rule = ruleSchema.parse({ id: "x", applies: { paths: ["**/*"] }, ensure: "a", breaks: "b" });
    const expected = new Bun.CryptoHasher("sha256").update(canonicalJson(rule)).digest("hex");
    expect(ruleRevision(rule)).toBe(expected);
    expect(ruleRevision(rule)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
  });

  test("property: invariant under key order and YAML formatting", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = prng(seed);
      const rule = randomRule(random, seed);
      const reference = ruleRevision(ruleSchema.parse(JSON.parse(JSON.stringify(rule))));
      for (let variant = 0; variant < 4; variant++) {
        const yaml = packDocument(random, rule);
        let parsed: Rule;
        try {
          parsed = parseRuleFromYaml(yaml);
        } catch (error) {
          throw new Error(`seed ${seed} variant ${variant} did not parse:\n${yaml}\n${String(error)}`);
        }
        expect(ruleRevision(parsed)).toBe(reference);
      }
    }
  });

  test("property: writing a default explicitly does not change the hash", () => {
    const base = { id: "x", applies: { paths: ["**/*"] }, ensure: "a", breaks: "b" };
    const explicit = { ...base, type: "noul", unit: "hunk", gate: false, tiers: { high: 0.85, medium: 0.6 } };
    expect(ruleRevision(ruleSchema.parse(explicit))).toBe(ruleRevision(ruleSchema.parse(base)));
  });

  test("property: changes when any rule field changes", () => {
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const random = prng(seed * 7919);
      const rule = randomRule(random, seed);
      const reference = ruleRevision(ruleSchema.parse(rule));
      const seen = new Set<string>([reference]);
      for (const mutated of mutations(rule)) {
        const parsed = ruleSchema.safeParse(mutated);
        if (!parsed.success) throw new Error(`seed ${seed}: mutation produced an invalid rule: ${JSON.stringify(mutated)}`);
        const revision = ruleRevision(parsed.data);
        expect(revision).not.toBe(reference);
        seen.add(revision);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2_000);
  });
});
