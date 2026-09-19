/**
 * Synthetic torch.save archive builder for tests. Emits a real zip container
 * (stored members, valid CRCs) plus a protocol-2 pickle in the exact shape
 * the restricted checkpoint loader accepts — no model weights needed.
 */

// ---------- crc32 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- minimal zip writer (method 0, stored) ----------

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number): Uint8Array => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return b;
  };
  const u32 = (v: number): Uint8Array => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return b;
  };
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = [
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(entry.data.byteLength),
      u32(entry.data.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      entry.data,
    ];
    const centralRecord = [
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(entry.data.byteLength),
      u32(entry.data.byteLength),
      u16(name.byteLength),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ];
    for (const chunk of local) chunks.push(chunk);
    offset += local.reduce((total, chunk) => total + chunk.byteLength, 0);
    central.push(...centralRecord);
  }
  const cdStart = offset;
  const cdSize = central.reduce((total, chunk) => total + chunk.byteLength, 0);
  const eocd = [
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cdSize),
    u32(cdStart),
    u16(0),
  ];
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, ...eocd]) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

// ---------- minimal protocol-2 pickle writer ----------

export class PickleWriter {
  private bytes: number[] = [];

  private u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }

  proto(): this {
    return this.u8(0x80).u8(2);
  }

  stop(): this {
    return this.u8(0x2e);
  }

  emptyDict(): this {
    return this.u8(0x7d);
  }

  mark(): this {
    return this.u8(0x28);
  }

  setitems(): this {
    return this.u8(0x75);
  }

  tuple(): this {
    return this.u8(0x74);
  }

  tuple1(): this {
    return this.u8(0x85);
  }

  tuple2(): this {
    return this.u8(0x86);
  }

  emptyTuple(): this {
    return this.u8(0x29);
  }

  binpersid(): this {
    return this.u8(0x51);
  }

  reduce(): this {
    return this.u8(0x52);
  }

  newfalse(): this {
    return this.u8(0x89);
  }

  none(): this {
    return this.u8(0x4e);
  }

  int(v: number): this {
    if (Number.isInteger(v) && v >= 0 && v <= 0xff) return this.u8(0x4b).u8(v);
    if (Number.isInteger(v) && v >= 0 && v <= 0xffff) {
      this.u8(0x4d);
      this.bytes.push(v & 0xff, (v >> 8) & 0xff);
      return this;
    }
    this.u8(0x4a);
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }

  str(s: string): this {
    const utf8 = new TextEncoder().encode(s);
    this.u8(0x58);
    this.bytes.push(
      utf8.byteLength & 0xff,
      (utf8.byteLength >> 8) & 0xff,
      (utf8.byteLength >> 16) & 0xff,
      (utf8.byteLength >> 24) & 0xff,
    );
    for (const byte of utf8) this.bytes.push(byte);
    return this;
  }

  global(module: string, name: string): this {
    this.u8(0x63);
    for (const byte of new TextEncoder().encode(`${module}\n${name}\n`)) {
      this.bytes.push(byte);
    }
    return this;
  }

  /** One `torch._utils._rebuild_tensor_v2(...)` call. */
  tensor(storageKey: string, numel: number, shape: number[]): this {
    const stride = shape.map((_, i) => shape.slice(i + 1).reduce((a, b) => a * b, 1));
    this.global("torch._utils", "_rebuild_tensor_v2");
    this.mark();
    // persistent id: ("storage", FloatStorage, key, "cpu", numel)
    this.mark();
    this.str("storage");
    this.global("torch", "FloatStorage");
    this.str(storageKey);
    this.str("cpu");
    this.int(numel);
    this.tuple();
    this.binpersid();
    this.int(0); // storage_offset
    this.intTuple(shape);
    this.intTuple(stride);
    this.newfalse();
    this.global("collections", "OrderedDict");
    this.emptyTuple();
    this.reduce();
    this.tuple();
    this.reduce();
    return this;
  }

  private intTuple(values: number[]): this {
    if (values.length === 1) {
      this.int(values[0] ?? 0);
      return this.tuple1();
    }
    if (values.length === 2) {
      this.int(values[0] ?? 0);
      this.int(values[1] ?? 0);
      return this.tuple2();
    }
    this.mark();
    for (const value of values) this.int(value);
    return this.tuple();
  }

  /** {"config": {...}, "state_dict": {name: tensor}} document. */
  checkpoint(
    config: Record<string, string | number>,
    tensors: { name: string; storageKey: string; shape: number[] }[],
  ): Uint8Array {
    this.proto();
    this.emptyDict();
    this.mark();
    this.str("config");
    this.emptyDict();
    this.mark();
    for (const [key, value] of Object.entries(config)) {
      this.str(key);
      if (typeof value === "string") this.str(value);
      else this.int(value);
    }
    this.setitems();
    this.str("state_dict");
    this.emptyDict();
    this.mark();
    for (const tensor of tensors) {
      this.str(tensor.name);
      const numel = tensor.shape.reduce((a, b) => a * b, 1);
      this.tensor(tensor.storageKey, numel, tensor.shape);
    }
    this.setitems();
    this.setitems();
    this.stop();
    return new Uint8Array(this.bytes);
  }

  finish(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

function float32Bytes(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return out;
}

/** Deterministic small-magnitude weights for fixture tensors. */
function seededValues(count: number, seed: number): number[] {
  const values: number[] = [];
  let state = seed >>> 0 || 1;
  for (let i = 0; i < count; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    values.push(((state / 0xffffffff) - 0.5) * 0.2);
  }
  return values;
}

/**
 * Build a complete, structurally valid scorer checkpoint for the given
 * tinyx config. Every tensor the architecture validator requires is present
 * with deterministic values — the checkpoint runs a real forward pass.
 */
export function buildScorerCheckpoint(config: {
  encoder: "tiny" | "tinyx";
  width: number;
  rank: number;
  layers?: number;
  heads?: number;
  context_tokens: number;
  option_tokens: number;
}): Uint8Array {
  const w = config.width;
  const r = config.rank;
  const layers = config.layers ?? 0;
  const tensors: { name: string; storageKey: string; shape: number[] }[] = [];
  const storages: ZipEntry[] = [];
  let key = 0;
  const add = (name: string, shape: number[], scale = 1): void => {
    const numel = shape.reduce((a, b) => a * b, 1);
    tensors.push({ name, storageKey: String(key), shape });
    const values = seededValues(numel, key + 1).map((v) => v * scale);
    storages.push({ name: `test/data/${key}`, data: float32Bytes(values) });
    key += 1;
  };
  // LayerNorm weights must be near 1 and biases near 0 for a sane pass.
  const addNorm = (name: string): void => {
    tensors.push({ name: `${name}.weight`, storageKey: String(key), shape: [w] });
    storages.push({ name: `test/data/${key}`, data: float32Bytes(new Array(w).fill(1)) });
    key += 1;
    tensors.push({ name: `${name}.bias`, storageKey: String(key), shape: [w] });
    storages.push({ name: `test/data/${key}`, data: float32Bytes(new Array(w).fill(0)) });
    key += 1;
  };
  const addLinear = (name: string, out: number, input: number): void => {
    add(`${name}.weight`, [out, input]);
    add(`${name}.bias`, [out]);
  };
  const addLayer = (prefix: string): void => {
    add(`${prefix}.self_attn.in_proj_weight`, [3 * w, w]);
    add(`${prefix}.self_attn.in_proj_bias`, [3 * w]);
    add(`${prefix}.self_attn.out_proj.weight`, [w, w]);
    add(`${prefix}.self_attn.out_proj.bias`, [w]);
    addLinear(`${prefix}.linear1`, 4 * w, w);
    addLinear(`${prefix}.linear2`, w, 4 * w);
    addNorm(`${prefix}.norm1`);
    addNorm(`${prefix}.norm2`);
  };

  add("embedding.weight", [257, w]);
  add("position.weight", [Math.max(config.context_tokens, config.option_tokens), w]);
  if (config.encoder === "tinyx") {
    for (let layer = 0; layer < layers; layer += 1) addLayer(`encoder.layers.${layer}`);
    addLayer("option_encoder.layers.0");
  }
  addNorm("head.context_norm");
  addNorm("head.option_norm");
  add("head.query.weight", [r, w]);
  add("head.key.weight", [r, w]);
  add("head.value.weight", [r, w]);

  const configRecord: Record<string, string | number> = {
    encoder: config.encoder,
    width: config.width,
    rank: config.rank,
    context_tokens: config.context_tokens,
    option_tokens: config.option_tokens,
  };
  if (config.encoder === "tinyx") {
    configRecord["layers"] = layers;
    configRecord["heads"] = config.heads ?? 1;
  }
  const pkl = new PickleWriter().checkpoint(configRecord, tensors);
  return buildZip([
    { name: "test/data.pkl", data: pkl },
    { name: "test/byteorder", data: new TextEncoder().encode("little") },
    ...storages,
  ]);
}
