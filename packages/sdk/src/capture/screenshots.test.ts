// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@voice-bug/shared";
import { captureScreenshots, maskClonedNode, screenshotFilter, type RenderOptions } from "./screenshots";

describe("maskClonedNode", () => {
  it("replaces typed values with dots, leaving buttons and empty fields alone", () => {
    const text = Object.assign(document.createElement("input"), { value: "jack@example.com" });
    const empty = document.createElement("input");
    const submit = Object.assign(document.createElement("input"), { type: "submit", value: "Save" });
    const area = Object.assign(document.createElement("textarea"), { value: "secret notes" });
    for (const n of [text, empty, submit, area]) maskClonedNode(n);
    expect(text.value).toBe("•••");
    expect(text.getAttribute("value")).toBe("•••");
    expect(empty.value).toBe("");
    expect(submit.value).toBe("Save");
    expect(area.value).toBe("•••");
  });
});

describe("screenshotFilter", () => {
  it("leaves out the overlay and ignored elements", () => {
    expect(screenshotFilter(document.createElement("voice-bug-overlay"))).toBe(false);
    const ignored = document.createElement("div");
    ignored.setAttribute("data-voice-bug-ignore", "");
    expect(screenshotFilter(ignored)).toBe(false);
    expect(screenshotFilter(document.createElement("main"))).toBe(true);
  });
});

describe("captureScreenshots", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it("shoots after a click (masking and filtering), throttled", async () => {
    vi.useFakeTimers();
    const sent: ClientMessage[] = [];
    let opts: RenderOptions | undefined;
    const render = vi.fn(async (_node: Element, o: RenderOptions) => ((opts = o), "data:image/jpeg;base64,QUJD"));
    let t = 10_000;
    stop = captureScreenshots((m) => sent.push(m), { render, clickDelayMs: 100, minIntervalMs: 1000, now: () => t });

    document.body.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ kind: "screenshot", ts: 10_000, reason: "click", mimeType: "image/jpeg", data: "QUJD" }]);
    expect(opts?.onCloneEachNode).toBe(maskClonedNode);
    expect(opts?.filter).toBe(screenshotFilter);
    expect(opts?.quality).toBe(0.6);

    t += 500;
    document.body.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(1);

    t += 1000;
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((m) => (m as { reason: string }).reason)).toEqual(["click", "error"]);
  });

  it("ignores clicks on the overlay and survives render failures", async () => {
    vi.useFakeTimers();
    const sent: ClientMessage[] = [];
    const render = vi.fn(async () => Promise.reject(new Error("canvas tainted")));
    stop = captureScreenshots((m) => sent.push(m), { render, clickDelayMs: 0 });
    const overlay = document.createElement("div");
    overlay.setAttribute("data-voice-bug-ignore", "");
    document.body.append(overlay);
    overlay.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(render).not.toHaveBeenCalled();
    document.body.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(render).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });
});
