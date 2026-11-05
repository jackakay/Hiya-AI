import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage } from "@voice-bug/shared";
import { isLocalOrigin, parseClientMessage, startHub, tokensMatch, type Hub } from "./hub";

describe("isLocalOrigin", () => {
  it.each([
    ["http://localhost:5173", true],
    ["http://127.0.0.1:3000", true],
    ["https://[::1]:8443", true],
    ["https://example.com", false],
    ["http://localhost.evil.com", false],
    ["file://", false],
    [undefined, false],
    ["not a url", false],
  ])("%s -> %s", (origin, expected) => {
    expect(isLocalOrigin(origin)).toBe(expected);
  });
});

describe("tokensMatch", () => {
  it("compares exactly", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("abc", null)).toBe(false);
  });
});

describe("parseClientMessage", () => {
  it("accepts a valid event", () => {
    const raw = JSON.stringify({ kind: "event", event: { ts: 1, source: "action", type: "click", payload: {} } });
    expect(parseClientMessage(raw)?.kind).toBe("event");
  });
  it("accepts hello", () => {
    const raw = JSON.stringify({ kind: "hello", protocol: 1, url: "http://localhost", userAgent: "x" });
    expect(parseClientMessage(raw)?.kind).toBe("hello");
  });
  it.each([
    "not json",
    "null",
    JSON.stringify({ kind: "event", event: { ts: "1", source: "action", type: "click" } }),
    JSON.stringify({ kind: "event", event: { ts: 1, source: "nope", type: "click" } }),
    JSON.stringify({ kind: "other" }),
  ])("rejects %s", (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe("startHub", () => {
  let hub: Hub | undefined;
  afterEach(async () => {
    await hub?.close();
    hub = undefined;
  });

  const connect = (h: Hub, opts: { token?: string; origin?: string }) =>
    new WebSocket(`ws://127.0.0.1:${h.port}/?token=${opts.token ?? h.token}`, {
      headers: { origin: opts.origin ?? "http://localhost:5173" },
    });

  const expectRejected = (ws: WebSocket) =>
    new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("should not connect")));
      ws.on("error", () => {});
    });

  it("delivers events from an authorised local client", async () => {
    const received: ClientMessage[] = [];
    let gotOne!: () => void;
    const done = new Promise<void>((r) => (gotOne = r));
    hub = await startHub({
      onMessage: (m) => {
        received.push(m);
        gotOne();
      },
    });
    const ws = connect(hub, {});
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ kind: "event", event: { ts: 1, source: "action", type: "click", payload: { a: 1 } } }));
    await done;
    expect(received[0]).toMatchObject({ kind: "event", event: { type: "click" } });
    ws.close();
  });

  it("rejects a bad token with 401", async () => {
    hub = await startHub({ onMessage: () => {} });
    expect(await expectRejected(connect(hub, { token: "wrong" }))).toBe(401);
  });

  it("rejects a non-local origin with 403", async () => {
    hub = await startHub({ onMessage: () => {} });
    expect(await expectRejected(connect(hub, { origin: "https://evil.example" }))).toBe(403);
  });
});
