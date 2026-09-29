/**
 * Deterministic detectors for rules whose answer is syntactic. A rule that
 * names a `detector` is decided here, locally, and never sent to a model.
 * Detectors see only the unit's patch, like the model would, and stay silent
 * when the evidence is incomplete.
 */

export const DETECTORS = ["empty-catch"] as const;
export type DetectorName = (typeof DETECTORS)[number];

export interface DetectorHit {
  /** 1-based line on the side named by `side`. */
  readonly line: number;
  readonly side: "after";
}

interface PatchLine { readonly tag: " " | "+" | "-"; readonly text: string; readonly newLine: number }

/** Body lines of every hunk in a unit patch. Header lines and "\ No newline" markers are dropped. */
function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let inHunk = false;
  let newLine = 0;
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) { inHunk = true; newLine = Number(header[1]); continue; }
    if (!inHunk || line.startsWith("\\")) continue;
    const tag = line[0];
    if (tag !== " " && tag !== "+" && tag !== "-") continue;
    lines.push({ tag, text: line.slice(1), newLine: tag === "-" ? newLine : newLine++ });
  }
  return lines;
}

/**
 * Replace comment, string, template, and regex text with spaces, keeping
 * newlines and offsets. Heuristic: a fragment that starts inside a comment or
 * string is masked from its first delimiter, which is why callers also require
 * the `} catch` shape before reporting.
 */
export function maskSource(source: string): string {
  const out = source.split("");
  let i = 0;
  let previous = "";
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop); i = stop; continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      let k = i + 1;
      while (k < source.length && source[k] !== c) {
        if (source[k] === "\\") k++;
        else if (c !== "`" && source[k] === "\n") break;
        k++;
      }
      blank(i + 1, k); i = k + 1; previous = c; continue;
    }
    if (c === "/" && (previous === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous))) {
      let k = i + 1;
      let inClass = false;
      while (k < source.length && source[k] !== "\n" && (inClass || source[k] !== "/")) {
        if (source[k] === "\\") k++;
        else if (source[k] === "[") inClass = true;
        else if (source[k] === "]") inClass = false;
        k++;
      }
      if (source[k] === "/") { blank(i + 1, k); i = k + 1; previous = "/"; continue; }
    }
    if (!/\s/.test(c)) previous = c;
    i++;
  }
  return out.join("");
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** No executable statement in the body. */
  readonly empty: boolean;
  /** The body carries a comment that is not only a lint or coverage directive. */
  readonly explained: boolean;
}

const DIRECTIVE = /^(?:eslint|@ts-|istanbul|c8|v8|biome-ignore|prettier-ignore|jshint|tslint)\b/;

/** True when some comment in an empty body says something beyond a tool directive. */
function explains(body: string): boolean {
  const comments = body.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
  return comments.some(comment => {
    const text = comment.replace(/^\/\/|^\/\*|\*\/$/g, "").replace(/^[\s*]+/, "").trim();
    return text.length > 0 && !DIRECTIVE.test(text);
  });
}

/** Complete `} catch (...) { ... }` blocks in one side, as spans of patch-line indexes. */
function catchBlocks(lines: readonly PatchLine[], side: "before" | "after"): Span[] {
  const indexes: number[] = [];
  lines.forEach((line, index) => { if (line.tag === " " || line.tag === (side === "after" ? "+" : "-")) indexes.push(index); });
  const source = indexes.map(index => lines[index]!.text).join("\n");
  const masked = maskSource(source);
  const lineStarts = [0];
  for (let k = 0; k < source.length; k++) if (source[k] === "\n") lineStarts.push(k + 1);
  const lineAt = (offset: number): number => {
    let low = 0, high = lineStarts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (lineStarts[mid]! <= offset) low = mid; else high = mid - 1; }
    return indexes[low]!;
  };
  const spans: Span[] = [];
  const keyword = /\bcatch\b/g;
  for (let match = keyword.exec(masked); match !== null; match = keyword.exec(masked)) {
    // Only a try statement's catch: the previous code token closes the try block.
    const before = masked.slice(0, match.index).trimEnd();
    if (!before.endsWith("}")) continue;
    let k = match.index + 5;
    while (k < masked.length && /\s/.test(masked[k]!)) k++;
    if (masked[k] === "(") {
      let depth = 0;
      for (; k < masked.length; k++) {
        if (masked[k] === "(") depth++;
        else if (masked[k] === ")" && --depth === 0) break;
      }
      if (k >= masked.length) continue;
      k++;
      while (k < masked.length && /\s/.test(masked[k]!)) k++;
    }
    if (masked[k] !== "{") continue;
    const open = k;
    let depth = 0;
    for (; k < masked.length; k++) {
      if (masked[k] === "{") depth++;
      else if (masked[k] === "}" && --depth === 0) break;
    }
    // An incomplete body is not evidence either way.
    if (k >= masked.length) continue;
    const empty = /^[\s;]*$/.test(masked.slice(open + 1, k));
    spans.push({
      start: lineAt(match.index),
      end: lineAt(k),
      text: masked.slice(match.index, k + 1).replace(/\s+/g, ""),
      empty,
      explained: empty && explains(source.slice(open + 1, k)),
    });
  }
  return spans;
}

/**
 * Catch blocks this change leaves swallowing errors silently:
 * - a new catch with an empty body and no explanatory comment, unless it only
 *   moved (an identical empty catch was removed elsewhere in the unit);
 * - an existing catch emptied by removing its last executable statement,
 *   whatever comments remain.
 * An explained new catch (`catch { // already exited }`) is deliberate, as in
 * ESLint's no-empty; a lint-disable directive alone is not an explanation.
 */
export function detectNewEmptyCatch(patch: string): DetectorHit[] {
  const lines = patchLines(patch);
  const afterAll = catchBlocks(lines, "after");
  const after = afterAll.filter(span => span.empty);
  if (after.length === 0) return [];
  const before = catchBlocks(lines, "before");
  // Each run of changed lines is one region; a rewritten catch line puts the
  // old and new catch on different patch lines of the same region.
  const region: (number | undefined)[] = [];
  lines.forEach((line, index) => {
    region.push(line.tag === " " ? undefined : index > 0 && region[index - 1] !== undefined ? region[index - 1] : index);
  });
  // Patch lines interleave both sides, so ranges say nothing; the same catch
  // keeps its `catch` keyword on one unchanged line.
  const same = (a: Span, b: Span): boolean => a.start === b.start;
  const sharesRegion = (old: Span, span: Span): boolean =>
    region[old.start] !== undefined && region[old.start] === region[span.start];
  /** The before-side catch this one rewrites: an overlapping one, else the only one in its changed region. */
  const previousOf = (span: Span): Span | undefined => {
    const kept = before.find(old => same(old, span));
    if (kept) return kept;
    const candidates = before.filter(old => sharesRegion(old, span));
    const peers = afterAll.filter(other => !same(other, span) && sharesRegion(span, other));
    return candidates.length === 1 && peers.length === 0 ? candidates[0] : undefined;
  };
  const removed = before.filter(span => span.empty && lines.slice(span.start, span.end + 1).some(line => line.tag === "-"));
  const moved = new Map<string, number>();
  const hits: DetectorHit[] = [];
  for (const span of after) {
    const touched = lines.slice(span.start, span.end + 1).some(line => line.tag !== " ");
    if (!touched) continue;
    // An identical empty catch removed elsewhere means it only moved.
    const available = removed.filter(old => old.text === span.text && !same(old, span)).length;
    const used = moved.get(span.text) ?? 0;
    if (used < available) { moved.set(span.text, used + 1); continue; }
    const previous = previousOf(span);
    // Reformatting or re-commenting an already empty catch is not new.
    if (previous ? previous.empty : span.explained) continue;
    hits.push({ line: Math.max(1, lines[span.start]!.newLine), side: "after" });
  }
  return hits;
}

export function runDetector(name: DetectorName, patch: string): DetectorHit[] {
  switch (name) {
    case "empty-catch": return detectNewEmptyCatch(patch);
  }
}
