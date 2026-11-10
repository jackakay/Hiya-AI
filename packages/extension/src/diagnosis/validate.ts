import type { Diagnosis } from "@voice-bug/shared";
import type { SentSource } from "../bundle";
import { applyPatch } from "./patch";

/**
 * Checks a model answer before anything is shown: shape, then that every
 * reference points at something we actually sent. Pure apart from `readFile`.
 */

export type ValidationContext = {
  /** Number of events in the bundle; valid refs are E1..E<eventCount>. */
  eventCount: number;
  sources: readonly SentSource[];
  /** Current file contents, to check the proposed diff still applies. */
  readFile: (absPath: string) => string | undefined;
};

export type ValidatedDiagnosis = {
  diagnosis: Diagnosis;
  /** The root-cause file on disk, when it matched a sent excerpt. */
  rootCauseAbsPath?: string;
  fix?: { absPath: string; original: string; patched: string } | { absPath?: string; stale: true; reason: string };
};

export type ValidationResult = { ok: true; value: ValidatedDiagnosis } | { ok: false; problems: string[] };

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Normalises "./demo-app\\x.ts", "<root>/demo-app/x.ts" etc. to "demo-app/x.ts". */
export function normalizeFile(file: string): string {
  return file
    .trim()
    .replace(/\\/g, "/")
    .replace(/^<root>\//, "")
    .replace(/^\.\//, "");
}

/** Shape check; returns the problems found (empty when the object is a Diagnosis). */
export function shapeProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object") return ["The answer is not a JSON object."];
  const d = value as Record<string, unknown>;
  for (const key of ["title", "summary", "expected", "actual"]) if (!isStr(d[key])) problems.push(`"${key}" must be a string.`);
  for (const key of ["reproSteps", "evidence"]) if (!isStrArray(d[key])) problems.push(`"${key}" must be an array of strings.`);
  const rc = d.rootCause as Record<string, unknown> | undefined;
  if (!rc || typeof rc !== "object") problems.push('"rootCause" is missing.');
  else {
    if (!isStr(rc.file)) problems.push('"rootCause.file" must be a string.');
    if (typeof rc.line !== "number" || !Number.isInteger(rc.line)) problems.push('"rootCause.line" must be an integer.');
    if (!isStr(rc.explanation)) problems.push('"rootCause.explanation" must be a string.');
    if (!["low", "medium", "high"].includes(rc.confidence as string)) problems.push('"rootCause.confidence" must be low, medium or high.');
  }
  if (d.proposedFix !== undefined) {
    const f = d.proposedFix as Record<string, unknown>;
    if (!f || !isStr(f.file) || !isStr(f.diff)) problems.push('"proposedFix" must have string "file" and "diff".');
  }
  if (d.followUpQuestion !== undefined && !isStr(d.followUpQuestion)) problems.push('"followUpQuestion" must be a string.');
  return problems;
}

/** Strips comments and whitespace from one line of code (JS/TS/Python-style comments). */
function codeOnly(line: string): string {
  return line
    .replace(/\/\*.*?\*\//g, "")
    .replace(/(^|\s)(\/\/|#).*$/, "$1")
    .replace(/^\s*\*.*$/, "")
    .replace(/\s+/g, "");
}

/** True when a diff changes no code: only comments, blank lines or whitespace. */
export function isCosmeticDiff(diff: string): boolean {
  const removed: string[] = [];
  const added: string[] = [];
  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("-")) removed.push(codeOnly(raw.slice(1)));
    else if (raw.startsWith("+")) added.push(codeOnly(raw.slice(1)));
  }
  if (!removed.length && !added.length) return true;
  return removed.filter(Boolean).join("\n") === added.filter(Boolean).join("\n");
}

export function validateDiagnosis(raw: string, ctx: ValidationContext): ValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ["The answer is not valid JSON."] };
  }
  const shape = shapeProblems(value);
  if (shape.length) return { ok: false, problems: shape };
  const diagnosis = value as Diagnosis;
  const problems: string[] = [];

  // Every E<n> mentioned must exist.
  const mentioned = [diagnosis.evidence.join(" "), diagnosis.summary, diagnosis.actual, diagnosis.rootCause.explanation].join(" ");
  for (const m of mentioned.matchAll(/\bE(\d+)\b/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > ctx.eventCount) problems.push(`Event reference E${n} does not exist (the bundle has E1–E${ctx.eventCount}).`);
  }

  // The root cause must point into an excerpt we sent.
  const rcFile = normalizeFile(diagnosis.rootCause.file);
  let rootCauseAbsPath: string | undefined;
  if (rcFile) {
    const excerpts = ctx.sources.filter((s) => s.file === rcFile);
    if (!excerpts.length) {
      const sent = ctx.sources.map((s) => s.file).join(", ") || "none";
      problems.push(`"rootCause.file" (${diagnosis.rootCause.file}) is not one of the files in the Source section (${sent}).`);
    } else if (!excerpts.some((s) => diagnosis.rootCause.line >= s.from && diagnosis.rootCause.line <= s.to)) {
      problems.push(`"rootCause.line" ${diagnosis.rootCause.line} is outside the excerpt shown for ${rcFile}.`);
    } else {
      rootCauseAbsPath = excerpts[0]!.absPath;
      diagnosis.rootCause.file = rcFile;
    }
  } else if (ctx.sources.length) {
    problems.push('"rootCause.file" is empty although source excerpts were provided.');
  }

  if (diagnosis.proposedFix && isCosmeticDiff(diagnosis.proposedFix.diff)) {
    problems.push(
      '"proposedFix" only adds or changes comments/whitespace. Give a code change that actually fixes the bug (every file in the Source section is shown in full when small, so you can edit imports and declarations too), or omit proposedFix.',
    );
  }

  if (problems.length) return { ok: false, problems: [...new Set(problems)] };

  // A fix that doesn't apply is shown as stale rather than re-asked.
  let fix: ValidatedDiagnosis["fix"];
  if (diagnosis.proposedFix) {
    const fixFile = normalizeFile(diagnosis.proposedFix.file);
    const source = ctx.sources.find((s) => s.file === fixFile);
    const original = source ? ctx.readFile(source.absPath) : undefined;
    if (!source || original === undefined) {
      fix = { stale: true, reason: `The fix targets ${diagnosis.proposedFix.file}, which wasn't in the bundle.` };
    } else {
      diagnosis.proposedFix.file = fixFile;
      const patched = applyPatch(original, diagnosis.proposedFix.diff);
      fix = patched.ok ? { absPath: source.absPath, original, patched: patched.text } : { absPath: source.absPath, stale: true, reason: patched.error };
    }
  }

  return { ok: true, value: { diagnosis, rootCauseAbsPath, fix } };
}
