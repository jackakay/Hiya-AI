/** A single captured fact from any source, placed on one shared timeline. */
export type Event = {
  ts: number; // Date.now()
  source: "action" | "network" | "console" | "backend" | "voice";
  type: string; // "click", "request", "error", "transcript", ...
  debugId?: string;
  payload: unknown;
};

/** Alias that avoids clashing with the DOM `Event` type in browser code. */
export type BugEvent = Event;

export type Diagnosis = {
  title: string;
  summary: string;
  reproSteps: string[];
  expected: string; // from the voice note
  actual: string; // from the evidence
  rootCause: {
    file: string;
    line: number;
    explanation: string;
    confidence: "low" | "medium" | "high";
  };
  evidence: string[]; // event refs supporting the claim
  proposedFix?: { file: string; diff: string }; // unified diff
  followUpQuestion?: string; // asked aloud if confidence is low
};

/** Payload of a `source: "action", type: "click"` event. Never contains input values. */
export type ClickPayload = {
  selector: string;
  tag: string;
  id?: string;
  text?: string;
  role?: string;
  name?: string;
  inputType?: string;
  x: number;
  y: number;
  url: string;
  /** Random id; requests started shortly after this click carry it too. */
  actionId?: string;
};

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** Payload of a `source: "console"` event whose `type` is a ConsoleLevel. */
export type ConsolePayload = {
  level: ConsoleLevel;
  /** Arguments serialised and joined with spaces, truncated. */
  message: string;
};

/**
 * Payload of `source: "console"` events of type "uncaught-error"
 * (window `error`), "unhandled-rejection" or "resource-error"
 * (a failed <script>/<img>/<link> load).
 */
export type ErrorPayload = {
  message: string;
  stack?: string;
  /** Script URL for uncaught errors; element URL for resource errors. */
  source?: string;
  line?: number;
  column?: number;
  /** Tag of the element that failed to load (resource errors only). */
  tag?: string;
};

/** Payload of a `source: "network", type: "request"` event. No bodies, ever. */
export type NetworkPayload = {
  api: "fetch" | "xhr";
  method: string;
  /** Path + query for same-origin requests, otherwise the absolute URL. */
  url: string;
  /** HTTP status; absent when the request failed before a response arrived. */
  status?: number;
  durationMs: number;
  /** Set when there was no response: network error, abort, timeout. */
  error?: string;
  /** actionId of the click that most likely started this request (it began within ACTION_WINDOW_MS). */
  actionId?: string;
};

/*
 * `source: "backend"` events come from the dev server the extension runs:
 *   type "stdout" | "stderr" → BackendLinePayload (one per line, ANSI stripped)
 *   type "start"             → BackendStartPayload
 *   type "exit"              → BackendExitPayload
 */
export type BackendLinePayload = { line: string };
export type BackendStartPayload = { command: string; cwd: string; pid?: number };
export type BackendExitPayload = { code: number | null; signal: string | null };

/** Messages sent from the browser SDK to the extension hub. */
export type ClientMessage =
  | { kind: "hello"; protocol: number; url: string; userAgent: string }
  | { kind: "event"; event: Event }
  /** One spoken utterance cut by the VAD: 16 kHz mono 16-bit WAV, base64. */
  | { kind: "audio"; id: string; mimeType: "audio/wav"; data: string; durationMs: number }
  /** Keyboard fallback for the voice trigger (Ctrl+Shift+B in the page). */
  | { kind: "trigger"; via: "keyboard" }
  /** Send the last failed diagnosis request again (overlay Retry button). */
  | { kind: "retry" }
  /** A downscaled page screenshot taken after a click or an error, form values masked. Base64 JPEG. */
  | { kind: "screenshot"; ts: number; reason: "click" | "error"; mimeType: "image/jpeg"; data: string };

/** Messages sent from the extension hub to the page (voice overlay). */
export type ServerMessage =
  /** What was heard. Non-trigger transcripts are only shown in the overlay, never stored. */
  | { kind: "transcript"; id: string; text: string; triggered: boolean; role?: TranscriptRole }
  /** Text for the overlay to speak with speechSynthesis. */
  | { kind: "say"; text: string }
  /** `canRetry`: the request failed and was saved; the overlay offers a Retry button. */
  | { kind: "status"; state: VoiceState; text: string; canRetry?: boolean };

/** What the extension did with an utterance: started a diagnosis, refined one, retried, or nothing. */
export type TranscriptRole = "report" | "followup" | "retry" | "ignored";

export type VoiceState ="transcribing" | "diagnosing" | "done" | "error" | "idle";

/** Payload of a `source: "voice", type: "transcript"` event (trigger utterances only). */
export type VoicePayload = { text: string; note: string; via: "voice" | "keyboard" };

/** Longest utterance the overlay sends; longer speech is cut. */
export const MAX_UTTERANCE_MS = 15_000;

export const PROTOCOL_VERSION = 2;

/**
 * Written by the extension to `<workspace>/.voice-bug/session.json` so the
 * dev-server plugin can tell the SDK where to connect. Gitignored.
 */
export type SessionInfo = { port: number; token: string; pid: number };

export const SESSION_DIR = ".voice-bug";
export const SESSION_FILE = "session.json";

/**
 * Correlation (milestone 4). The SDK sends a random id in this header on
 * same-origin requests; the server middleware prefixes every log line written
 * while handling that request with debugPrefix(id); the extension strips the
 * prefix again and puts the id on the backend event's `debugId`.
 */
export const DEBUG_HEADER = "X-Debug-Id";

/** Ids are short and URL/log safe; anything else in the header is ignored. */
export const DEBUG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function debugPrefix(id: string): string {
  return `[debug:${id}] `;
}

const PREFIX_RE = /^\[debug:([A-Za-z0-9_-]{1,64})\] ?/;

/** Splits "[debug:abc] text" into { debugId: "abc", line: "text" }. Lines without a prefix are returned as-is. */
export function parseDebugPrefix(line: string): { debugId?: string; line: string } {
  const m = PREFIX_RE.exec(line);
  return m ? { debugId: m[1], line: line.slice(m[0].length) } : { line };
}

/** A request counts as caused by a click if it starts within this long after it. */
export const ACTION_WINDOW_MS = 1500;
