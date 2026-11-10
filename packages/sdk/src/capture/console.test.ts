import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "@voice-bug/shared";
import { captureConsole } from "./console";

function fakeConsole() {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Console & Record<string, ReturnType<typeof vi.fn>>;
}

describe("captureConsole", () => {
  it("records each level and still calls the original", () => {
    const target = fakeConsole();
    const originals = { ...target };
    const events: BugEvent[] = [];
    captureConsole((e) => events.push(e), target);

    target.log("saved", { id: 1 });
    target.error(new Error("boom"));
    target.warn("careful");

    expect(originals.log).toHaveBeenCalledWith("saved", { id: 1 });
    expect(originals.error).toHaveBeenCalledTimes(1);
    expect(events.map((e) => [e.source, e.type])).toEqual([
      ["console", "log"],
      ["console", "error"],
      ["console", "warn"],
    ]);
    expect(events[0]?.payload).toEqual({ level: "log", message: "saved {id: 1}" });
    expect((events[1]?.payload as { message: string }).message).toMatch(/^Error: boom/);
  });

  it("ignores the SDK's own messages", () => {
    const target = fakeConsole();
    const events: BugEvent[] = [];
    captureConsole((e) => events.push(e), target);
    target.warn("[voice-bug] hub unreachable");
    target.log("VAD | debug > started micVAD");
    target.log("using default audio context");
    expect(events).toHaveLength(0);
  });

  it("ignores logging that happens while emitting (no feedback loop)", () => {
    const target = fakeConsole();
    const events: BugEvent[] = [];
    captureConsole((e) => {
      events.push(e);
      target.log("logged from inside emit");
    }, target);
    target.info("hi");
    expect(events).toHaveLength(1);
  });

  it("never lets a failing emit break the page's logging", () => {
    const target = fakeConsole();
    const original = target.log;
    captureConsole(() => {
      throw new Error("transport down");
    }, target);
    expect(() => target.log("still works")).not.toThrow();
    expect(original).toHaveBeenCalledWith("still works");
  });

  it("restores the originals", () => {
    const target = fakeConsole();
    const original = target.log;
    const stop = captureConsole(() => {}, target);
    expect(target.log).not.toBe(original);
    stop();
    expect(target.log).toBe(original);
  });
});
