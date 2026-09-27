import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadPack, loadPacks, packRoots } from "./pack.ts";
import { compileUnit } from "./compile.ts";
import { packFileSchema, ruleRevision } from "./schema.ts";
import { ProjectFileError, writeProjectFile } from "../review/project-files.ts";

export const BUILTIN_RULES = fileURLToPath(new URL(import.meta.path.endsWith(".ts") ? "../../packs/" : "./packs/", import.meta.url));

/** Drafts need explicit prose and selection; they are never activated here. */
export async function runRulesCli(argv: string[], home: string, repoRoot: string) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const valueFlags = new Set(["ensure", "breaks", "source", "path"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, ...tail] = arg.slice(2).split("=");
    if (name === undefined || flags.has(name)) throw new ProjectFileError("Rule options must be known and appear once");
    if (["dry-run", "json", "agent"].includes(name) && tail.length === 0) flags.set(name, true);
    else if (valueFlags.has(name)) {
      const value = tail.length > 0 ? tail.join("=") : argv[++i];
      if (value === undefined || !value || value.startsWith("--")) throw new ProjectFileError(`--${name} needs a value`);
      flags.set(name, value);
    } else throw new ProjectFileError("Unknown rules option");
  }
  const [command, name] = positional;
  const allowed = command === "draft" ? new Set([...valueFlags, "dry-run", "json", "agent"]) : new Set(["json", "agent"]);
  if ([...flags.keys()].some((flag) => !allowed.has(flag))) throw new ProjectFileError("Option does not apply to this rules command");
  if (command === "list" && positional.length === 1) {
    const rules = await loadPacks(packRoots({ repoRoot, sys1Home: home, builtinDir: BUILTIN_RULES }));
    return { version: 1, advisory: true, command, rules: rules.rules.map((loaded) => ({
      id: loaded.id, revision: loaded.revision, pack: loaded.pack.name, layer: loaded.pack.layer,
      rule: loaded.rule, overrides: loaded.overrides,
    })) };
  }
  if (command === "check" && name !== undefined && positional.length === 2) {
    const pack = await loadPack(resolve(repoRoot, name), "repo");
    // Exercise the complete compiler, including instruction/body bounds.
    compileUnit(pack.rules, "A local rule validation example; no model call is made.", { model: "validation/no-inference" });
    return { version: 1, advisory: true, command, valid: true, pack: pack.name,
      rules: pack.rules.map((rule) => ({ id: rule.id, revision: ruleRevision(rule) })), requests: 0 };
  }
  if (command === "draft" && name !== undefined && positional.length === 2) {
    const pack = packFileSchema.safeParse({
      version: 1, pack: name, revision: "1", description: `Draft repository convention: ${name}`,
      rules: [{ id: name, ensure: flags.get("ensure"), breaks: flags.get("breaks"),
        applies: { paths: [flags.get("path")] }, source: { kind: "guide", file: flags.get("source") } }],
    });
    if (!pack.success || typeof flags.get("source") !== "string") {
      throw new ProjectFileError("Draft needs a kebab-case name, --ensure, --breaks, --path and a repository-relative --source");
    }
    compileUnit(pack.data.rules, "Local draft validation; no model call is made.", { model: "validation/no-inference" });
    const path = `.sys1/drafts/${pack.data.pack}/pack.yaml`;
    // JSON is YAML 1.2; serializing it prevents guide prose from injecting YAML.
    const status = await writeProjectFile(repoRoot, path, `${JSON.stringify(pack.data, null, 2)}\n`, flags.has("dry-run"));
    return { version: 1, advisory: true, command, path, status, active: false, requests: 0 };
  }
  throw new ProjectFileError("Use rules list, rules check <pack-directory>, or rules draft <name>");
}
