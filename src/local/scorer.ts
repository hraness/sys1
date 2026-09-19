import {
  TorchCheckpointError,
  loadTorchCheckpoint,
  type TorchCheckpoint,
  type TorchTensor,
} from "./torchckpt.ts";

/**
 * Pure-TypeScript option scorer for the CUA-S1 `tiny`/`tinyx` architecture
 * (jevlike-style option attention). A checkpoint maps one byte-level context
 * plus N byte-level option strings to a probability per option in a single
 * forward pass — no autoregression, no generation.
 *
 * This is a specialist model class: quality is only established inside each
 * checkpoint's trained domain (for cua-s1-forms, GUI form decisions). The
 * math below mirrors `cua_s1.model.TinyScorer`/`TinyTransformerScorer`.
 */

export const SCORER_LIMITS = {
  maxWidth: 1_024,
  maxLayers: 8,
  maxHeads: 32,
  maxContextTokens: 4_096,
  maxOptionTokens: 1_024,
  maxOptions: 26,
} as const;

export interface ScorerConfig {
  encoder: "tiny" | "tinyx";
  width: number;
  rank: number;
  layers: number;
  heads: number;
  contextTokens: number;
  optionTokens: number;
}

interface Weights {
  get(name: string): TorchTensor;
}

function need(tensors: Map<string, TorchTensor>, name: string, shape: number[]): TorchTensor {
  const tensor = tensors.get(name);
  if (tensor === undefined) {
    throw new TorchCheckpointError(`checkpoint is missing tensor ${name}`);
  }
  if (
    tensor.shape.length !== shape.length ||
    tensor.shape.some((dim, i) => dim !== shape[i])
  ) {
    throw new TorchCheckpointError(
      `tensor ${name} has shape [${tensor.shape}] expected [${shape}]`,
    );
  }
  return tensor;
}

function positiveInt(config: Record<string, unknown>, key: string): number {
  const value = config[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TorchCheckpointError(`config field ${key} must be a positive integer`);
  }
  return value;
}

function parseConfig(config: Record<string, unknown>): ScorerConfig {
  const encoder = config["encoder"];
  if (encoder !== "tiny" && encoder !== "tinyx") {
    throw new TorchCheckpointError(`unsupported scorer encoder ${String(encoder)}`);
  }
  const parsed: ScorerConfig = {
    encoder,
    width: positiveInt(config, "width"),
    rank: positiveInt(config, "rank"),
    layers: encoder === "tinyx" ? positiveInt(config, "layers") : 0,
    heads: encoder === "tinyx" ? positiveInt(config, "heads") : 0,
    contextTokens: positiveInt(config, "context_tokens"),
    optionTokens: positiveInt(config, "option_tokens"),
  };
  if (
    parsed.width > SCORER_LIMITS.maxWidth ||
    parsed.layers > SCORER_LIMITS.maxLayers ||
    parsed.heads > SCORER_LIMITS.maxHeads ||
    parsed.contextTokens > SCORER_LIMITS.maxContextTokens ||
    parsed.optionTokens > SCORER_LIMITS.maxOptionTokens ||
    parsed.width % (parsed.heads || 1) !== 0
  ) {
    throw new TorchCheckpointError("scorer dimensions exceed supported bounds");
  }
  return parsed;
}

// ---------- small Float32 tensor ops (row-major [T, E]) ----------

function embed(ids: Uint16Array, table: Float32Array, position: Float32Array, width: number): Float32Array {
  const out = new Float32Array(ids.length * width);
  for (let t = 0; t < ids.length; t += 1) {
    const row = (ids[t] ?? 0) * width;
    const pos = t * width;
    for (let e = 0; e < width; e += 1) {
      out[pos + e] = (table[row + e] ?? 0) + (position[pos + e] ?? 0);
    }
  }
  return out;
}

function layerNorm(x: Float32Array, rows: number, width: number, w: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let t = 0; t < rows; t += 1) {
    const base = t * width;
    let mean = 0;
    for (let e = 0; e < width; e += 1) mean += x[base + e] ?? 0;
    mean /= width;
    let variance = 0;
    for (let e = 0; e < width; e += 1) {
      const d = (x[base + e] ?? 0) - mean;
      variance += d * d;
    }
    const inv = 1 / Math.sqrt(variance / width + 1e-5);
    for (let e = 0; e < width; e += 1) {
      out[base + e] = ((x[base + e] ?? 0) - mean) * inv * (w[e] ?? 0) + (b[e] ?? 0);
    }
  }
  return out;
}

/** y = x @ W^T (+b). x is [T, in], W is [out, in] → y is [T, out]. */
function linear(x: Float32Array, rows: number, w: Float32Array, inDim: number, outDim: number, bias?: Float32Array): Float32Array {
  const out = new Float32Array(rows * outDim);
  for (let t = 0; t < rows; t += 1) {
    const xb = t * inDim;
    const ob = t * outDim;
    for (let o = 0; o < outDim; o += 1) {
      const wb = o * inDim;
      let acc = 0;
      for (let i = 0; i < inDim; i += 1) {
        acc += (x[xb + i] ?? 0) * (w[wb + i] ?? 0);
      }
      out[ob + o] = acc + (bias?.[o] ?? 0);
    }
  }
  return out;
}

function softmaxInPlace(x: Float32Array, offset: number, length: number): void {
  let max = -Infinity;
  for (let i = 0; i < length; i += 1) max = Math.max(max, x[offset + i] ?? 0);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const v = Math.exp((x[offset + i] ?? 0) - max);
    x[offset + i] = v;
    sum += v;
  }
  for (let i = 0; i < length; i += 1) x[offset + i] = (x[offset + i] ?? 0) / sum;
}

/** Multi-head self attention; `mask[t]` true = real token, false = pad. */
function mha(
  x: Float32Array,
  tokens: number,
  mask: boolean[],
  w: Weights,
  prefix: string,
  width: number,
  heads: number,
): Float32Array {
  const dim = width / heads;
  const proj = linear(
    x,
    tokens,
    w.get(`${prefix}.self_attn.in_proj_weight`).data,
    width,
    width * 3,
    w.get(`${prefix}.self_attn.in_proj_bias`).data,
  );
  const out = new Float32Array(tokens * width);
  const scale = 1 / Math.sqrt(dim);
  for (let h = 0; h < heads; h += 1) {
    // per-head q,k,v slices laid out as [tokens, 3*width] → head h occupies
    // q:[h*dim..], k:[width+h*dim..], v:[2*width+h*dim..]
    const scores = new Float32Array(tokens * tokens);
    for (let t = 0; t < tokens; t += 1) {
      const qb = t * width * 3 + h * dim;
      for (let s = 0; s < tokens; s += 1) {
        if (!mask[s]) {
          scores[t * tokens + s] = -Infinity;
          continue;
        }
        const kb = s * width * 3 + width + h * dim;
        let acc = 0;
        for (let d = 0; d < dim; d += 1) {
          acc += (proj[qb + d] ?? 0) * (proj[kb + d] ?? 0);
        }
        scores[t * tokens + s] = acc * scale;
      }
      softmaxInPlace(scores, t * tokens, tokens);
    }
    for (let t = 0; t < tokens; t += 1) {
      const ob = t * width + h * dim;
      for (let s = 0; s < tokens; s += 1) {
        const p = scores[t * tokens + s] ?? 0;
        if (p === 0) continue;
        const vb = s * width * 3 + width * 2 + h * dim;
        for (let d = 0; d < dim; d += 1) {
          out[ob + d] = (out[ob + d] ?? 0) + p * (proj[vb + d] ?? 0);
        }
      }
    }
  }
  return linear(
    out,
    tokens,
    w.get(`${prefix}.self_attn.out_proj.weight`).data,
    width,
    width,
    w.get(`${prefix}.self_attn.out_proj.bias`).data,
  );
}

/** One norm-first TransformerEncoderLayer (relu FFN, eval-time). */
function encoderLayer(
  x: Float32Array,
  tokens: number,
  mask: boolean[],
  w: Weights,
  prefix: string,
  width: number,
  heads: number,
): Float32Array {
  const normed1 = layerNorm(
    x, tokens, width,
    w.get(`${prefix}.norm1.weight`).data,
    w.get(`${prefix}.norm1.bias`).data,
  );
  const attended = mha(normed1, tokens, mask, w, prefix, width, heads);
  for (let i = 0; i < x.length; i += 1) x[i] = (x[i] ?? 0) + (attended[i] ?? 0);
  const normed2 = layerNorm(
    x, tokens, width,
    w.get(`${prefix}.norm2.weight`).data,
    w.get(`${prefix}.norm2.bias`).data,
  );
  const ffn1 = linear(
    normed2, tokens,
    w.get(`${prefix}.linear1.weight`).data, width, width * 4,
    w.get(`${prefix}.linear1.bias`).data,
  );
  for (let i = 0; i < ffn1.length; i += 1) if ((ffn1[i] ?? 0) < 0) ffn1[i] = 0;
  const ffn2 = linear(
    ffn1, tokens,
    w.get(`${prefix}.linear2.weight`).data, width * 4, width,
    w.get(`${prefix}.linear2.bias`).data,
  );
  for (let i = 0; i < x.length; i += 1) x[i] = (x[i] ?? 0) + (ffn2[i] ?? 0);
  return x;
}

function byteIds(text: string, limit: number): Uint16Array {
  const raw = new TextEncoder().encode(text);
  const count = Math.min(raw.length, limit);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) out[i] = (raw[i] ?? 0) + 1;
  return out;
}

export interface OptionScorer {
  readonly config: ScorerConfig;
  readonly tensorCount: number;
  /** One probability per option (softmax over live options). */
  score(context: string, options: string[]): number[];
}

class Scorer implements OptionScorer {
  readonly tensorCount: number;
  constructor(
    readonly config: ScorerConfig,
    private readonly tensors: Map<string, TorchTensor>,
  ) {
    this.tensorCount = tensors.size;
  }

  get(name: string): TorchTensor {
    const tensor = this.tensors.get(name);
    if (tensor === undefined) {
      throw new TorchCheckpointError(`checkpoint is missing tensor ${name}`);
    }
    return tensor;
  }

  private embedWith(ids: Uint16Array): Float32Array {
    return embed(
      ids,
      this.get("embedding.weight").data,
      this.get("position.weight").data,
      this.config.width,
    );
  }

  private encodeContext(ids: Uint16Array): Float32Array {
    const mask = new Array<boolean>(ids.length).fill(true);
    let x = this.embedWith(ids);
    if (this.config.encoder === "tinyx") {
      for (let layer = 0; layer < this.config.layers; layer += 1) {
        x = encoderLayer(
          x, ids.length, mask, this, `encoder.layers.${layer}`,
          this.config.width, this.config.heads,
        );
      }
    }
    return x;
  }

  private encodeOption(ids: Uint16Array): Float32Array {
    const mask = new Array<boolean>(ids.length).fill(true);
    let hidden: Float32Array;
    if (this.config.encoder === "tinyx") {
      hidden = this.embedWith(ids);
      hidden = encoderLayer(
        hidden, ids.length, mask, this, "option_encoder.layers.0",
        this.config.width, this.config.heads,
      );
    } else {
      // tiny scorer: mean-pool raw embeddings
      hidden = this.embedWith(ids);
    }
    // mean-pool over real tokens (all tokens are real here — no padding)
    const width = this.config.width;
    const pooled = new Float32Array(width);
    for (let t = 0; t < ids.length; t += 1) {
      for (let e = 0; e < width; e += 1) {
        pooled[e] = (pooled[e] ?? 0) + (hidden[t * width + e] ?? 0);
      }
    }
    for (let e = 0; e < width; e += 1) pooled[e] = (pooled[e] ?? 0) / Math.max(1, ids.length);
    return pooled;
  }

  score(context: string, options: string[]): number[] {
    if (options.length < 2 || options.length > SCORER_LIMITS.maxOptions) {
      throw new TorchCheckpointError(
        `scorer accepts 2..${SCORER_LIMITS.maxOptions} options, got ${options.length}`,
      );
    }
    const ctxIds = byteIds(context, this.config.contextTokens);
    if (ctxIds.length === 0) throw new TorchCheckpointError("empty scorer context");
    const ctx = this.encodeContext(ctxIds);
    const ctxLen = ctxIds.length;
    const width = this.config.width;
    const rank = this.config.rank;

    const ctxN = layerNorm(
      ctx, ctxLen, width,
      this.get("head.context_norm.weight").data,
      this.get("head.context_norm.bias").data,
    );
    const key = linear(ctxN, ctxLen, this.get("head.key.weight").data, width, rank);
    const value = linear(ctxN, ctxLen, this.get("head.value.weight").data, width, rank);

    const logits = new Float32Array(options.length);
    const scale = 1 / Math.sqrt(rank);
    for (let n = 0; n < options.length; n += 1) {
      const optIds = byteIds(options[n] ?? "", this.config.optionTokens);
      const pooled = this.encodeOption(optIds);
      const normed = layerNorm(
        pooled, 1, width,
        this.get("head.option_norm.weight").data,
        this.get("head.option_norm.bias").data,
      );
      const query = linear(normed, 1, this.get("head.query.weight").data, width, rank);
      // attention: query(option) over key/value(context)
      const scores = new Float32Array(ctxLen);
      for (let t = 0; t < ctxLen; t += 1) {
        let acc = 0;
        for (let r = 0; r < rank; r += 1) {
          acc += (query[r] ?? 0) * (key[t * rank + r] ?? 0);
        }
        scores[t] = acc * scale;
      }
      softmaxInPlace(scores, 0, ctxLen);
      let logit = 0;
      for (let r = 0; r < rank; r += 1) {
        let att = 0;
        for (let t = 0; t < ctxLen; t += 1) {
          att += (scores[t] ?? 0) * (value[t * rank + r] ?? 0);
        }
        logit += (query[r] ?? 0) * att;
      }
      logits[n] = logit * scale;
    }
    softmaxInPlace(logits, 0, options.length);
    return [...logits];
  }
}

function requireLayer(tensors: Map<string, TorchTensor>, prefix: string, w: number): void {
  need(tensors, `${prefix}.self_attn.in_proj_weight`, [3 * w, w]);
  need(tensors, `${prefix}.self_attn.in_proj_bias`, [3 * w]);
  need(tensors, `${prefix}.self_attn.out_proj.weight`, [w, w]);
  need(tensors, `${prefix}.self_attn.out_proj.bias`, [w]);
  need(tensors, `${prefix}.linear1.weight`, [4 * w, w]);
  need(tensors, `${prefix}.linear1.bias`, [4 * w]);
  need(tensors, `${prefix}.linear2.weight`, [w, 4 * w]);
  need(tensors, `${prefix}.linear2.bias`, [w]);
  need(tensors, `${prefix}.norm1.weight`, [w]);
  need(tensors, `${prefix}.norm1.bias`, [w]);
  need(tensors, `${prefix}.norm2.weight`, [w]);
  need(tensors, `${prefix}.norm2.bias`, [w]);
}

function requireArchitecture(tensors: Map<string, TorchTensor>, config: ScorerConfig): void {
  const w = config.width;
  const r = config.rank;
  need(tensors, "embedding.weight", [257, w]);
  need(tensors, "position.weight", [Math.max(config.contextTokens, config.optionTokens), w]);
  if (config.encoder === "tinyx") {
    for (let layer = 0; layer < config.layers; layer += 1) {
      requireLayer(tensors, `encoder.layers.${layer}`, w);
    }
    requireLayer(tensors, "option_encoder.layers.0", w);
  }
  need(tensors, "head.context_norm.weight", [w]);
  need(tensors, "head.context_norm.bias", [w]);
  need(tensors, "head.option_norm.weight", [w]);
  need(tensors, "head.option_norm.bias", [w]);
  need(tensors, "head.query.weight", [r, w]);
  need(tensors, "head.key.weight", [r, w]);
  need(tensors, "head.value.weight", [r, w]);
}

/** Load a scorer from torch.save checkpoint bytes. */
export function loadScorer(bytes: Uint8Array): OptionScorer {
  const checkpoint: TorchCheckpoint = loadTorchCheckpoint(bytes);
  const config = parseConfig(checkpoint.config);
  requireArchitecture(checkpoint.tensors, config);
  return new Scorer(config, checkpoint.tensors);
}
