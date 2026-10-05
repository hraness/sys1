import { z } from "zod";

export const IMAGE_LIMITS = {
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalImageBytes: 8 * 1024 * 1024,
  maxBodyBytes: 13 * 1024 * 1024,
  maxPixels: 16_000_000,
} as const;

const maxBase64 = Math.ceil(IMAGE_LIMITS.maxImageBytes / 3) * 4;
const base64Schema = z.string().min(4).max(maxBase64).refine(
  (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
  "image must contain valid base64",
);
const objectSchema = z.object({ content_type: z.enum(["image/png", "image/jpeg", "image/webp"]), base64: base64Schema }).strict();
const urlSchema = z.string().max(maxBase64 + 32).refine((value) => {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i.exec(value);
  return match !== null && base64Schema.safeParse(match[2]).success;
}, "image must be an embedded PNG, JPEG or WebP data URL");

function parts(image: z.infer<typeof objectSchema> | string): { content_type: string; base64: string } {
  if (typeof image !== "string") return image;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i.exec(image);
  if (match === null) throw new Error();
  return { content_type: match[1]!.toLowerCase(), base64: match[2]! };
}

export function imageDecodedBytes(image: ImageInput): number {
  const value = parts(image).base64;
  return value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return ~value >>> 0;
}

function dimensions(bytes: Uint8Array, mime: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, length = 4): string => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (mime === "image/png") {
    if (bytes.length < 45 || tag(0, 8) !== "\x89PNG\r\n\x1a\n" || view.getUint32(8) !== 13 || tag(12) !== "IHDR") throw new Error();
    if (crc32(bytes.subarray(12, 29)) !== view.getUint32(29)) throw new Error();
    const width = view.getUint32(16), height = view.getUint32(20);
    const depth = bytes[24]!, color = bytes[25]!;
    if (!({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>)[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) throw new Error();
    let data = false;
    for (let offset = 33; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), name = tag(offset + 4);
      if (size > bytes.length - offset - 12 || name === "IHDR" || !/^[A-Za-z]{4}$/.test(name)) throw new Error();
      if (name === "IDAT" && size > 0) data = true;
      offset += size + 12;
      if (name === "IEND") {
        if (size !== 0 || offset !== bytes.length || !data) throw new Error();
        return [width, height];
      }
    }
    throw new Error();
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 12 || view.getUint16(0) !== 0xffd8 || view.getUint16(bytes.length - 2) !== 0xffd9) throw new Error();
    let result: [number, number] | undefined;
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) throw new Error();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0x00) throw new Error();
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || result !== undefined || bytes[offset + 2] !== 8 || length !== 8 + 3 * bytes[offset + 7]!) throw new Error();
        result = [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      if (marker === 0xda) {
        if (result === undefined || offset + length >= bytes.length - 2) throw new Error();
        return result;
      }
      offset += length;
    }
    throw new Error();
  }
  if (bytes.length < 26 || tag(0) !== "RIFF" || tag(8) !== "WEBP" || view.getUint32(4, true) !== bytes.length - 8) throw new Error();
  let result: [number, number] | undefined;
  let data = false;
  const uint24 = (offset: number): number => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (size > bytes.length - start) throw new Error();
    if (name === "VP8X") {
      if (size !== 10 || result !== undefined || bytes[start]! & 0xc1 || bytes[start + 1] !== 0 || bytes[start + 2] !== 0 || bytes[start + 3] !== 0) throw new Error();
      result = [1 + uint24(start + 4), 1 + uint24(start + 7)];
    } else if (name === "VP8 ") {
      if (size <= 10 || data || bytes[start]! & 1 || tag(start + 3, 3) !== "\x9d\x01\x2a") throw new Error();
      const actual: [number, number] = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
      if (result !== undefined && (result[0] !== actual[0] || result[1] !== actual[1])) throw new Error();
      result = actual;
      data = true;
    } else if (name === "VP8L") {
      if (size <= 5 || data || bytes[start] !== 0x2f) throw new Error();
      const bits = view.getUint32(start + 1, true);
      if (bits >>> 29 !== 0) throw new Error();
      const actual: [number, number] = [(bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1];
      if (result !== undefined && (result[0] !== actual[0] || result[1] !== actual[1])) throw new Error();
      result = actual;
      data = true;
    }
    offset = start + size + (size & 1);
    if (offset === bytes.length && data && result !== undefined) return result;
  }
  throw new Error();
}

export const imageSchema = z.union([objectSchema, urlSchema]).refine((image) => {
  try {
    if (imageDecodedBytes(image) > IMAGE_LIMITS.maxImageBytes) return false;
    const { base64, content_type } = parts(image);
    const binary = atob(base64);
    if (btoa(binary) !== base64) return false;
    const [width, height] = dimensions(Uint8Array.from(binary, (value) => value.charCodeAt(0)), content_type);
    return width > 0 && height > 0 && width * height <= IMAGE_LIMITS.maxPixels;
  } catch { return false; }
}, "image must have a valid matching PNG, JPEG or WebP header, at most 4 MiB and 16 megapixels");
export type ImageInput = z.infer<typeof imageSchema>;
export const imagesSchema = z.array(imageSchema).max(IMAGE_LIMITS.maxImages).refine(
  (images) => {
    try { return images.reduce((total, image) => total + imageDecodedBytes(image), 0) <= IMAGE_LIMITS.maxTotalImageBytes; }
    catch { return false; }
  },
  "images exceed 8 MiB total",
);
