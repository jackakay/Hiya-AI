import type { BugEvent, ConsoleLevel, ConsolePayload } from "@voice-bug/shared";
import { formatConsoleArgs } from "./serialize";

export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];

/** Messages the SDK itself logs start with this and are never captured. */
export const SDK_LOG_PREFIX = "[voice-bug]";

/** Debug output of the voice-detection library the overlay uses; not the app's. */
const VAD_LOG = /^(?:VAD \| |using default audio context$)/;

export function isSdkMessage(args: readonly unknown[]): boolean {
  return typeof args[0] === "string" && (args[0].startsWith(SDK_LOG_PREFIX) || VAD_LOG.test(args[0]));
}

/**
 * Wraps console.log/info/warn/error/debug. The original method always runs
 * first and unchanged; capture failures are swallowed so the page's logging
 * can never break. Returns a function that restores the originals.
 */
export function captureConsole(emit: (event: BugEvent) => void, target: Console = console): () => void {
  const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>();
  const wrappers = new Map<ConsoleLevel, (...args: unknown[]) => void>();
  // Set while we are emitting, so anything logged from inside the capture path is ignored.
  let busy = false;

  for (const level of CONSOLE_LEVELS) {
    const original = target[level] as (...args: unknown[]) => void;
    if (typeof original !== "function") continue;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      original.apply(this ?? target, args);
      if (busy || isSdkMessage(args)) return;
      busy = true;
      try {
        const payload: ConsolePayload = { level, message: formatConsoleArgs(args) };
        emit({ ts: Date.now(), source: "console", type: level, payload });
      } catch {
        // never let capture break the page's logging
      } finally {
        busy = false;
      }
    };
    originals.set(level, original);
    wrappers.set(level, wrapper);
    target[level] = wrapper;
  }

  return () => {
    for (const [level, original] of originals) {
      // Only restore if nobody wrapped on top of us since.
      if (target[level] === wrappers.get(level)) target[level] = original;
    }
  };
}
