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
};

/** Messages sent from the browser SDK to the extension hub. */
export type ClientMessage =
  | { kind: "hello"; protocol: number; url: string; userAgent: string }
  | { kind: "event"; event: Event };

export const PROTOCOL_VERSION = 1;

/**
 * Written by the extension to `<workspace>/.voice-bug/session.json` so the
 * dev-server plugin can tell the SDK where to connect. Gitignored.
 */
export type SessionInfo = { port: number; token: string; pid: number };

export const SESSION_DIR = ".voice-bug";
export const SESSION_FILE = "session.json";
