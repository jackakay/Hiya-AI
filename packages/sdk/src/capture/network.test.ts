// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { BugEvent, NetworkPayload } from "@voice-bug/shared";
import { displayUrl, wrapFetch, wrapXhr, type NetworkOptions } from "./network";

const BASE = "http://localhost:5173/notes";

function clock(...times: number[]) {
  const queue = [...times];
  return () => queue.shift() ?? times[times.length - 1]!;
}

const payloads = (events: BugEvent[]) => events.map((e) => e.payload as NetworkPayload);

describe("displayUrl", () => {
  it.each([
    ["/api/save", "/api/save"],
    ["http://localhost:5173/api/notes?x=1", "/api/notes?x=1"],
    ["api/rel", "/api/rel"],
    ["https://api.example.com/v1", "https://api.example.com/v1"],
  ])("%s -> %s", (url, expected) => {
    expect(displayUrl(url, BASE)).toBe(expected);
  });
});

describe("wrapFetch", () => {
  const opts = (extra: Partial<NetworkOptions> = {}): NetworkOptions => ({ baseUrl: () => BASE, now: clock(1000, 1012), ...extra });

  it("records method, URL, status and duration but no bodies", async () => {
    const original = vi.fn(async () => new Response("secret response", { status: 500 }));
    const events: BugEvent[] = [];
    const f = wrapFetch(original, (e) => events.push(e), opts());

    const res = await f("/api/save", { method: "post", body: JSON.stringify({ password: "hunter2" }) });

    expect(res.status).toBe(500);
    expect(original).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ts: 1000, source: "network", type: "request" });
    expect(events[0]?.payload).toEqual({ api: "fetch", method: "POST", url: "/api/save", status: 500, durationMs: 12 });
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(JSON.stringify(events)).not.toContain("secret response");
  });

  it("reads method and URL from a Request object", async () => {
    const events: BugEvent[] = [];
    const f = wrapFetch(async () => new Response(null, { status: 204 }), (e) => events.push(e), opts());
    await f(new Request("http://localhost:5173/api/notes/1", { method: "DELETE" }));
    expect(payloads(events)[0]).toMatchObject({ method: "DELETE", url: "/api/notes/1", status: 204 });
  });

  it("records network failures and rethrows them", async () => {
    const events: BugEvent[] = [];
    const f = wrapFetch(async () => Promise.reject(new TypeError("Failed to fetch")), (e) => events.push(e), opts());
    await expect(f("https://down.example/x")).rejects.toThrow("Failed to fetch");
    expect(payloads(events)[0]).toEqual({ api: "fetch", method: "GET", url: "https://down.example/x", error: "Failed to fetch", durationMs: 12 });
  });

  it("reports aborts as 'aborted'", async () => {
    const events: BugEvent[] = [];
    const abort = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
    const f = wrapFetch(async () => Promise.reject(abort), (e) => events.push(e), opts());
    await expect(f("/slow")).rejects.toBe(abort);
    expect(payloads(events)[0]?.error).toBe("aborted");
  });

  it("skips ignored URLs entirely", async () => {
    const events: BugEvent[] = [];
    const original = vi.fn(async () => new Response("ok"));
    const f = wrapFetch(original, (e) => events.push(e), opts({ ignoreUrl: (u) => u.startsWith("http://127.0.0.1:9999") }));
    await f("http://127.0.0.1:9999/whatever");
    expect(original).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("adds no headers by default", async () => {
    const original = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    const f = wrapFetch(original, () => {}, opts());
    const init = { method: "POST", headers: { "Content-Type": "application/json" } };
    await f("/api/save", init);
    expect(original.mock.calls[0]?.[1]).toBe(init);
  });

  it("lets a decorateRequest hook add headers and a debugId (used for X-Debug-Id later)", async () => {
    const original = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    const events: BugEvent[] = [];
    const f = wrapFetch(original, (e) => events.push(e), opts({ decorateRequest: () => ({ headers: { "X-Debug-Id": "abc" }, debugId: "abc" }) }));

    await f("/api/save", { method: "POST", headers: { "Content-Type": "application/json" } });

    const headers = new Headers(original.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Debug-Id")).toBe("abc");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(events[0]?.debugId).toBe("abc");
  });

  it("keeps a Request's own headers when the hook adds one", async () => {
    const original = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    const f = wrapFetch(original, () => {}, opts({ decorateRequest: () => ({ headers: { "X-Debug-Id": "abc" } }) }));
    await f(new Request("http://localhost:5173/a", { headers: { Authorization: "Bearer t" } }));
    const headers = new Headers(original.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer t");
    expect(headers.get("X-Debug-Id")).toBe("abc");
  });

  it("still sends the request when the hook throws", async () => {
    const original = vi.fn(async () => new Response("ok"));
    const f = wrapFetch(original, () => {}, opts({ decorateRequest: () => {
      throw new Error("bug in hook");
    } }));
    await expect(f("/a")).resolves.toBeInstanceOf(Response);
  });
});

/** Minimal XHR stand-in: tests drive completion by hand. */
class FakeXhr extends EventTarget {
  status = 0;
  headers: Record<string, string> = {};
  sent: unknown;
  open(_method: string, _url: string | URL) {}
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body?: unknown) {
    this.sent = body;
  }
  finish(status: number) {
    this.status = status;
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  }
  fail(type: "error" | "abort" | "timeout") {
    this.status = 0;
    this.dispatchEvent(new Event(type));
    this.dispatchEvent(new Event("loadend"));
  }
}

describe("wrapXhr", () => {
  const setup = (extra: Partial<NetworkOptions> = {}) => {
    class Xhr extends FakeXhr {}
    const events: BugEvent[] = [];
    const undo = wrapXhr(Xhr as unknown as typeof XMLHttpRequest, (e) => events.push(e), { baseUrl: () => BASE, now: clock(2000, 2030), ...extra });
    return { Xhr, events, undo };
  };

  it("records a completed request on loadend", () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open("post", "/api/save");
    xhr.send('{"name":"x"}');
    expect(events).toHaveLength(0);
    xhr.finish(500);
    expect(events[0]).toMatchObject({ ts: 2000, source: "network", type: "request" });
    expect(events[0]?.payload).toEqual({ api: "xhr", method: "POST", url: "/api/save", status: 500, durationMs: 30 });
    expect(xhr.sent).toBe('{"name":"x"}');
  });

  it.each([
    ["error", "network error"],
    ["abort", "aborted"],
    ["timeout", "timeout"],
  ] as const)("records %s as a failure", (type, message) => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open("GET", "/api/notes");
    xhr.send();
    xhr.fail(type);
    expect(payloads(events)[0]).toMatchObject({ error: message });
    expect(payloads(events)[0]?.status).toBeUndefined();
  });

  it("emits once even if the same object is reused", () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open("GET", "/a");
    xhr.send();
    xhr.finish(200);
    xhr.open("GET", "/b");
    xhr.send();
    xhr.finish(404);
    expect(payloads(events).map((p) => [p.url, p.status])).toEqual([
      ["/a", 200],
      ["/b", 404],
    ]);
  });

  it("applies decorateRequest headers and skips ignored URLs", () => {
    const { Xhr, events } = setup({
      decorateRequest: () => ({ headers: { "X-Debug-Id": "xyz" }, debugId: "xyz" }),
      ignoreUrl: (u) => u.includes("ignored"),
    });
    const a = new Xhr();
    a.open("GET", "/api");
    a.send();
    a.finish(200);
    expect(a.headers["X-Debug-Id"]).toBe("xyz");
    expect(events[0]?.debugId).toBe("xyz");

    const b = new Xhr();
    b.open("GET", "/ignored");
    b.send();
    b.finish(200);
    expect(b.headers).toEqual({});
    expect(events).toHaveLength(1);
  });

  it("undo restores the prototype", () => {
    const { Xhr, undo } = setup();
    const patched = Xhr.prototype.send;
    undo();
    expect(Xhr.prototype.send).not.toBe(patched);
    expect(Xhr.prototype.send).toBe(FakeXhr.prototype.send);
  });
});
