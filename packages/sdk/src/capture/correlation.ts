import { ACTION_WINDOW_MS, DEBUG_HEADER } from "@voice-bug/shared";
import type { DecorateRequest } from "./network";

/** Short random id, e.g. "vb-3f9a1c07d2". */
export function newId(prefix = "vb"): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Remembers the last user action so requests it triggers can point back to
 * it. A request "belongs" to a click if it starts within ACTION_WINDOW_MS.
 */
export class ActionTracker {
  private last: { id: string; ts: number } | undefined;

  constructor(
    private readonly windowMs = ACTION_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a new action and returns its id. */
  begin(): string {
    const id = newId("act");
    this.last = { id, ts: this.now() };
    return id;
  }

  current(): string | undefined {
    if (!this.last) return undefined;
    return this.now() - this.last.ts <= this.windowMs ? this.last.id : undefined;
  }
}

/**
 * Adds X-Debug-Id to same-origin requests only. A custom header on a
 * cross-origin request would trigger a CORS preflight the API may reject.
 */
export function debugIdDecorator(pageOrigin: () => string, tracker?: ActionTracker): DecorateRequest {
  return ({ url }) => {
    const actionId = tracker?.current();
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === pageOrigin();
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return actionId ? { actionId } : undefined;
    const debugId = newId();
    return { headers: { [DEBUG_HEADER]: debugId }, debugId, actionId };
  };
}
