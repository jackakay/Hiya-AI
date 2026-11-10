// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { BugEvent, ClickPayload, NetworkPayload } from "@voice-bug/shared";
import { DEBUG_ID_PATTERN } from "@voice-bug/shared";
import { captureClicks } from "./clicks";
import { ActionTracker, debugIdDecorator, newId } from "./correlation";
import { wrapFetch } from "./network";

const ORIGIN = "http://localhost:5173";

describe("newId", () => {
  it("is short, unique and valid as a debug id", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^vb-[0-9a-f]{10}$/);
      expect(DEBUG_ID_PATTERN.test(id)).toBe(true);
    }
  });
});

describe("ActionTracker", () => {
  it("attributes requests within the window to the last action", () => {
    let now = 0;
    const t = new ActionTracker(1500, () => now);
    expect(t.current()).toBeUndefined();
    const id = t.begin();
    now = 1500;
    expect(t.current()).toBe(id);
    now = 1501;
    expect(t.current()).toBeUndefined();
  });
});

describe("debugIdDecorator", () => {
  it("adds X-Debug-Id to same-origin requests only", () => {
    const decorate = debugIdDecorator(() => ORIGIN);
    const same = decorate({ method: "POST", url: `${ORIGIN}/api/save` });
    expect(same?.debugId).toMatch(/^vb-/);
    expect(same?.headers).toEqual({ "X-Debug-Id": same?.debugId });
    expect(decorate({ method: "GET", url: "https://api.example.com/x" })).toBeUndefined();
    expect(decorate({ method: "GET", url: "http://localhost:3000/x" })).toBeUndefined();
  });

  it("links cross-origin requests to the click without adding a header", () => {
    const tracker = new ActionTracker();
    const actionId = tracker.begin();
    expect(debugIdDecorator(() => ORIGIN, tracker)({ method: "GET", url: "https://api.example.com/x" })).toEqual({ actionId });
  });
});

describe("click → request → header, end to end in the SDK", () => {
  it("sends X-Debug-Id and records debugId + the click's actionId", async () => {
    const events: BugEvent[] = [];
    const tracker = new ActionTracker();
    const stopClicks = captureClicks((e) => events.push(e), tracker);
    const original = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 500 }));
    const f = wrapFetch(original, (e) => events.push(e), { baseUrl: () => `${ORIGIN}/`, decorateRequest: debugIdDecorator(() => ORIGIN, tracker) });

    const button = document.createElement("button");
    button.id = "save";
    button.textContent = "Save";
    document.body.append(button);
    button.click();
    await f("/api/save", { method: "POST" });
    stopClicks();

    const click = events.find((e) => e.source === "action")!;
    const request = events.find((e) => e.source === "network")!;
    const sent = new Headers(original.mock.calls[0]?.[1]?.headers).get("X-Debug-Id");

    expect(sent).toMatch(/^vb-/);
    expect(request.debugId).toBe(sent);
    expect((request.payload as NetworkPayload).actionId).toBe((click.payload as ClickPayload).actionId);
    expect((click.payload as ClickPayload).actionId).toMatch(/^act-/);
  });
});
