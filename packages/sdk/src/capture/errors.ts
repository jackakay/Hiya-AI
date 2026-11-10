import type { BugEvent, ErrorPayload } from "@voice-bug/shared";
import { describeError, serializeValue, truncate } from "./serialize";

const MAX_STACK = 4000;

function fromError(err: unknown, fallbackMessage: string): Pick<ErrorPayload, "message" | "stack"> {
  if (err instanceof Error) {
    const stack = describeError(err);
    return { message: truncate(`${err.name}: ${err.message}`, 1000), stack: truncate(stack, MAX_STACK) };
  }
  return { message: err == null ? fallbackMessage : serializeValue(err) };
}

/** Builds the payload for a window `error` event (script error or failed resource load). */
export function describeErrorEvent(e: ErrorEvent | Event): { type: string; payload: ErrorPayload } {
  const target = e.target;
  if (typeof Element !== "undefined" && target instanceof Element) {
    const src = target.getAttribute("src") ?? target.getAttribute("href") ?? undefined;
    const tag = target.tagName.toLowerCase();
    return { type: "resource-error", payload: { message: `Failed to load <${tag}>`, tag, source: src } };
  }
  const ev = e as ErrorEvent;
  const payload: ErrorPayload = { ...fromError(ev.error, ev.message || "Unknown error") };
  // Prefer the event's own message when the thrown value isn't an Error ("Script error." etc).
  if (!(ev.error instanceof Error) && ev.message) payload.message = truncate(ev.message, 1000);
  if (ev.filename) payload.source = ev.filename;
  if (ev.lineno) payload.line = ev.lineno;
  if (ev.colno) payload.column = ev.colno;
  return { type: "uncaught-error", payload };
}

export function describeRejection(reason: unknown): ErrorPayload {
  return fromError(reason, "Unhandled promise rejection (no reason)");
}

/** Captures uncaught errors, failed resource loads and unhandled promise rejections. */
export function captureErrors(emit: (event: BugEvent) => void, target: Window = window): () => void {
  const onError = (e: Event) => {
    try {
      const { type, payload } = describeErrorEvent(e);
      emit({ ts: Date.now(), source: "console", type, payload });
    } catch {
      // ignore
    }
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    try {
      emit({ ts: Date.now(), source: "console", type: "unhandled-rejection", payload: describeRejection(e.reason) });
    } catch {
      // ignore
    }
  };
  // Capture phase: resource load errors don't bubble to window otherwise.
  target.addEventListener("error", onError, true);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError, true);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
