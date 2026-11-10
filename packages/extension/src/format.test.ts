import { describe, expect, it } from "vitest";
import type { Event } from "@voice-bug/shared";
import { formatEvent } from "./format";

const at = (e: Omit<Event, "ts">): Event => ({ ts: new Date(2026, 0, 1, 12, 0, 0, 5).getTime(), ...e });

describe("formatEvent", () => {
  it("formats a failing request", () => {
    const line = formatEvent(
      at({ source: "network", type: "request", payload: { api: "fetch", method: "POST", url: "/api/save", status: 500, durationMs: 12 } }),
    );
    expect(line).toBe("[12:00:00.005] network/request POST /api/save → 500 (12ms, fetch)");
  });

  it("formats a request that got no response", () => {
    const line = formatEvent(at({ source: "network", type: "request", payload: { api: "xhr", method: "GET", url: "/x", durationMs: 3, error: "network error" } }));
    expect(line).toContain("GET /x ✕ network error");
  });

  it("formats backend lines verbatim", () => {
    const line = formatEvent(at({ source: "backend", type: "stderr", payload: { line: "TypeError: Cannot read properties of undefined (reading 'trim')" } }));
    expect(line).toBe("[12:00:00.005] backend/stderr TypeError: Cannot read properties of undefined (reading 'trim')");
  });

  it("indents multi-line console messages", () => {
    const line = formatEvent(at({ source: "console", type: "error", payload: { level: "error", message: "Error: x\n    at a" } }));
    expect(line).toBe("[12:00:00.005] console/error Error: x\n        at a");
  });

  it("falls back to JSON for unknown events", () => {
    expect(formatEvent(at({ source: "action", type: "scroll", payload: { t: 1 } }))).toContain('{"t":1}');
  });

  it("formats voice reports", () => {
    expect(formatEvent(at({ source: "voice", type: "transcript", payload: { text: "that's a bug, save did nothing", note: "save did nothing", via: "voice" } }))).toBe(
      "[12:00:00.005] voice/transcript “that's a bug, save did nothing”",
    );
  });
});
