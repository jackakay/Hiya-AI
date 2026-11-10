/**
 * Just enough source-map support to turn a browser stack frame in
 * Vite-transformed code (http://localhost:5173/src/App.tsx:42:13) back into
 * the original file and line. Vite dev serves inline base64 source maps.
 */

export type RawSourceMap = { version: number; sources: string[]; mappings: string; sourceRoot?: string };
type Segment = [genCol: number, src: number, line: number, col: number];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Decodes one VLQ group (e.g. "AAgBC") into numbers. */
export function decodeVlq(group: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of group) {
    const digit = B64_INDEX.get(ch);
    if (digit === undefined) throw new Error(`bad VLQ character ${ch}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return out;
}

/** Mappings per generated line (0-based), absolute values. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let src = 0;
  let line = 0;
  let col = 0;
  for (const lineText of mappings.split(";")) {
    let genCol = 0;
    const segs: Segment[] = [];
    for (const group of lineText.split(",")) {
      if (!group) continue;
      const v = decodeVlq(group);
      genCol += v[0]!;
      if (v.length >= 4) {
        src += v[1]!;
        line += v[2]!;
        col += v[3]!;
        segs.push([genCol, src, line, col]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

export type OriginalPosition = { source: string; line: number; column: number };

/** Maps a 1-based generated line and column to the original position, if mapped. */
export function originalPosition(map: RawSourceMap, line: number, column: number, decoded = decodeMappings(map.mappings)): OriginalPosition | undefined {
  const segs = decoded[line - 1];
  if (!segs?.length) return undefined;
  // The last segment that starts at or before the column.
  let best: Segment | undefined;
  for (const s of segs) {
    if (s[0] <= column - 1) best = s;
    else break;
  }
  best ??= segs[0];
  const source = map.sources[best![1]];
  if (source === undefined) return undefined;
  return { source: (map.sourceRoot ?? "") + source, line: best![2] + 1, column: best![3] + 1 };
}

/** Extracts an inline `//# sourceMappingURL=data:application/json;base64,…` map from module text. */
export function inlineSourceMap(code: string): RawSourceMap | undefined {
  const m = /\/\/[#@] sourceMappingURL=data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code);
  if (!m) return undefined;
  try {
    const map = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as RawSourceMap;
    return Array.isArray(map.sources) && typeof map.mappings === "string" ? map : undefined;
  } catch {
    return undefined;
  }
}

const FRAME_URL = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/[^\s()?]*)(\?[^\s():]*)?:(\d+):(\d+)/g;

/**
 * Rewrites every dev-server URL:line:col in a stack to the original source
 * position. Frames in dependencies (node_modules) are left alone. `fetchText`
 * returns a module's served code, or undefined.
 */
export async function remapStack(stack: string, fetchText: (url: string) => Promise<string | undefined>): Promise<string> {
  const urls = new Set<string>();
  for (const m of stack.matchAll(FRAME_URL)) if (!/\/node_modules\/|\/@vite\/|\/@react-refresh/.test(m[1]!)) urls.add(m[1]! + (m[2] ?? ""));
  const maps = new Map<string, { map: RawSourceMap; decoded: Segment[][] } | undefined>();
  await Promise.all(
    [...urls].map(async (url) => {
      const code = await fetchText(url).catch(() => undefined);
      const map = code ? inlineSourceMap(code) : undefined;
      maps.set(url, map ? { map, decoded: decodeMappings(map.mappings) } : undefined);
    }),
  );
  return stack.replace(FRAME_URL, (whole, base: string, query: string | undefined, line: string, col: string) => {
    const entry = maps.get(base + (query ?? ""));
    if (!entry) return whole;
    const pos = originalPosition(entry.map, Number(line), Number(col), entry.decoded);
    if (!pos) return whole;
    // Vite's sources are usually absolute file paths; otherwise keep the served URL.
    const file = /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(pos.source) && !pos.source.startsWith("/src/") ? pos.source : base;
    return `${file}:${pos.line}:${pos.column}`;
  });
}
