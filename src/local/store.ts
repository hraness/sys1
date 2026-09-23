import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

/**
 * Local model store. Weights live under `$SYS1_HOME/models/` as plain GGUF
 * files plus a small manifest. Downloads verify sha256 against the curated
 * registry (or a caller-supplied hash for `hf:` sources) before the file is
 * admitted — a truncated or poisoned download never reaches the engine.
 */

export const MODEL_LIMITS = {
  maxManifestBytes: 65_536,
  maxModelBytes: 8_589_934_592,
  maxModels: 16,
  maxGgufTensors: 1_000_000,
  maxGgufMetadataEntries: 1_000_000,
  downloadTimeoutMs: 3_600_000,
} as const;

export const modelIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9.-]*$/, "lowercase letters, digits, dots, hyphens");

export const MODEL_KINDS = ["gguf"] as const;
export const modelKindSchema = z.enum(MODEL_KINDS);
export type ModelKind = z.infer<typeof modelKindSchema>;

const KIND_EXTENSIONS: Record<ModelKind, string> = {
  gguf: "gguf",
};

export function kindExtension(kind: ModelKind): string {
  return KIND_EXTENSIONS[kind];
}

const installedModelSchema = z
  .object({
    id: modelIdSchema,
    kind: modelKindSchema.default("gguf"),
    file: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9.-]*\.gguf$/, "safe lowercase model filename"),
    size_b: z.number().positive().max(10_000).optional(),
    source: z.string().min(1).max(512),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
    context: z.number().int().min(64).max(1_048_576).default(4096),
    installed_at: z.string().max(64),
  });

export const manifestSchema = z.object({
  version: z.literal(1),
  models: z.array(installedModelSchema).max(MODEL_LIMITS.maxModels).default([]),
});

export type InstalledModel = z.infer<typeof installedModelSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export interface RegistryEntry {
  id: string;
  kind: ModelKind;
  size_b: number;
  repo: string;
  /** Immutable Hugging Face commit for the weights. */
  revision: string;
  file: string;
  sha256: string;
  bytes: number;
  context: number;
  description: string;
  experimental?: boolean;
}

/**
 * Curated models, pinned to an immutable publisher revision and LFS SHA-256.
 * All Qwen models are experimental for decisions. Setup and pull default to
 * Qwen3 1.7B; other models require explicit selection.
 */
export const MODEL_REGISTRY: RegistryEntry[] = [
  {
    id: "qwen3-0.6b",
    kind: "gguf",
    size_b: 0.6,
    repo: "unsloth/Qwen3-0.6B-GGUF",
    revision: "50968a4468ef4233ed78cd7c3de230dd1d61a56b",
    file: "Qwen3-0.6B-Q4_0.gguf",
    sha256: "33bcc57074ec7b6eada5a90651ee546ec0c2b271002c22baf9f1b2dd1e8f75cb",
    bytes: 382_156_480,
    context: 2048,
    description: "Qwen3 0.6B Q4_0: experimental diagnostic model (365 MiB)",
    experimental: true,
  },
  {
    id: "qwen3-1.7b",
    kind: "gguf",
    size_b: 1.7,
    repo: "unsloth/Qwen3-1.7B-GGUF",
    revision: "d7f544eead698dbd1f15126ef60b45a1e1933222",
    file: "Qwen3-1.7B-Q4_K_M.gguf",
    sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
    bytes: 1_107_409_472,
    context: 2048,
    description: "Qwen3 1.7B Q4_K_M: experimental default local model (1.0 GiB)",
    experimental: true,
  },
  {
    id: "qwen3.5-4b",
    kind: "gguf",
    size_b: 4,
    repo: "unsloth/Qwen3.5-4B-GGUF",
    revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    bytes: 2_740_937_888,
    context: 2048,
    description: "Qwen3.5 4B Q4_K_M: experimental local decision model (2.6 GiB)",
    experimental: true,
  },
];

export function modelsDir(home: string): string {
  return join(home, "models");
}

export function manifestPath(home: string): string {
  return join(modelsDir(home), "manifest.json");
}

export type ManifestLoadResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; message: string };

export function loadManifestChecked(home: string): ManifestLoadResult {
  const path = manifestPath(home);
  if (!existsSync(path)) return { ok: true, manifest: { version: 1, models: [] } };
  let parsed: unknown;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { ok: false, message: "model manifest is not a regular file" };
    }
    if (stats.size > MODEL_LIMITS.maxManifestBytes) {
      return { ok: false, message: `model manifest exceeds ${MODEL_LIMITS.maxManifestBytes} bytes` };
    }
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, message: `model manifest is not valid JSON: ${path}` };
  }
  const records = typeof parsed === "object" && parsed !== null && "models" in parsed
    ? (parsed as { models: unknown }).models : undefined;
  if (Array.isArray(records) && records.some((model: unknown) => {
    if (typeof model !== "object" || model === null) return false;
    const record = model as Record<string, unknown>;
    return record["kind"] === "scorer" || record["kind"] === "needle" ||
      Object.keys(record).some((key) => key.startsWith("engine_")) ||
      (typeof record["file"] === "string" && /\.(pt|cact)$/.test(record["file"]));
  })) {
    return {
      ok: false,
      message: "legacy scorer/Needle model inventory is unsupported; use a new SYS1_HOME for Qwen. Existing manifest and model files were not changed.",
    };
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      message: `invalid model manifest${issue === undefined ? "" : ` at ${issue.path.join(".")}: ${issue.message}`}`,
    };
  }
  return { ok: true, manifest: result.data };
}

export class ModelStoreError extends Error {
  override name = "ModelStoreError";
}

export function loadManifest(home: string): Manifest {
  const result = loadManifestChecked(home);
  if (!result.ok) throw new ModelStoreError(result.message);
  return result.manifest;
}

export function saveManifest(home: string, manifest: Manifest): void {
  const current = loadManifestChecked(home);
  if (!current.ok) throw new ModelStoreError(current.message);
  const parsed = manifestSchema.parse(manifest);
  mkdirSync(modelsDir(home), { recursive: true, mode: 0o700 });
  const path = manifestPath(home);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function modelFilePath(home: string, model: InstalledModel): string {
  return join(modelsDir(home), model.file);
}

export type GgufInspection =
  | {
      ok: true;
      version: number;
      tensors: number;
      metadata_entries: number;
      bytes: number;
    }
  | { ok: false; message: string };

export function inspectGgufFile(path: string): GgufInspection {
  let descriptor: number | null = null;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { ok: false, message: "model path is not a regular file" };
    }
    if (stats.size < 24) return { ok: false, message: "GGUF header is truncated" };
    descriptor = openSync(path, "r");
    const header = Buffer.alloc(24);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== header.length) return { ok: false, message: "GGUF header is truncated" };
    if (header.toString("ascii", 0, 4) !== "GGUF") {
      return { ok: false, message: "file does not start with GGUF magic" };
    }
    const version = header.readUInt32LE(4);
    if (version < 1 || version > 3) {
      return { ok: false, message: `unsupported GGUF version ${version}` };
    }
    const tensors = header.readBigUInt64LE(8);
    const metadata = header.readBigUInt64LE(16);
    if (tensors > BigInt(MODEL_LIMITS.maxGgufTensors)) {
      return { ok: false, message: "GGUF tensor count exceeds the admission limit" };
    }
    if (metadata > BigInt(MODEL_LIMITS.maxGgufMetadataEntries)) {
      return { ok: false, message: "GGUF metadata count exceeds the admission limit" };
    }
    return {
      ok: true,
      version,
      tensors: Number(tensors),
      metadata_entries: Number(metadata),
      bytes: stats.size,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "cannot inspect GGUF" };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Installed models whose regular GGUF files are on disk. */
export function installedModels(home: string): InstalledModel[] {
  return loadManifest(home).models.filter((model) => {
    try {
      const stats = lstatSync(modelFilePath(home, model));
      if (!stats.isFile() || stats.isSymbolicLink()) return false;
      return true;
    } catch {
      return false;
    }
  });
}

export function findInstalled(home: string, id: string): InstalledModel | undefined {
  return installedModels(home).find((model) => model.id === id);
}

export function findRegistry(id: string): RegistryEntry | undefined {
  return MODEL_REGISTRY.find((entry) => entry.id === id);
}

export type PullTarget =
  | { kind: "registry"; entry: RegistryEntry }
  | { kind: "hf"; modelKind: "gguf"; repo: string; file: string; id: string };

/**
 * Resolve what `sys1 pull <ref>` means: a registry id, or
 * `hf:<org>/<repo>:<file.gguf>` for an unlisted Hugging Face
 * GGUF model.
 */
export function resolvePullTarget(ref: string): PullTarget | { error: string } {
  const entry = findRegistry(ref);
  if (entry !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(entry.revision)) {
      return { error: `invalid registry revision for ${entry.id}; expected an immutable 40-character commit` };
    }
    return { kind: "registry", entry };
  }
  if (ref.startsWith("hf:")) {
    const rest = ref.slice(3);
    const colon = rest.lastIndexOf(":");
    if (colon <= 0) return { error: "hf ref looks like hf:<org>/<repo>:<file.gguf>" };
    const repo = rest.slice(0, colon);
    const file = rest.slice(colon + 1);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: `bad repo ${repo}` };
    const segments = file.split("/");
    if (
      !/^[\w./-]+\.gguf$/.test(file) ||
      file.startsWith("/") ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      return { error: `file must be a relative .gguf path: ${file}` };
    }
    const modelKind = "gguf";
    const id = file
      .replace(/\.gguf$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (!modelIdSchema.safeParse(id).success) return { error: `cannot derive a model id from ${file}` };
    return { kind: "hf", modelKind, repo, file, id };
  }
  return { error: `unknown model ${ref}; run \`sys1 pull --list\` for the registry` };
}

export interface PullResult {
  ok: boolean;
  id?: string;
  path?: string;
  bytes?: number;
  message?: string;
}

async function fetchHfSha256(
  repo: string,
  file: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  try {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const treePath = dir.length > 0 ? `/${dir}` : "";
    const response = await fetchFn(`https://huggingface.co/api/models/${repo}/tree/main${treePath}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const entries: unknown = await response.json();
    if (!Array.isArray(entries)) return null;
    const base = file.includes("/") ? file.slice(file.lastIndexOf("/") + 1) : file;
    for (const item of entries) {
      if (typeof item !== "object" || item === null) continue;
      const path = (item as Record<string, unknown>)["path"];
      if (path !== file && path !== base) continue;
      const lfs = (item as Record<string, unknown>)["lfs"];
      if (typeof lfs === "object" && lfs !== null) {
        const oid = (lfs as Record<string, unknown>)["oid"];
        if (typeof oid === "string" && /^[0-9a-f]{64}$/.test(oid)) return oid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Download models into the store. Streams to a temp file, hashes while
 * writing, verifies against the expected sha256 (registry pin, caller flag,
 * or the publisher's LFS oid), runs the per-kind structural check, then
 * atomically renames + registers. Needle pulls fetch two artifacts: the
 * `.cact` weights and the platform engine binary.
 */
export interface PullOptions {
  sha256?: string;
  onProgress?: (done: number, total: number | null) => void;
  fetchFn?: typeof fetch;
}

interface VerifiedDownload {
  ok: boolean;
  received?: number;
  digest?: string;
  message?: string;
}

async function downloadVerified(
  url: string,
  tmpPath: string,
  expectedSha: string,
  expectedBytes: number | null,
  fetchFn: typeof fetch,
  onProgress?: (done: number, total: number | null) => void,
): Promise<VerifiedDownload> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(MODEL_LIMITS.downloadTimeoutMs),
    });
  } catch (error) {
    return { ok: false, message: `download failed: ${error instanceof Error ? error.name : "transport"}` };
  }
  if (!response.ok || response.body === null) {
    return { ok: false, message: `download failed: HTTP ${response.status} for ${url}` };
  }
  const lengthHeader = response.headers.get("content-length");
  const contentLength = lengthHeader === null ? null : Number(lengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MODEL_LIMITS.maxModelBytes) {
    return { ok: false, message: "model exceeds the 8 GiB store limit" };
  }
  if (
    expectedBytes !== null &&
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength !== expectedBytes
  ) {
    return { ok: false, message: `remote size mismatch for ${url}` };
  }
  const hash = createHash("sha256");
  const sink = createWriteStream(tmpPath, { mode: 0o600 });
  let writeFailure: unknown;
  sink.on("error", (error: unknown) => {
    writeFailure = error;
  });
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MODEL_LIMITS.maxModelBytes) {
        throw new Error("model exceeds the 8 GiB store limit");
      }
      hash.update(value);
      if (!sink.write(value)) {
        await new Promise<void>((resolveDrain, rejectDrain) => {
          const drained = (): void => {
            sink.off("error", failed);
            resolveDrain();
          };
          const failed = (error: Error): void => {
            sink.off("drain", drained);
            rejectDrain(error);
          };
          sink.once("drain", drained);
          sink.once("error", failed);
        });
      }
      if (writeFailure !== undefined) throw writeFailure;
      onProgress?.(received, expectedBytes);
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      sink.once("finish", resolveEnd);
      sink.once("error", rejectEnd);
      sink.end();
    });
    if (writeFailure !== undefined) throw writeFailure;
  } catch (error) {
    sink.destroy();
    rmSync(tmpPath, { force: true });
    return { ok: false, message: `download failed: ${error instanceof Error ? error.message : "io"}` };
  }
  const digest = hash.digest("hex");
  if (digest !== expectedSha) {
    rmSync(tmpPath, { force: true });
    return {
      ok: false,
      message: `sha256 mismatch: got ${digest.slice(0, 16)}…, expected ${expectedSha.slice(0, 16)}…`,
    };
  }
  if (expectedBytes !== null && received !== expectedBytes) {
    rmSync(tmpPath, { force: true });
    return { ok: false, message: `size mismatch: got ${received}, expected ${expectedBytes}` };
  }
  return { ok: true, received, digest };
}

export async function pullModel(
  home: string,
  ref: string,
  options: PullOptions = {},
): Promise<PullResult> {
  const target = resolvePullTarget(ref);
  if ("error" in target) return { ok: false, message: target.error };

  const fetchFn = options.fetchFn ?? fetch;
  const id = target.kind === "registry" ? target.entry.id : target.id;
  const repo = target.kind === "registry" ? target.entry.repo : target.repo;
  const revision = target.kind === "registry" ? target.entry.revision : "main";
  const file = target.kind === "registry" ? target.entry.file : target.file;
  const modelKind: ModelKind =
    target.kind === "registry" ? target.entry.kind : target.modelKind;
  const loaded = loadManifestChecked(home);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const manifest = loaded.manifest;
  if (manifest.models.some((model) => model.id === id)) {
    return { ok: false, message: `${id} is already installed` };
  }
  const extension = KIND_EXTENSIONS[modelKind];
  const finalPath = join(modelsDir(home), `${id}.${extension}`);
  if (existsSync(finalPath)) {
    return { ok: false, message: `${finalPath} exists but is not registered; move it before pulling` };
  }
  if (manifest.models.length >= MODEL_LIMITS.maxModels) {
    return { ok: false, message: `model store is full (${MODEL_LIMITS.maxModels})` };
  }

  let expectedSha = options.sha256;
  let expectedBytes: number | null = null;
  if (target.kind === "registry") {
    expectedSha = target.entry.sha256;
    expectedBytes = target.entry.bytes;
  } else if (expectedSha === undefined) {
    expectedSha = (await fetchHfSha256(repo, file, fetchFn)) ?? undefined;
  }
  if (expectedSha === undefined) {
    return {
      ok: false,
      message: `no sha256 available for ${repo}:${file}; pass --sha256 to verify the download`,
    };
  }

  mkdirSync(modelsDir(home), { recursive: true, mode: 0o700 });
  const tmpPath = `${finalPath}.download`;
  const weights = await downloadVerified(
    `https://huggingface.co/${repo}/resolve/${revision}/${file}`,
    tmpPath,
    expectedSha,
    expectedBytes,
    fetchFn,
    options.onProgress,
  );
  if (!weights.ok) return { ok: false, message: weights.message ?? "download failed" };
  const received = weights.received ?? 0;
  const digest = weights.digest ?? "";

  const inspection = inspectGgufFile(tmpPath);
  if (!inspection.ok) {
    rmSync(tmpPath, { force: true });
    return { ok: false, message: `invalid GGUF ${file}: ${inspection.message}` };
  }
  renameSync(tmpPath, finalPath);
  chmodSync(finalPath, 0o600);
  const next = structuredClone(manifest);
  next.models.push({
    id,
    kind: modelKind,
    file: `${id}.${extension}`,
    ...(target.kind === "registry" ? { size_b: target.entry.size_b } : {}),
    source: `hf:${repo}:${file}`,
    sha256: digest,
    bytes: received,
    context: target.kind === "registry" ? target.entry.context : 2048,
    installed_at: new Date().toISOString(),
  });
  saveManifest(home, next);
  return { ok: true, id, path: finalPath, bytes: received };
}

export function removeModel(home: string, id: string): { ok: boolean; message: string } {
  const loaded = loadManifestChecked(home);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const manifest = loaded.manifest;
  const model = manifest.models.find((entry) => entry.id === id);
  if (model === undefined) return { ok: false, message: `no installed model named ${id}` };
  rmSync(modelFilePath(home, model), { force: true });
  manifest.models = manifest.models.filter((entry) => entry.id !== id);
  saveManifest(home, manifest);
  return { ok: true, message: `removed ${id}` };
}

export interface VerifyModelResult {
  ok: boolean;
  expected?: string;
  actual?: string;
  gguf?: Extract<GgufInspection, { ok: true }>;
  message?: string;
}

async function hashFile(path: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export async function verifyModel(
  home: string,
  id: string,
): Promise<VerifyModelResult> {
  const loaded = loadManifestChecked(home);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const model = loaded.manifest.models.find((entry) => entry.id === id);
  if (model === undefined) return { ok: false, message: `no installed model named ${id}` };
  const path = modelFilePath(home, model);
  const actual = await hashFile(path);
  if (actual === null) return { ok: false, message: "cannot read model" };
  if (actual !== model.sha256) {
    return { ok: false, expected: model.sha256, actual, message: "sha256 mismatch" };
  }
  const gguf = inspectGgufFile(path);
  if (!gguf.ok) {
    return {
      ok: false,
      expected: model.sha256,
      actual,
      message: `invalid GGUF: ${gguf.message}`,
    };
  }
  return { ok: true, expected: model.sha256, actual, gguf };
}

/** Disk bytes currently held by the store. */
export function storeBytes(home: string): number {
  return installedModels(home).reduce((total, model) => {
    let bytes = 0;
    try {
      bytes += statSync(modelFilePath(home, model)).size;
    } catch {
      return total;
    }
    return total + bytes;
  }, 0);
}
