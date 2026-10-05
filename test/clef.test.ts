import { describe, expect, test } from "bun:test";
import { clefEndpoint, clefRequestSchema, unwrapClefResponse } from "../src/clef.ts";
import { IMAGE_LIMITS, imageSchema } from "../src/images.ts";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

function pngChunk(name: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(name, 4);
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE(~crc >>> 0, chunk.length - 4);
  return chunk;
}

function pngDimensions(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  const data = deflateSync(Buffer.alloc((1 + Math.ceil(width / 8)) * height));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", data), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngFileBytes(bytes: number): { content_type: "image/png"; base64: string } {
  const original = Buffer.from(image.base64, "base64");
  const padding = pngChunk("npAD", Buffer.alloc(bytes - original.length - 12));
  return { content_type: "image/png", base64: Buffer.concat([original.subarray(0, -12), padding, original.subarray(-12)]).toString("base64") };
}

const request = {
  model: "clef",
  state: "Checkout is unavailable.",
  questions: { urgent: { type: "noul" as const, instructions: "Is this urgent?" } },
};
const answer = {
  model: "clef",
  answers: { urgent: { type: "noul" as const, noul: 0.99 } },
  usage: { input_tokens: 30, output_tokens: 0 },
};
const image = { content_type: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=" };

describe("Cloudflare Clef contract", () => {
  test("recorded fixtures have only repository-local or builtin imports", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const portable = (source: string): boolean => {
      const paths = [
        ...transpiler.scanImports(source).map(({ path }) => path),
        ...Array.from(source.matchAll(/\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g), match => match[1]!),
      ];
      return paths.every(path => {
        if (path === "bun:test" || path.startsWith("node:")) return true;
        if (!path.startsWith(".")) return false;
        const target = relative(root, fileURLToPath(new URL(path, import.meta.url)));
        return target !== ".." && !target.startsWith(`..${sep}`) && !isAbsolute(target) && !target.split(sep).includes(".devin");
      });
    };
    expect(portable(readFileSync(new URL(import.meta.url), "utf8"))).toBe(true);
    expect(portable('import "./fixtures/synthetic-clef.json";')).toBe(true);
    for (const path of ["../../.devin/live-clef-evidence.json", "../.devin/live-clef-evidence.json", "../../algal/src/index.ts", "../../jungle/package.json"]) {
      for (const source of [`import ${JSON.stringify(path)};`, `import(${JSON.stringify(path)});`, `require(${JSON.stringify(path)});`]) {
        expect(transpiler.scanImports(source)).toHaveLength(1);
        expect(portable(source)).toBe(false);
      }
      expect(portable(`readFileSync(new URL(${JSON.stringify(path)}, import.meta.url), "utf8");`)).toBe(false);
    }
  });

  test("constructs a fixed-origin account and model endpoint", () => {
    expect(clefEndpoint("a".repeat(32), "clef")).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/run/@cf/cloudflare/clef`);
    expect(clefEndpoint("a".repeat(32), "clef-flash")).toEndWith("/clef-flash");
    expect(() => clefEndpoint("../other", "clef")).toThrow();
    expect(() => clefEndpoint("a".repeat(32), "jev" as "clef")).toThrow();
  });

  test("preserves embedded image objects and data URLs", () => {
    expect(clefRequestSchema.parse({ ...request, images: [image] }).images).toEqual([image]);
    const url = `data:image/png;base64,${image.base64}`;
    expect(clefRequestSchema.parse({ ...request, images: [url] }).images).toEqual([url]);
  });

  test("rejects remote URLs, malformed base64, unsupported MIME and excess images", () => {
    for (const images of [["https://example.com/image.png"], [{ ...image, base64: "not-base64" }], [{ ...image, content_type: "image/svg+xml" }], Array(5).fill(image)]) {
      expect(clefRequestSchema.safeParse({ ...request, images }).success).toBe(false);
    }
  });

  test("enforces decoded file-byte limits independently of encoded size and pixel buffers", () => {
    const exact = pngFileBytes(IMAGE_LIMITS.maxImageBytes);
    expect(exact.base64.length).toBeGreaterThan(IMAGE_LIMITS.maxImageBytes);
    expect(clefRequestSchema.safeParse({ ...request, images: [exact, exact] }).success).toBe(true);
    expect(clefRequestSchema.safeParse({ ...request, images: [pngFileBytes(IMAGE_LIMITS.maxImageBytes + 1)] }).success).toBe(false);
    const largePixels = pngDimensions(4000, 4000);
    expect(largePixels.length).toBeLessThan(IMAGE_LIMITS.maxImageBytes);
    expect(imageSchema.safeParse({ ...image, base64: largePixels.toString("base64") }).success).toBe(true);
    expect(imageSchema.safeParse({ ...image, base64: pngDimensions(4001, 4000).toString("base64") }).success).toBe(false);
  });

  test("rejects individually valid images exceeding the aggregate file-byte limit", () => {
    const large = pngFileBytes(3 * 1024 * 1024);
    expect(imageSchema.safeParse(large).success).toBe(true);
    expect(clefRequestSchema.safeParse({ ...request, images: [large, large, large] }).success).toBe(false);
  });

  test("rejects noncanonical padding bits, whitespace and extra padding", () => {
    for (const base64 of [image.base64.replace(/I=$/, "J="), ` ${image.base64}`, image.base64 + "="]) {
      expect(imageSchema.safeParse({ ...image, base64 }).success).toBe(false);
    }
  });

  test("enforces Cloudflare question IDs and required nonempty instructions", () => {
    expect(clefRequestSchema.safeParse({ ...request, questions: { "bad id": request.questions.urgent } }).success).toBe(false);
    expect(clefRequestSchema.safeParse({ ...request, questions: { urgent: { type: "noul" as const } } }).success).toBe(false);
    for (const instructions of [null, "", "  ", {}, []]) {
      expect(clefRequestSchema.safeParse({ ...request, questions: { urgent: { type: "noul" as const, instructions } } }).success).toBe(false);
    }
  });

  test("unwraps successful REST envelopes and accepts binding responses", () => {
    expect(unwrapClefResponse(request, { success: true, result: answer, errors: [], messages: [] })).toEqual(answer);
    expect(unwrapClefResponse(request, answer)).toEqual(answer);
  });

  test("accepts the 2026-10-04 synthetic recordings for both Clef aliases as parser evidence, not quality evidence", () => {
    const questions = {
      urgent: { type: "noul" as const, instructions: "Is this urgent?" },
      team: { type: "choice" as const, instructions: "Choose a team", criteria: { technical: "Technical", sales: "Sales" } },
      severity: { type: "score" as const, instructions: "Rate severity", criteria: ["No impact", "Minor", "Major", "Critical"] },
    };
    for (const record of [
      { model: "clef", noul: 0.9869, technical: 0.9635, sales: 0.0365, teamConfidence: 0.8593, score: 2.931, probabilities: [0.0047, 0.0051, 0.0448, 0.9454], scoreConfidence: 0.8612 },
      { model: "clef-flash", noul: 0.9354, technical: 0.9724, sales: 0.0276, teamConfidence: 0.8928, score: 2.7378, probabilities: [0.0149, 0.0157, 0.186, 0.7834], scoreConfidence: 0.5316 },
    ]) {
      const input = { model: record.model, state: "synthetic text", questions };
      const response = { model: record.model, usage: { input_tokens: 319, output_tokens: 0 }, answers: {
        urgent: { type: "noul", noul: record.noul },
        team: { type: "choice", choice: "technical", probabilities: { technical: record.technical, sales: record.sales }, confidence: record.teamConfidence },
        severity: { type: "score", score: record.score, legend: Object.fromEntries(questions.severity.criteria.map((criterion, level) => [String(level), criterion])), probabilities: Object.fromEntries(record.probabilities.map((probability, level) => [String(level), probability])), confidence: record.scoreConfidence },
      } };
      expect(unwrapClefResponse(input, { success: true, result: response, errors: [], messages: [] })).toEqual(response);
    }
    for (const record of [
      { model: "clef", first: [0.9946, 0.0054], second: [0.0173, 0.9827], confidence: [0.9784, 0.9322] },
      { model: "clef-flash", first: [0.9765, 0.0235], second: [0.0168, 0.9832], confidence: [0.9082, 0.9337] },
    ]) {
      const question = { type: "choice" as const, instructions: "Choose the image color", criteria: { red: "Red", blue: "Blue" } };
      const input = { model: record.model, state: "synthetic images", questions: { first: question, second: question } };
      const response = { model: record.model, usage: { input_tokens: 340, output_tokens: 0 }, answers: {
        first: { type: "choice", choice: "red", probabilities: { red: record.first[0], blue: record.first[1] }, confidence: record.confidence[0] },
        second: { type: "choice", choice: "blue", probabilities: { red: record.second[0], blue: record.second[1] }, confidence: record.confidence[1] },
      } };
      expect(unwrapClefResponse(input, response)).toEqual(response);
    }
  });

  test("rejects ambiguous envelopes and extra decision fields", () => {
    for (const value of [
      { success: true, result: answer, errors: [{ code: 1000, message: "private-body" }] },
      { success: true, result: answer, messages: "private-body" },
      { success: true, result: answer, unexpected: "private-body" },
      { ...answer, unexpected: "private-body" },
      { ...answer, answers: { urgent: { ...answer.answers.urgent, unexpected: "private-body" } } },
      { ...answer, usage: { ...answer.usage, unexpected: "private-body" } },
    ]) {
      expect(() => unwrapClefResponse(request, value)).toThrow("Invalid Cloudflare Clef response");
    }
    expect(() => unwrapClefResponse({ ...request, model: undefined }, { ...answer, model: "jev" })).toThrow("Invalid Cloudflare Clef response");
  });

  test("accepts only jointly normalized probability intervals and weighted scores", () => {
    const input = { model: "clef", state: null, questions: { severity: { type: "score" as const, instructions: "Rate severity", criteria: ["low", "medium", "high"] } } };
    const response = { ...answer, answers: { severity: { type: "score", score: 1, legend: { "0": "low", "1": "medium", "2": "high" }, probabilities: { "0": 0.333, "1": 0.333, "2": 0.333 }, confidence: 0 } } };
    expect(unwrapClefResponse(input, response)).toEqual(response);
    for (const override of [
      { score: 1.01 },
      { score: 1.001, probabilities: { "0": 0.334, "1": 0.334, "2": 0.333 } },
      { score: 1, probabilities: { "0": 0.33, "1": 0.33, "2": 0.33 } },
      { legend: { "0": "different", "1": "medium", "2": "high" } },
    ]) {
      expect(() => unwrapClefResponse(input, { ...response, answers: { severity: { ...response.answers.severity, ...override } } })).toThrow("Invalid Cloudflare Clef response");
    }
  });

  test("rounding a normalized distribution and its weighted mean preserves consistency", () => {
    let seed = 20261004;
    for (let levels = 2; levels <= 10; levels++) {
      for (let sample = 0; sample < 8; sample++) {
        const masses = Array.from({ length: levels }, () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) + 1; });
        const total = masses.reduce((sum, mass) => sum + mass, 0);
        const criteria = masses.map((_, level) => `level ${level}`);
        const probabilities = Object.fromEntries(masses.map((mass, level) => [String(level), Number((mass / total).toFixed(3))]));
        const score = Number(masses.reduce((sum, mass, level) => sum + level * mass / total, 0).toFixed(3));
        const input = { model: "clef", state: null, questions: { q: { type: "score" as const, instructions: "Rate the state", criteria } } };
        const response = { ...answer, answers: { q: { type: "score", score, legend: Object.fromEntries(criteria.map((criterion, level) => [String(level), criterion])), probabilities, confidence: 0 } } };
        expect(unwrapClefResponse(input, response)).toEqual(response);
      }
    }
  });

  test("rejects failed, mismatched and malformed envelopes without leaking content", () => {
    for (const value of [{ success: false, result: answer, errors: [{ message: "private-body" }] }, { success: true, result: { ...answer, answers: {} } }, { ...answer, model: "clef-flash" }, { success: true, result: null }]) {
      expect(() => unwrapClefResponse(request, value)).toThrow("Invalid Cloudflare Clef response");
      try { unwrapClefResponse(request, value); } catch (error) { expect(String(error)).not.toContain("private-body"); }
    }
  });
});
