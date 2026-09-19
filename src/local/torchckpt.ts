import { inflateRawSync } from "node:zlib";

/**
 * Minimal reader for `torch.save` archives (zip container + pickle data.pkl)
 * restricted to what a state-dict checkpoint needs. This is NOT a general
 * pickle machine: the only globals it resolves are torch storage classes,
 * `_rebuild_tensor*` helpers, and `collections.OrderedDict`. Anything else —
 * including any opcode or global that could execute host code — is rejected.
 */

export const TORCH_LIMITS = {
  maxFileBytes: 268_435_456,
  maxMembers: 4_096,
  maxMemberBytes: 268_435_456,
  maxOps: 4_000_000,
  maxStack: 16_384,
  maxMemo: 16_384,
  maxStringBytes: 16_777_216,
  maxContainer: 200_000_000,
} as const;

export class TorchCheckpointError extends Error {}

interface ZipMember {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const min = Math.max(0, length - (65_536 + 22));
  for (let i = length - 22; i >= min; i -= 1) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === length
    ) {
      return i;
    }
  }
  throw new TorchCheckpointError("zip end of central directory not found");
}

/** Read a torch.save-style zip archive into name → bytes. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length < 22 || bytes.length > TORCH_LIMITS.maxFileBytes) {
    throw new TorchCheckpointError("archive size is outside checkpoint bounds");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes.length);
  const count = view.getUint16(eocd + 10, true);
  if (count > TORCH_LIMITS.maxMembers) {
    throw new TorchCheckpointError("archive has too many members");
  }
  const directoryOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const members: ZipMember[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new TorchCheckpointError("corrupt zip central directory");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    members.push({ name, method, compressed, size, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const out = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (const member of members) {
    if (
      member.name.includes("..") ||
      member.name.startsWith("/") ||
      member.name.includes("\\") ||
      seen.has(member.name)
    ) {
      throw new TorchCheckpointError(`unsafe member name ${member.name}`);
    }
    seen.add(member.name);
    if (
      member.size > TORCH_LIMITS.maxMemberBytes ||
      member.compressed > TORCH_LIMITS.maxMemberBytes
    ) {
      throw new TorchCheckpointError(`member ${member.name} exceeds size bound`);
    }
    if (view.getUint32(member.offset, true) !== 0x04034b50) {
      throw new TorchCheckpointError(`corrupt local header for ${member.name}`);
    }
    const localName = view.getUint16(member.offset + 26, true);
    const localExtra = view.getUint16(member.offset + 28, true);
    const start = member.offset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + member.compressed);
    let data: Uint8Array;
    if (member.method === 0) {
      data = raw;
    } else if (member.method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: member.size });
    } else {
      throw new TorchCheckpointError(
        `unsupported compression method ${member.method} for ${member.name}`,
      );
    }
    if (data.byteLength !== member.size) {
      throw new TorchCheckpointError(`member ${member.name} size mismatch`);
    }
    out.set(member.name, data);
  }
  return out;
}

// ---------- restricted pickle machine ----------

type PValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | PValue[]
  | PDict
  | StorageRef
  | TensorRef
  | GlobalRef;

class PDict {
  entries = new Map<PValue, PValue>();
}

interface GlobalRef {
  kind: "global";
  module: string;
  name: string;
}

interface StorageRef {
  kind: "storage";
  dtype: string;
  key: string;
  numel: number;
}

interface TensorRef {
  kind: "tensor";
  storage: StorageRef;
  offset: number;
  size: number[];
  stride: number[];
}

const STORAGE_DTYPES: Record<string, string> = {
  FloatStorage: "float32",
  DoubleStorage: "float64",
  HalfStorage: "float16",
  BFloat16Storage: "bfloat16",
  LongStorage: "int64",
  IntStorage: "int32",
  ShortStorage: "int16",
  CharStorage: "int8",
  ByteStorage: "uint8",
  BoolStorage: "bool",
};

const ALLOWED_GLOBALS = new Set<string>([
  "collections.OrderedDict",
  "torch.Size",
  ...Object.keys(STORAGE_DTYPES).map((name) => `torch.${name}`),
  "torch._utils._rebuild_tensor",
  "torch._utils._rebuild_tensor_v2",
  "torch._utils._rebuild_tensor_v3",
  "torch._utils._rebuild_parameter",
]);

function asGlobal(value: PValue): GlobalRef | null {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "global"
    ? (value as GlobalRef)
    : null;
}

class Unpickler {
  private pos = 0;
  private ops = 0;
  private readonly stack: PValue[] = [];
  private readonly marks: number[] = [];
  private readonly memo = new Map<number, PValue>();

  constructor(private readonly bytes: Uint8Array) {}

  private step(): number {
    this.ops += 1;
    if (this.ops > TORCH_LIMITS.maxOps) {
      throw new TorchCheckpointError("pickle opcode bound exceeded");
    }
    if (this.pos >= this.bytes.length) {
      throw new TorchCheckpointError("pickle ended mid-opcode");
    }
    return this.bytes[this.pos++] ?? 0;
  }

  private read(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.bytes.length) {
      throw new TorchCheckpointError("pickle read out of bounds");
    }
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  private readLine(): string {
    const end = this.bytes.indexOf(0x0a, this.pos);
    if (end < 0) throw new TorchCheckpointError("unterminated pickle line");
    const out = new TextDecoder().decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return out;
  }

  private u32(): number {
    const b = this.read(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  private u64(): number {
    const b = this.read(8);
    return Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true));
  }

  private i32(): number {
    const b = this.read(4);
    return new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true);
  }

  private f64(): number {
    const b = this.read(8);
    return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, false);
  }

  private longN(length: number): number {
    // two's-complement little-endian arbitrary-length integer
    const b = this.read(length);
    let value = 0n;
    for (let i = length - 1; i >= 0; i -= 1) {
      value = (value << 8n) | BigInt(b[i] ?? 0);
    }
    if (length > 0 && ((b[length - 1] ?? 0) & 0x80) !== 0) {
      value -= 1n << BigInt(length * 8);
    }
    return Number(value);
  }

  private push(value: PValue): void {
    if (this.stack.length >= TORCH_LIMITS.maxStack) {
      throw new TorchCheckpointError("pickle stack bound exceeded");
    }
    this.stack.push(value);
  }

  private pop(): PValue {
    const value = this.stack.pop();
    if (value === undefined) {
      throw new TorchCheckpointError("pickle stack underflow");
    }
    return value;
  }

  private popMark(): PValue[] {
    const mark = this.marks.pop();
    if (mark === undefined || mark > this.stack.length) {
      throw new TorchCheckpointError("pickle mark underflow");
    }
    return this.stack.splice(mark);
  }

  private memoPut(index: number, value: PValue): void {
    if (index < 0 || index >= TORCH_LIMITS.maxMemo) {
      throw new TorchCheckpointError("pickle memo index out of bounds");
    }
    this.memo.set(index, value);
  }

  private memoGet(index: number): PValue {
    const value = this.memo.get(index);
    if (value === undefined) {
      throw new TorchCheckpointError("pickle memo read of unset slot");
    }
    return value;
  }

  private reduce(callable: PValue, args: PValue[]): PValue {
    const ref = asGlobal(callable);
    if (ref === null) {
      throw new TorchCheckpointError("pickle tried to call a non-global");
    }
    if (ref.module === "collections" && ref.name === "OrderedDict") {
      return new PDict();
    }
    if (ref.module === "torch" && ref.name === "Size") {
      return [...args];
    }
    if (
      ref.module === "torch._utils" &&
      (ref.name === "_rebuild_tensor" ||
        ref.name === "_rebuild_tensor_v2" ||
        ref.name === "_rebuild_tensor_v3" ||
        ref.name === "_rebuild_parameter")
    ) {
      return this.rebuildTensor(args);
    }
    throw new TorchCheckpointError(`pickle tried to call ${ref.module}.${ref.name}`);
  }

  private rebuildTensor(args: PValue[]): TensorRef {
    const [storage, offset, size, stride] = args;
    const ref = typeof storage === "object" && storage !== null ? (storage as StorageRef) : null;
    if (
      ref === null ||
      ref.kind !== "storage" ||
      typeof offset !== "number" ||
      !Array.isArray(size) ||
      !Array.isArray(stride) ||
      size.some((v) => typeof v !== "number" || v < 0 || !Number.isInteger(v)) ||
      stride.some((v) => typeof v !== "number" || v < 0 || !Number.isInteger(v)) ||
      size.length !== stride.length ||
      size.length > 8
    ) {
      throw new TorchCheckpointError("malformed _rebuild_tensor arguments");
    }
    return {
      kind: "tensor",
      storage: ref,
      offset,
      size: size as number[],
      stride: stride as number[],
    };
  }

  private persistentLoad(pid: PValue): PValue {
    if (!Array.isArray(pid) || pid.length < 5 || pid[0] !== "storage") {
      throw new TorchCheckpointError("unsupported persistent id");
    }
    const [, storageType, key, , numel] = pid;
    const ref = asGlobal(storageType as PValue);
    if (
      ref === null ||
      typeof key !== "string" ||
      !/^\d+$/.test(key) ||
      typeof numel !== "number" ||
      numel < 0 ||
      numel > TORCH_LIMITS.maxContainer
    ) {
      throw new TorchCheckpointError("malformed storage persistent id");
    }
    const dtype = STORAGE_DTYPES[ref.name];
    if (dtype === undefined) {
      throw new TorchCheckpointError(`unsupported storage class ${ref.name}`);
    }
    return { kind: "storage", dtype, key, numel } satisfies StorageRef;
  }

  private build(target: PValue, state: PValue): void {
    if (target instanceof PDict) {
      if (state instanceof PDict) {
        for (const [k, v] of state.entries) target.entries.set(k, v);
      } else if (Array.isArray(state)) {
        for (const pair of state) {
          if (Array.isArray(pair) && pair.length === 2) {
            const key = pair[0];
            const value = pair[1];
            if (key !== undefined && value !== undefined) {
              target.entries.set(key, value);
            }
          }
        }
      }
      return;
    }
    // Tensor/global refs carry no mutable __setstate__ worth modeling; the
    // trailing backward-hooks dict in torch saves is safely ignored.
    if (typeof target === "object" && target !== null && "kind" in target) {
      return;
    }
    throw new TorchCheckpointError("pickle BUILD on unsupported object");
  }

  private setGlobal(): void {
    const name = this.pop();
    const module = this.pop();
    if (typeof name !== "string" || typeof module !== "string") {
      throw new TorchCheckpointError("bad STACK_GLOBAL operands");
    }
    if (!ALLOWED_GLOBALS.has(`${module}.${name}`)) {
      throw new TorchCheckpointError(`disallowed global ${module}.${name}`);
    }
    this.push({ kind: "global", module, name } satisfies GlobalRef);
  }

  run(): PValue {
    const decoder = new TextDecoder();
    for (;;) {
      const op = this.step();
      switch (op) {
        case 0x2e: // STOP
          return this.pop();
        case 0x80: // PROTO
          this.step();
          break;
        case 0x95: // FRAME
          this.read(8);
          break;
        case 0x28: // MARK
          this.marks.push(this.stack.length);
          break;
        case 0x7d: // EMPTY_DICT
          this.push(new PDict());
          break;
        case 0x29: // EMPTY_TUPLE
          this.push([]);
          break;
        case 0x5d: // EMPTY_LIST
          this.push([]);
          break;
        case 0x8f: // EMPTY_SET
          this.push([]);
          break;
        case 0x4e: // NONE
          this.push(null);
          break;
        case 0x88: // NEWTRUE
          this.push(true);
          break;
        case 0x89: // NEWFALSE
          this.push(false);
          break;
        case 0x4b: // BININT1
          this.push(this.step());
          break;
        case 0x4d: { // BININT2
          const b = this.read(2);
          this.push((b[0] ?? 0) | ((b[1] ?? 0) << 8));
          break;
        }
        case 0x4a: // BININT
          this.push(this.i32());
          break;
        case 0x49: // INT
        case 0x4c: { // LONG
          const text = this.readLine().replace(/[lL]$/, "");
          const value = Number(text);
          if (!Number.isFinite(value)) {
            throw new TorchCheckpointError("bad pickle integer");
          }
          this.push(value);
          break;
        }
        case 0x8a: { // LONG1
          const length = this.step();
          this.push(this.longN(length));
          break;
        }
        case 0x8b: { // LONG4
          const length = this.u32();
          this.push(this.longN(length));
          break;
        }
        case 0x47: // BINFLOAT
          this.push(this.f64());
          break;
        case 0x55: // UNICODE
          this.push(this.readLine());
          break;
        case 0x58: { // BINUNICODE
          const length = this.u32();
          if (length > TORCH_LIMITS.maxStringBytes) {
            throw new TorchCheckpointError("pickle string too large");
          }
          this.push(decoder.decode(this.read(length)));
          break;
        }
        case 0x8c: { // SHORT_BINUNICODE
          const length = this.step();
          this.push(decoder.decode(this.read(length)));
          break;
        }
        case 0x54: { // BINUNICODE8
          const length = this.u64();
          if (length > TORCH_LIMITS.maxStringBytes) {
            throw new TorchCheckpointError("pickle string too large");
          }
          this.push(decoder.decode(this.read(length)));
          break;
        }
        case 0x42: { // BINBYTES
          const length = this.u32();
          if (length > TORCH_LIMITS.maxStringBytes) {
            throw new TorchCheckpointError("pickle bytes too large");
          }
          this.push(this.read(length));
          break;
        }
        case 0x43: { // SHORT_BINBYTES
          const length = this.step();
          this.push(this.read(length));
          break;
        }
        case 0x8e: { // BINBYTES8
          const length = this.u64();
          if (length > TORCH_LIMITS.maxStringBytes) {
            throw new TorchCheckpointError("pickle bytes too large");
          }
          this.push(this.read(length));
          break;
        }
        case 0x85: { // TUPLE1
          const a = this.pop();
          this.push([a]);
          break;
        }
        case 0x86: { // TUPLE2
          const b = this.pop();
          const a = this.pop();
          this.push([a, b]);
          break;
        }
        case 0x87: { // TUPLE3
          const c = this.pop();
          const b = this.pop();
          const a = this.pop();
          this.push([a, b, c]);
          break;
        }
        case 0x74: // TUPLE
          this.push(this.popMark());
          break;
        case 0x6c: // LIST
          this.push(this.popMark());
          break;
        case 0x64: { // DICT
          const items = this.popMark();
          const dict = new PDict();
          for (let i = 0; i + 1 < items.length; i += 2) {
            dict.entries.set(items[i] as PValue, items[i + 1] as PValue);
          }
          this.push(dict);
          break;
        }
        case 0x61: { // APPEND
          const value = this.pop();
          const list = this.pop();
          if (!Array.isArray(list)) {
            throw new TorchCheckpointError("APPEND on non-list");
          }
          list.push(value);
          this.push(list);
          break;
        }
        case 0x65: { // APPENDS
          const items = this.popMark();
          const list = this.pop();
          if (!Array.isArray(list)) {
            throw new TorchCheckpointError("APPENDS on non-list");
          }
          list.push(...items);
          this.push(list);
          break;
        }
        case 0x73: { // SETITEM
          const value = this.pop();
          const key = this.pop();
          const dict = this.pop();
          if (!(dict instanceof PDict)) {
            throw new TorchCheckpointError("SETITEM on non-dict");
          }
          dict.entries.set(key, value);
          this.push(dict);
          break;
        }
        case 0x75: { // SETITEMS
          const items = this.popMark();
          const dict = this.pop();
          if (!(dict instanceof PDict)) {
            throw new TorchCheckpointError("SETITEMS on non-dict");
          }
          for (let i = 0; i + 1 < items.length; i += 2) {
            dict.entries.set(items[i] as PValue, items[i + 1] as PValue);
          }
          this.push(dict);
          break;
        }
        case 0x90: { // ADDITEMS (set)
          const items = this.popMark();
          const list = this.pop();
          if (!Array.isArray(list)) {
            throw new TorchCheckpointError("ADDITEMS on non-set");
          }
          list.push(...items);
          this.push(list);
          break;
        }
        case 0x91: // FROZENSET
          this.push(this.popMark());
          break;
        case 0x63: { // GLOBAL
          const module = this.readLine();
          const name = this.readLine();
          if (!ALLOWED_GLOBALS.has(`${module}.${name}`)) {
            throw new TorchCheckpointError(`disallowed global ${module}.${name}`);
          }
          this.push({ kind: "global", module, name } satisfies GlobalRef);
          break;
        }
        case 0x93: // STACK_GLOBAL
          this.setGlobal();
          break;
        case 0x52: { // REDUCE
          const args = this.pop();
          const callable = this.pop();
          if (!Array.isArray(args)) {
            throw new TorchCheckpointError("REDUCE args must be a tuple");
          }
          this.push(this.reduce(callable, args));
          break;
        }
        case 0x62: { // BUILD
          const state = this.pop();
          const target = this.pop();
          this.build(target, state);
          this.push(target);
          break;
        }
        case 0x51: { // BINPERSID
          const pid = this.pop();
          this.push(this.persistentLoad(pid));
          break;
        }
        case 0x50: { // PERSID
          this.readLine();
          throw new TorchCheckpointError("unsupported PERSID record");
        }
        case 0x71: { // BINPUT
          const index = this.step();
          this.memoPut(index, this.stack[this.stack.length - 1] as PValue);
          break;
        }
        case 0x72: { // LONG_BINPUT
          const index = this.u32();
          this.memoPut(index, this.stack[this.stack.length - 1] as PValue);
          break;
        }
        case 0x67: { // PUT
          const index = Number(this.readLine());
          this.memoPut(index, this.stack[this.stack.length - 1] as PValue);
          break;
        }
        case 0x94: { // MEMOIZE
          this.memoPut(this.memo.size, this.stack[this.stack.length - 1] as PValue);
          break;
        }
        case 0x68: { // BINGET
          const index = this.step();
          this.push(this.memoGet(index));
          break;
        }
        case 0x6a: { // LONG_BINGET
          const index = this.u32();
          this.push(this.memoGet(index));
          break;
        }
        case 0x70: { // GET
          const index = Number(this.readLine());
          this.push(this.memoGet(index));
          break;
        }
        case 0x30: // POP
          this.pop();
          break;
        case 0x31: // POP_MARK
          this.popMark();
          break;
        case 0x32: { // DUP
          this.push(this.stack[this.stack.length - 1] as PValue);
          break;
        }
        default:
          throw new TorchCheckpointError(
            `unsupported pickle opcode 0x${op.toString(16)} at ${this.pos - 1}`,
          );
      }
    }
  }
}

export interface TorchTensor {
  name: string;
  shape: number[];
  data: Float32Array;
}

export interface TorchCheckpoint {
  config: Record<string, unknown>;
  tensors: Map<string, TorchTensor>;
  metadata: Record<string, unknown>;
}

const DTYPE_BYTES: Record<string, number> = {
  float32: 4,
  float64: 8,
  float16: 2,
  bfloat16: 2,
  int64: 8,
  int32: 4,
  int16: 2,
  int8: 1,
  uint8: 1,
  bool: 1,
};

function float16ToFloat32(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function readStorage(bytes: Uint8Array, dtype: string, numel: number): Float32Array {
  const width = DTYPE_BYTES[dtype];
  if (width === undefined) throw new TorchCheckpointError(`bad dtype ${dtype}`);
  if (bytes.byteLength < numel * width) {
    throw new TorchCheckpointError("storage member shorter than declared numel");
  }
  const out = new Float32Array(numel);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < numel; i += 1) {
    const o = i * width;
    switch (dtype) {
      case "float32": out[i] = view.getFloat32(o, true); break;
      case "float64": out[i] = view.getFloat64(o, true); break;
      case "float16": out[i] = float16ToFloat32(view.getUint16(o, true)); break;
      case "bfloat16": {
        const dv = new DataView(new ArrayBuffer(4));
        dv.setUint16(2, view.getUint16(o, true), false);
        out[i] = dv.getFloat32(0, false);
        break;
      }
      case "int64": out[i] = Number(view.getBigInt64(o, true)); break;
      case "int32": out[i] = view.getInt32(o, true); break;
      case "int16": out[i] = view.getInt16(o, true); break;
      case "int8": out[i] = view.getInt8(o); break;
      case "uint8": out[i] = view.getUint8(o); break;
      case "bool": out[i] = view.getUint8(o) === 0 ? 0 : 1; break;
    }
  }
  return out;
}

function materializeTensor(name: string, ref: TensorRef, storages: Map<string, Float32Array>): TorchTensor {
  const storage = storages.get(ref.storage.key);
  if (storage === undefined) {
    throw new TorchCheckpointError(`tensor ${name} references missing storage`);
  }
  const numel = ref.size.reduce((a, b) => a * b, 1);
  if (numel > TORCH_LIMITS.maxContainer) {
    throw new TorchCheckpointError(`tensor ${name} exceeds element bound`);
  }
  const contiguous = ref.stride.every(
    (s, i) => s === ref.size.slice(i + 1).reduce((a, b) => a * b, 1),
  );
  const data = new Float32Array(numel);
  if (contiguous) {
    if (ref.offset + numel > storage.length) {
      throw new TorchCheckpointError(`tensor ${name} view exceeds storage`);
    }
    data.set(storage.subarray(ref.offset, ref.offset + numel));
  } else {
    const coords = new Array<number>(ref.size.length).fill(0);
    for (let i = 0; i < numel; i += 1) {
      let index = ref.offset;
      let rem = i;
      for (let d = ref.size.length - 1; d >= 0; d -= 1) {
        const dim = ref.size[d] ?? 1;
        coords[d] = rem % dim;
        rem = Math.floor(rem / dim);
      }
      for (let d = 0; d < ref.size.length; d += 1) {
        index += (coords[d] ?? 0) * (ref.stride[d] ?? 0);
      }
      if (index >= storage.length) {
        throw new TorchCheckpointError(`tensor ${name} view exceeds storage`);
      }
      data[i] = storage[index] ?? 0;
    }
  }
  return { name, shape: ref.size, data };
}

function dictGet(dict: PDict, key: string): PValue | undefined {
  for (const [k, v] of dict.entries) {
    if (k === key) return v;
  }
  return undefined;
}

/**
 * Parse a torch.save checkpoint into plain tensors. Only dict documents with
 * a `config` object and a `state_dict`/`model` mapping of tensors are
 * accepted; any object graph outside that shape is rejected.
 */
export function loadTorchCheckpoint(bytes: Uint8Array): TorchCheckpoint {
  const members = readZip(bytes);
  const pklName = [...members.keys()]
    .filter((name) => name.endsWith("/data.pkl") || name === "data.pkl")
    .sort((a, b) => a.length - b.length)[0];
  if (pklName === undefined) {
    throw new TorchCheckpointError("archive has no data.pkl");
  }
  const prefix = pklName.slice(0, pklName.length - "data.pkl".length);
  const byteorder = members.get(`${prefix}byteorder`);
  if (byteorder !== undefined && new TextDecoder().decode(byteorder).trim() !== "little") {
    throw new TorchCheckpointError("only little-endian checkpoints are supported");
  }
  const root = new Unpickler(members.get(pklName) as Uint8Array).run();
  if (!(root instanceof PDict)) {
    throw new TorchCheckpointError("checkpoint document is not a dict");
  }
  const configValue = dictGet(root, "config");
  const stateValue = dictGet(root, "state_dict") ?? dictGet(root, "model");
  if (!(configValue instanceof PDict)) {
    throw new TorchCheckpointError("checkpoint has no config object");
  }
  if (!(stateValue instanceof PDict)) {
    throw new TorchCheckpointError("checkpoint has no state_dict");
  }
  const config: Record<string, unknown> = {};
  for (const [k, v] of configValue.entries) {
    if (typeof k === "string") config[k] = v as unknown;
  }
  // Resolve storages lazily from archive members.
  const storages = new Map<string, Float32Array>();
  const storageFor = (ref: StorageRef): Float32Array => {
    const cached = storages.get(ref.key);
    if (cached !== undefined) return cached;
    const member = members.get(`${prefix}data/${ref.key}`) ?? members.get(`data/${ref.key}`);
    if (member === undefined) {
      throw new TorchCheckpointError(`storage ${ref.key} missing from archive`);
    }
    const parsed = readStorage(member, ref.dtype, ref.numel);
    storages.set(ref.key, parsed);
    return parsed;
  };
  const tensors = new Map<string, TorchTensor>();
  const pending: [string, TensorRef][] = [];
  const collect = (dict: PDict, path: string): void => {
    for (const [k, v] of dict.entries) {
      const name = path.length > 0 ? `${path}.${String(k)}` : String(k);
      if (v instanceof PDict) {
        collect(v, name);
      } else if (typeof v === "object" && v !== null && (v as TensorRef).kind === "tensor") {
        pending.push([name, v as TensorRef]);
      }
    }
  };
  collect(stateValue, "");
  for (const [name, ref] of pending) {
    storageFor(ref.storage);
    tensors.set(name, materializeTensor(name, ref, storages));
  }
  const metadataValue = dictGet(root, "metadata");
  const metadata: Record<string, unknown> = {};
  if (metadataValue instanceof PDict) {
    for (const [k, v] of metadataValue.entries) {
      if (typeof k === "string") metadata[k] = v as unknown;
    }
  }
  return { config, tensors, metadata };
}
