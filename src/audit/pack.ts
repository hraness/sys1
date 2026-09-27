import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { PROTOCOL_LIMITS, questionSchema } from "../protocol.ts";
import { ruleQuestion } from "./compile.ts";
import {
  PACK_LIMITS,
  packFileSchema,
  ruleRevision,
  type Rule,
} from "./schema.ts";

/** Later layers replace earlier ones by rule id: built-in, then user, then repository. */
export const PACK_LAYERS = ["builtin", "user", "repo"] as const;
export type PackLayer = (typeof PACK_LAYERS)[number];

export const PACK_FILE = "pack.yaml";
export const FIXTURES_DIR = "fixtures";
export const CALIBRATION_FILE = "calibration.jsonl";
export const HELDOUT_FILE = "heldout.jsonl";

export interface PackIssue {
  /** File the issue was found in. */
  readonly file: string;
  /** Dotted location inside the file, or empty for the whole file. */
  readonly path: string;
  readonly message: string;
}

/** Messages carry file paths, rule ids, and schema messages; never file contents. */
export class Sys1PackError extends Error {
  readonly code = "invalid_pack" as const;
  readonly issues: readonly PackIssue[];

  constructor(issues: readonly PackIssue[]) {
    const first = issues[0];
    const head = first === undefined
      ? "invalid rule pack"
      : `${first.file}${first.path === "" ? "" : ` ${first.path}`}: ${first.message}`;
    super(issues.length > 1 ? `${head} (and ${issues.length - 1} more)` : head);
    this.name = "Sys1PackError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export interface LoadedPack {
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly layer: PackLayer;
  /** The pack directory. Fixture paths below are derived from it. */
  readonly dir: string;
  readonly packFile: string;
  /** May not exist; the explicit benchmark command validates fixtures. */
  readonly calibrationFile: string;
  readonly heldoutFile: string;
  readonly rules: readonly Rule[];

}

export interface LoadedRule {
  readonly id: string;
  readonly rule: Rule;
  /** `ruleRevision(rule)`. */
  readonly revision: string;
  /** Pack whose definition won. */
  readonly pack: LoadedPack;
  /** Earlier definitions this one replaced, oldest first. */
  readonly overrides: readonly { readonly pack: string; readonly layer: PackLayer; readonly revision: string }[];
}

export interface RuleSet {
  /** Every loaded pack in load order (layer, then directory name). */
  readonly packs: readonly LoadedPack[];
  /** Winning rules in first-definition order. */
  readonly rules: readonly LoadedRule[];
  get(id: string): LoadedRule | undefined;
  /** The loaded pack with this name in the latest layer that has one. */
  pack(name: string): LoadedPack | undefined;
}

export interface PackRoots {
  /** Directory holding built-in `<name>/pack.yaml` packs. */
  readonly builtinDir?: string | undefined;
  /** `$SYS1_HOME/rules`. */
  readonly userDir?: string | undefined;
  /** `<repository>/.sys1/rules`. */
  readonly repoDir?: string | undefined;
}

/** Standard user and repository pack directories. */
export function packRoots(options: { sys1Home?: string; repoRoot?: string; builtinDir?: string }): PackRoots {
  return {
    builtinDir: options.builtinDir,
    userDir: options.sys1Home === undefined ? undefined : join(options.sys1Home, "rules"),
    repoDir: options.repoRoot === undefined ? undefined : join(options.repoRoot, ".sys1", "rules"),
  };
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.map((part) => (typeof part === "number" ? `[${part}]` : String(part)))
    .join(".").replace(/\.\[/g, "[");
}

/**
 * Copy parsed YAML into plain JSON data, rejecting non-JSON values and
 * bounding the node count. Aliases are shared references in the parser
 * output, so the budget also stops alias expansion from exhausting memory.
 */
function plainJson(input: unknown, maxNodes: number): unknown {
  let nodes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 64) throw new Error("document is too large or too deeply nested");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("document contains a non-finite number");
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => copy(item, depth + 1));
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(result, key, { value: copy(item, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    throw new Error("document contains a value that is not plain data");
  };
  return copy(input, 0);
}

async function readBoundedFile(file: string, maxBytes: number): Promise<string> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("must be a regular file, not a symbolic link");
  if (info.size > maxBytes) throw new Error(`exceeds ${maxBytes} bytes`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw new Error("must be a regular file, not a symbolic link");
    if (current.size > maxBytes) throw new Error(`exceeds ${maxBytes} bytes`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > maxBytes) throw new Error(`exceeds ${maxBytes} bytes`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally {
    await handle.close();
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * A max-size state plus one question must fit one request body. The slack
 * covers the envelope keys and the longest `model` pin.
 */
const MAX_STATE_ENVELOPE_BYTES = PROTOCOL_LIMITS.maxStateBytes + PROTOCOL_LIMITS.maxModelChars * 4 + 64;

function ruleFitIssues(rule: Rule, file: string, index: number): PackIssue[] {
  const question = ruleQuestion(rule);
  const issues: PackIssue[] = [];
  if (!questionSchema.safeParse(question).success) {
    issues.push({ file, path: `rules[${index}]`, message: `rule ${rule.id} does not compile to a valid question` });
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ [rule.id]: question })).byteLength;
  if (MAX_STATE_ENVELOPE_BYTES + bytes > PROTOCOL_LIMITS.maxBodyBytes) {
    issues.push({ file, path: `rules[${index}]`, message: `rule ${rule.id} does not fit one request beside a full-size unit` });
  }
  return issues;
}

/** Load one bounded pack directory; duplicate ids across packs are checked by loadPacks. */
export async function loadPack(dir: string, layer: PackLayer): Promise<LoadedPack> {
  const packFile = join(dir, PACK_FILE);
  const issues: PackIssue[] = [];
  let raw: unknown;
  try {
    raw = plainJson(Bun.YAML.parse(await readBoundedFile(packFile, PACK_LIMITS.maxPackFileBytes)), PACK_LIMITS.maxYamlNodes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === "ENOENT"
      ? "is missing"
      : error instanceof SyntaxError || (error as Error).name === "SyntaxError"
        ? "is not valid YAML"
        : (error as Error).message;
    throw new Sys1PackError([{ file: packFile, path: "", message }]);
  }
  const parsed = packFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Sys1PackError(parsed.error.issues.map((issue) => ({ file: packFile, path: formatPath(issue.path), message: issue.message })));
  }
  const pack = parsed.data;
  const directoryName = basename(dir);
  if (pack.pack !== directoryName) {
    issues.push({ file: packFile, path: "pack", message: `pack ${pack.pack} must live in a directory named ${pack.pack}, not ${directoryName}` });
  }
  pack.rules.forEach((rule, index) => issues.push(...ruleFitIssues(rule, packFile, index)));
  if (issues.length > 0) throw new Sys1PackError(issues);
  return freezeDeep({
    name: pack.pack,
    revision: pack.revision,
    description: pack.description,
    layer,
    dir,
    packFile,
    calibrationFile: join(dir, FIXTURES_DIR, CALIBRATION_FILE),
    heldoutFile: join(dir, FIXTURES_DIR, HELDOUT_FILE),
    rules: pack.rules,
  });
}

async function packDirectories(root: string): Promise<string[]> {
  let names: string[];
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Sys1PackError([{ file: root, path: "", message: "must be a directory, not a symbolic link" }]);
    }
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const dirs: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    const info = await lstat(dir);
    // Plain files such as `.gitkeep` or a README beside the packs are not packs.
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    dirs.push(dir);
  }
  if (dirs.length > PACK_LIMITS.maxPacksPerLayer) {
    throw new Sys1PackError([{ file: root, path: "", message: `holds more than ${PACK_LIMITS.maxPacksPerLayer} packs` }]);
  }
  return dirs;
}

/**
 * Load every pack under the three roots, merge rules by id (built-in, then
 * user, then repository; the later definition wins), and validate the result.
 * A missing root is an empty layer. Two packs in one layer defining the same
 * rule id is an error. All issues across packs are reported together.
 */
export async function loadPacks(roots: PackRoots): Promise<RuleSet> {
  const packs: LoadedPack[] = [];
  const issues: PackIssue[] = [];
  const layerDirs: Record<PackLayer, string | undefined> = {
    builtin: roots.builtinDir,
    user: roots.userDir,
    repo: roots.repoDir,
  };
  for (const layer of PACK_LAYERS) {
    const root = layerDirs[layer];
    if (root === undefined) continue;
    let dirs: string[];
    try {
      dirs = await packDirectories(root);
    } catch (error) {
      if (error instanceof Sys1PackError) {
        issues.push(...error.issues);
        continue;
      }
      throw error;
    }
    for (const dir of dirs) {
      try {
        packs.push(await loadPack(dir, layer));
      } catch (error) {
        if (error instanceof Sys1PackError) issues.push(...error.issues);
        else throw error;
      }
    }
  }

  interface Draft { rule: Rule; pack: LoadedPack; overrides: { pack: string; layer: PackLayer; revision: string }[] }
  const merged = new Map<string, Draft>();
  for (const pack of packs) {
    for (const rule of pack.rules) {
      const existing = merged.get(rule.id);
      if (existing !== undefined && existing.pack.layer === pack.layer) {
        issues.push({
          file: pack.packFile,
          path: rule.id,
          message: `rule id ${rule.id} is also defined by pack ${existing.pack.name} in the same ${pack.layer} layer`,
        });
        continue;
      }
      const overrides = existing === undefined
        ? []
        : [...existing.overrides, { pack: existing.pack.name, layer: existing.pack.layer, revision: ruleRevision(existing.rule) }];
      merged.set(rule.id, { rule, pack, overrides });
    }
  }
  if (merged.size > PACK_LIMITS.maxMergedRules) {
    issues.push({
      file: packs.at(-1)?.packFile ?? "",
      path: "rules",
      message: `merged packs define more than ${PACK_LIMITS.maxMergedRules} unique rules`,
    });
  }
  if (issues.length > 0) throw new Sys1PackError(issues);

  const rules: LoadedRule[] = [...merged.values()].map((draft) => {
    return Object.freeze({
      id: draft.rule.id,
      rule: draft.rule,
      revision: ruleRevision(draft.rule),
      pack: draft.pack,
      overrides: freezeDeep(draft.overrides),
    });
  });
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const frozenPacks = Object.freeze([...packs]);
  return Object.freeze({
    packs: frozenPacks,
    rules: Object.freeze(rules),
    get: (id: string) => byId.get(id),
    pack: (name: string) => {
      for (let index = frozenPacks.length - 1; index >= 0; index--) {
        const pack = frozenPacks[index];
        if (pack?.name === name) return pack;
      }
      return undefined;
    },
  });
}
