import path from "node:path";
import type { BackendLinePayload, ConsolePayload, ErrorPayload, Event, NetworkPayload } from "@voice-bug/shared";
import { describe } from "./format";
import { redact, type RedactOptions } from "./redact";
import { isInternalFrame, isStackLine, parseStack, parseStackLine, type StackFrame } from "./stack";

/**
 * Turns a frozen snapshot of captured events into the text that will be sent
 * to the model (milestone 5). Pure apart from the injected `readFile`.
 */

export type BundleInput = {
  /** Snapshot from EventStore, sorted by ts. */
  events: Event[];
  /** When the bundle was requested. */
  now: number;
  windowMs: number;
  /** Pages that connected (from SDK hello messages). */
  pages?: string[];
  /** Directories source files may be read from; the first is the repo root. Nothing outside them is read. */
  roots: string[];
  /** Returns the file's text, or undefined if it doesn't exist / can't be read. */
  readFile: (absPath: string) => string | undefined;
  /** Output of `git diff`, if available. */
  gitDiff?: string;
  /** Code lines mentioning the request paths involved (see `searchTerms`), found by the caller. */
  related?: Array<{ absPath: string; line: number; term: string }>;
  /** Screenshots taken in the window, newest last; only metadata goes into the text. */
  screenshots?: Array<{ ts: number; reason: string }>;
  redact?: RedactOptions;
};

export type Bundle = {
  text: string;
  /** Ref of the error the bundle is centred on, e.g. "E12". */
  anchorRef?: string;
  eventCount: number;
  errorCount: number;
  /** Files (relative to the repo root) with a source excerpt. */
  sourceFiles: string[];
  /** The excerpts that were included, so an answer can be checked against what the model saw. */
  sources: SentSource[];
  redactions: number;
};

export type SentSource = {
  /** Relative to the repo root, forward slashes. */
  file: string;
  absPath: string;
  /** Inclusive line range shown. */
  from: number;
  to: number;
  /** The stack-frame line that was marked. */
  line: number;
};

export const CONTEXT_LINES = 20;
const RELATED_CONTEXT_LINES = 12;
const MAX_SOURCE_FILES = 3;
/** Most recent lines kept; older ones rarely matter and every line is input the model must read. */
const MAX_TIMELINE_LINES = 150;
const MAX_DIFF_CHARS = 6000;

const BACKEND_ERROR = /\b[A-Z]\w*(?:Error|Exception)\b|^\s*(?:Error|Unhandled|Uncaught|FATAL|panic)\b/;

/** Whether an event is evidence that something went wrong. */
export function isErrorEvent(event: Event): boolean {
  switch (event.source) {
    case "console":
      return ["uncaught-error", "unhandled-rejection", "resource-error", "error"].includes(event.type);
    case "network": {
      const p = event.payload as NetworkPayload;
      return (p.status !== undefined && p.status >= 400) || (p.error !== undefined && p.error !== "aborted");
    }
    case "backend": {
      if (event.type !== "stderr" && event.type !== "stdout") return false;
      const line = (event.payload as BackendLinePayload).line;
      return !isStackLine(line) && BACKEND_ERROR.test(line);
    }
    default:
      return false;
  }
}

/**
 * Request paths worth searching the code for, as stable prefixes:
 * "/api/notes/0" → "/api/notes/", "/api/search?q=we" → "/api/search".
 * Failing requests first; with none, the most recent requests.
 */
export function searchTerms(events: readonly Event[], max = 3): string[] {
  const requests = events.filter((e) => e.source === "network" && e.type === "request");
  const failing = requests.filter(isErrorEvent);
  const picked = (failing.length ? failing : requests).slice().reverse();
  const terms: string[] = [];
  for (const e of picked) {
    const url = (e.payload as NetworkPayload).url;
    if (!url.startsWith("/")) continue; // only same-origin paths live in this codebase
    const pathOnly = url.split(/[?#]/)[0]!;
    // Cut at the first segment that looks like an id, keeping the slash.
    const m = /^(.*?\/)(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{36})(?:\/|$)/i.exec(pathOnly);
    const term = m ? m[1]! : pathOnly;
    if (term.length >= 4 && term !== "/" && !terms.includes(term)) terms.push(term);
    if (terms.length >= max) break;
  }
  return terms;
}

/** Stack frames carried by an error event. Backend stacks span the lines that follow it. */
export function framesFor(event: Event, events: readonly Event[]): StackFrame[] {
  if (event.source === "console") {
    const p = event.payload as ErrorPayload & Partial<ConsolePayload>;
    return parseStack(p.stack ?? p.message ?? "");
  }
  if (event.source === "backend") {
    const frames: StackFrame[] = [];
    // With a debug id, only lines from the same request count, so concurrent
    // requests' output can't interleave into this stack.
    const sameStream = events.filter((e) => e.source === "backend" && e.type === event.type && e.debugId === event.debugId);
    for (let i = sameStream.indexOf(event) + 1; i < sameStream.length; i++) {
      const line = (sameStream[i]!.payload as BackendLinePayload).line;
      if (!isStackLine(line)) break;
      const frame = parseStackLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }
  return [];
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Maps a frame's file (absolute path, dev-server URL or relative path) to a readable file under one of the roots. */
export function resolveFrameFile(file: string, roots: readonly string[], exists: (p: string) => boolean): string | undefined {
  const candidates: string[] = [];
  if (/^https?:\/\//.test(file)) {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(file).pathname);
    } catch {
      return undefined;
    }
    // Vite serves files outside its root as /@fs/<absolute path>.
    if (pathname.startsWith("/@fs/")) candidates.push(pathname.slice("/@fs/".length));
    else for (const root of roots) candidates.push(path.join(root, pathname));
  } else if (path.isAbsolute(file)) {
    candidates.push(file);
  } else {
    for (const root of roots) candidates.push(path.join(root, file));
  }
  return candidates.map((c) => path.normalize(c)).find((c) => roots.some((r) => isInside(r, c)) && exists(c));
}

function relTime(ts: number, origin: number): string {
  const s = (ts - origin) / 1000;
  return `${s > 0 ? "+" : s < 0 ? "-" : " "}${Math.abs(s).toFixed(3)}s`;
}

/** Markdown code fence that can't be closed early by backticks inside `content`. */
function fence(content: string, lang = ""): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

const LANGS: Record<string, string> = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".cjs": "js", ".vue": "vue", ".svelte": "svelte", ".py": "python", ".go": "go" };

/** Lines line-ctx..line+ctx of `text`, numbered, with the target line marked ">". */
export function excerpt(text: string, line: number, ctx = CONTEXT_LINES): { from: number; to: number; text: string } {
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, line - ctx);
  const to = Math.min(lines.length, line + ctx);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${n === line ? ">" : " "} ${String(n).padStart(width)} | ${lines[n - 1]}`);
  return { from, to, text: out.join("\n") };
}

/** Files up to this many lines are sent whole, so a fix can touch imports and declarations too. */
export const WHOLE_FILE_LINES = 250;

/**
 * The part of a file to show: all of it when small (a real fix often needs the
 * imports or state declarations at the top, far from the failing line),
 * otherwise ±ctx lines around `line`.
 */
export function sourceWindow(text: string, line: number, ctx: number): ReturnType<typeof excerpt> {
  const count = text.split(/\r?\n/).length;
  return count <= WHOLE_FILE_LINES ? excerpt(text, line, count) : excerpt(text, line, ctx);
}

/**
 * Collapses runs of dependency/runtime frames ("at … node_modules …") into one
 * line, so a 15-frame Express stack shows only the frames in the user's code.
 */
export function compactStackLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let hidden = 0;
  const flush = () => {
    if (hidden) out.push(`    … ${hidden} frame${hidden === 1 ? "" : "s"} in dependencies/runtime`);
    hidden = 0;
  };
  for (const line of lines) {
    const frame = isStackLine(line) ? parseStackLine(line) : undefined;
    if (frame && isInternalFrame(frame)) {
      hidden++;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

type TimelineEntry = { ref?: string; ts: number; text: string };

function timelineFor(events: readonly Event[], refs: Map<Event, string>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let pendingStack: Event[] = [];
  // Same collapsing as compactStackLines, but keeping each surviving frame's ref.
  const flushStack = () => {
    let hidden: Event[] = [];
    const flushHidden = () => {
      if (!hidden.length) return;
      const first = hidden[0]!;
      const n = hidden.length;
      entries.push({ ts: first.ts, text: `${first.source}/${first.type}     … ${n} frame${n === 1 ? "" : "s"} in dependencies/runtime` });
      hidden = [];
    };
    for (const e of pendingStack) {
      const line = (e.payload as BackendLinePayload).line;
      const frame = parseStackLine(line);
      if (frame && isInternalFrame(frame)) {
        hidden.push(e);
        continue;
      }
      flushHidden();
      entries.push({ ref: refs.get(e), ts: e.ts, text: `${e.source}/${e.type} ${line}` });
    }
    flushHidden();
    pendingStack = [];
  };

  for (const e of events) {
    if (e.source === "backend" && (e.type === "stderr" || e.type === "stdout") && isStackLine((e.payload as BackendLinePayload).line)) {
      if (pendingStack.length && (pendingStack[0]!.type !== e.type || pendingStack[0]!.debugId !== e.debugId)) flushStack();
      pendingStack.push(e);
      continue;
    }
    // Interleaved events from other sources don't break a backend stack.
    if (e.source !== "backend") {
      entries.push({ ref: refs.get(e), ts: e.ts, text: lineFor(e) });
      continue;
    }
    flushStack();
    entries.push({ ref: refs.get(e), ts: e.ts, text: lineFor(e) });
  }
  flushStack();
  return entries;
}

function lineFor(e: Event): string {
  let body: string | undefined;
  try {
    body = describe(e);
  } catch {
    body = undefined;
  }
  body ??= JSON.stringify(e.payload);
  // Multi-line console errors carry their own stacks; compact those too.
  const lines = body.split("\n");
  const compact = lines.length > 1 ? [lines[0]!, ...compactStackLines(lines.slice(1).map((l) => l.replace(/^ {4}/, "")))] : lines;
  const id = e.debugId ? ` [${e.debugId}]` : "";
  return `${e.source}/${e.type}${id} ${compact.join("\n    ")}`;
}

export type Chain = {
  debugId: string;
  click?: Event;
  request?: Event;
  /** Everything the server logged while handling the request. */
  backend: Event[];
};

/**
 * The exact click → request → server-log chain for the newest error that
 * carries an X-Debug-Id. Request ↔ logs are linked by the id; click ↔ request
 * by the SDK's actionId (the request started within 1.5s of the click).
 */
export function causalChain(events: readonly Event[]): Chain | undefined {
  const linked = events.filter((e) => isErrorEvent(e) && e.debugId);
  const err = linked[linked.length - 1];
  if (!err?.debugId) return undefined;
  const debugId = err.debugId;
  const request = events.find((e) => e.source === "network" && e.debugId === debugId);
  const actionId = (request?.payload as NetworkPayload | undefined)?.actionId;
  const click = actionId ? events.find((e) => e.source === "action" && (e.payload as { actionId?: string }).actionId === actionId) : undefined;
  const backend = events.filter((e) => e.source === "backend" && e.debugId === debugId);
  return { debugId, click, request, backend };
}

export function buildBundle(input: BundleInput): Bundle {
  const { events, now, windowMs, roots } = input;
  const refs = new Map<Event, string>();
  events.forEach((e, i) => refs.set(e, `E${i + 1}`));

  const errors = events.filter(isErrorEvent);
  const anchor = errors[errors.length - 1];
  const origin = anchor?.ts ?? now;

  const chain = causalChain(events);

  // Where to look: errors in the linked request's server logs first, then the
  // newest error that comes with frames in the user's code.
  let stackRef: string | undefined;
  let frames: StackFrame[] = [];
  const candidates = [...errors.filter((e) => !chain || e.debugId !== chain.debugId), ...errors.filter((e) => chain && e.debugId === chain.debugId)];
  for (let i = candidates.length - 1; i >= 0 && !stackRef; i--) {
    const f = framesFor(candidates[i]!, events);
    if (f.some((fr) => !isInternalFrame(fr))) {
      frames = f;
      stackRef = refs.get(candidates[i]!);
    }
  }

  const fileCache = new Map<string, string | undefined>();
  const read = (p: string) => {
    if (!fileCache.has(p)) fileCache.set(p, input.readFile(p));
    return fileCache.get(p);
  };
  const repoRoot = roots[0];
  const display = (abs: string) => (repoRoot && isInside(repoRoot, abs) ? path.relative(repoRoot, abs).split(path.sep).join("/") : abs);

  const sources: Array<{ file: string; abs: string; line: number; ex: ReturnType<typeof excerpt>; lang: string; why: string }> = [];
  const overlaps = (abs: string, line: number) => sources.some((s) => s.abs === abs && line >= s.ex.from && line <= s.ex.to);
  for (const frame of frames) {
    if (sources.length >= MAX_SOURCE_FILES || isInternalFrame(frame)) continue;
    const abs = resolveFrameFile(frame.file, roots, (p) => read(p) !== undefined);
    if (!abs || overlaps(abs, frame.line)) continue;
    sources.push({ file: display(abs), abs, line: frame.line, ex: sourceWindow(read(abs)!, frame.line, CONTEXT_LINES), lang: LANGS[path.extname(abs).toLowerCase()] ?? "", why: `frame at line ${frame.line}` });
  }
  // Code that sends or serves the requests involved: the only pointer we have for
  // bugs without a stack (wrong status handling, races), and useful context otherwise.
  for (const r of input.related ?? []) {
    if (sources.length >= MAX_SOURCE_FILES + 1) break;
    const text = read(r.absPath);
    if (text === undefined || overlaps(r.absPath, r.line) || !roots.some((root) => isInside(root, r.absPath))) continue;
    sources.push({
      file: display(r.absPath),
      abs: r.absPath,
      line: r.line,
      ex: sourceWindow(text, r.line, RELATED_CONTEXT_LINES),
      lang: LANGS[path.extname(r.absPath).toLowerCase()] ?? "",
      why: `mentions ${r.term} at line ${r.line}`,
    });
  }

  // ---- render ----
  const out: string[] = [];
  out.push("# Voice Bug bundle", "");
  const pages = input.pages?.length ? ` · page ${input.pages.join(", ")}` : "";
  out.push(`Captured ${new Date(now).toISOString()} · last ${Math.round(windowMs / 1000)}s · ${events.length} events · ${errors.length} errors${pages}`, "");

  if (anchor) {
    out.push("## Last error", "", `${refs.get(anchor)} ${lineFor(anchor).split("\n")[0]}`, "");
    if (errors.length > 1) {
      out.push("## All errors in window", "");
      for (const e of errors) out.push(`- ${refs.get(e)} ${relTime(e.ts, origin)} ${lineFor(e).split("\n")[0]}`);
      out.push("");
    }
  } else {
    out.push("## Last error", "", "No error was captured in this window. The timeline below is all there is.", "");
  }

  if (chain) {
    out.push(`## What happened (linked by X-Debug-Id ${chain.debugId})`, "");
    const step = (e: Event, extra = "") => `${refs.get(e)} ${lineFor(e).split("\n")[0]}${extra}`;
    const steps: string[] = [];
    if (chain.click) steps.push(step(chain.click));
    if (chain.request) {
      const after = chain.click ? ` (started ${((chain.request.ts - chain.click.ts) / 1000).toFixed(3)}s after the click)` : "";
      steps.push(step(chain.request, after));
    }
    // Server output for this request, with dependency frames collapsed.
    const serverLines = compactStackLines(chain.backend.map((e) => (e.payload as BackendLinePayload).line));
    if (chain.backend.length) {
      const first = refs.get(chain.backend[0]!);
      const last = refs.get(chain.backend[chain.backend.length - 1]!);
      const range = first === last ? first : `${first}–${last}`;
      steps.push(`${range} server output for this request:\n${fence(serverLines.slice(0, 40).join("\n"))}`);
    }
    steps.forEach((s, i) => out.push(`${i + 1}. ${s.replace(/\n/g, "\n   ")}`));
    if (!chain.click) out.push("", "_No click within 1.5s before the request, so it wasn't triggered by one (or was triggered by a key press)._");
    out.push("");
  }

  let timeline = timelineFor(events, refs).map((t) => `${(t.ref ?? "").padEnd(5)} ${relTime(t.ts, origin)}  ${t.text}`);
  if (timeline.length > MAX_TIMELINE_LINES) timeline = [`… ${timeline.length - MAX_TIMELINE_LINES} earlier lines omitted`, ...timeline.slice(-MAX_TIMELINE_LINES)];
  out.push(`## Timeline (seconds relative to ${anchor ? "the last error" : "capture time"})`, "", fence(timeline.join("\n") || "(empty)"), "");

  if (input.screenshots?.length) {
    out.push("## Screenshots (attached as images, in this order)", "");
    input.screenshots.forEach((s, i) => out.push(`- S${i + 1} ${relTime(s.ts, origin)} after a ${s.reason}`));
    out.push("");
  }

  if (stackRef) {
    out.push(`## Stack (from ${stackRef}, code frames only)`, "");
    for (const f of frames.filter((fr) => !isInternalFrame(fr))) {
      const abs = resolveFrameFile(f.file, roots, (p) => read(p) !== undefined);
      out.push(`- ${f.fn ?? "(anonymous)"} — ${abs ? display(abs) : f.file}:${f.line}${f.column ? `:${f.column}` : ""}`);
    }
    out.push("");
  }

  if (sources.length) {
    out.push("## Source", "");
    for (const s of sources) {
      out.push(`### ${s.file} (lines ${s.ex.from}–${s.ex.to}, ${s.why})`, "", fence(s.ex.text, s.lang), "");
    }
  }

  if (input.gitDiff?.trim()) {
    let diff = input.gitDiff.trim();
    if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated (${diff.length - MAX_DIFF_CHARS} more chars)`;
    out.push("## Uncommitted changes (git diff)", "", fence(diff, "diff"), "");
  }

  const redacted = redact(out.join("\n"), input.redact);
  return {
    text: redacted.text,
    anchorRef: anchor ? refs.get(anchor) : undefined,
    eventCount: events.length,
    errorCount: errors.length,
    sourceFiles: sources.map((s) => s.file),
    sources: sources.map((s) => ({ file: s.file, absPath: s.abs, from: s.ex.from, to: s.ex.to, line: s.line })),
    redactions: redacted.count,
  };
}
