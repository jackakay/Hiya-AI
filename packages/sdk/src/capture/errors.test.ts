// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { BugEvent } from "@voice-bug/shared";
import { captureErrors, describeErrorEvent, describeRejection } from "./errors";

describe("describeErrorEvent", () => {
  it("uses the thrown Error's name, message and stack", () => {
    const error = new TypeError("x is undefined");
    const { type, payload } = describeErrorEvent(new ErrorEvent("error", { error, message: "Uncaught TypeError", filename: "http://localhost:5173/src/App.tsx", lineno: 10, colno: 3 }));
    expect(type).toBe("uncaught-error");
    expect(payload).toMatchObject({ message: "TypeError: x is undefined", source: "http://localhost:5173/src/App.tsx", line: 10, column: 3 });
    expect(payload.stack).toContain("TypeError: x is undefined");
  });

  it("falls back to the event message for cross-origin 'Script error.'", () => {
    const { payload } = describeErrorEvent(new ErrorEvent("error", { message: "Script error." }));
    expect(payload).toEqual({ message: "Script error." });
  });

  it("reports failed resource loads", () => {
    const img = document.createElement("img");
    img.setAttribute("src", "/missing.png");
    const e = new Event("error");
    Object.defineProperty(e, "target", { value: img });
    expect(describeErrorEvent(e)).toEqual({ type: "resource-error", payload: { message: "Failed to load <img>", tag: "img", source: "/missing.png" } });
  });
});

describe("describeRejection", () => {
  it("handles Errors and non-Errors", () => {
    expect(describeRejection(new Error("nope")).message).toBe("Error: nope");
    expect(describeRejection({ code: 42 })).toEqual({ message: "{code: 42}" });
    expect(describeRejection("plain")).toEqual({ message: "plain" });
    expect(describeRejection(undefined).message).toContain("no reason");
  });
});

describe("captureErrors", () => {
  it("emits console events for window errors and stops cleanly", () => {
    const events: BugEvent[] = [];
    const stop = captureErrors((e) => events.push(e));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "console", type: "uncaught-error", payload: { message: "Error: boom" } });
    stop();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("again"), message: "again" }));
    expect(events).toHaveLength(1);
  });
});
