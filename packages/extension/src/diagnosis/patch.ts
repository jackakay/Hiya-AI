/**
 * Minimal unified-diff applier for model-proposed fixes. Hunks are located by
 * their content (context + removed lines), not trusted line numbers, because
 * models often get the numbers slightly wrong. Whitespace at line ends is
 * ignored when matching. Never touches disk.
 */

type Hunk = { oldStart: number; oldLines: string[]; newLines: string[] };

export type PatchResult = { ok: true; text: string } | { ok: false; error: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = { oldStart: Number(header[1]), oldLines: [], newLines: [] };
      hunks.push(current);
      continue;
    }
    if (!current || raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("\\")) continue;
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === " " || raw === "") {
      // A blank line inside a hunk is an empty context line (some generators drop the space).
      current.oldLines.push(raw === "" ? "" : body);
      current.newLines.push(raw === "" ? "" : body);
    } else if (tag === "-") current.oldLines.push(body);
    else if (tag === "+") current.newLines.push(body);
  }
  // Trailing blank "context" from a diff ending in a newline isn't real.
  for (const h of hunks) {
    while (h.oldLines.length && h.newLines.length && h.oldLines.at(-1) === "" && h.newLines.at(-1) === "") {
      h.oldLines.pop();
      h.newLines.pop();
    }
  }
  return hunks.filter((h) => h.oldLines.length || h.newLines.length);
}

const norm = (s: string) => s.replace(/\s+$/, "");

function findBlock(lines: string[], block: string[], near: number, from: number): number {
  if (block.length === 0) return Math.min(Math.max(near, from), lines.length);
  const matchesAt = (i: number) => block.every((b, j) => lines[i + j] !== undefined && norm(lines[i + j]!) === norm(b));
  // Search outward from the claimed position, never before the previous hunk.
  // The claimed position may even be past the end of the file, so search far enough back.
  const maxDistance = Math.max(near, lines.length - near) + 1;
  for (let d = 0; d <= maxDistance; d++) {
    for (const i of d === 0 ? [near] : [near - d, near + d]) {
      if (i >= from && i + block.length <= lines.length && matchesAt(i)) return i;
    }
  }
  return -1;
}

export function applyPatch(original: string, diff: string): PatchResult {
  const hunks = parseHunks(diff);
  if (!hunks.length) return { ok: false, error: "The diff has no hunks." };
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  let cursor = 0;
  let offset = 0;
  for (const [n, h] of hunks.entries()) {
    const at = findBlock(lines, h.oldLines, Math.max(0, h.oldStart - 1 + offset), cursor);
    if (at < 0) return { ok: false, error: `Hunk ${n + 1} doesn't match the current file (it may have changed since the diagnosis).` };
    lines.splice(at, h.oldLines.length, ...h.newLines);
    cursor = at + h.newLines.length;
    offset += h.newLines.length - h.oldLines.length;
  }
  return { ok: true, text: lines.join(eol) };
}
