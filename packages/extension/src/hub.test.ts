import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage } from "@voice-bug/shared";
import { describeListenError, isLocalOrigin, parseClientMessage, startHub, tokensMatch, type Hub } from "./hub";

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
  it("accepts audio and keyboard triggers", () => {
    expect(parseClientMessage(JSON.stringify({ kind: "audio", id: "utt-1", mimeType: "audio/wav", data: "UklGRg==", durationMs: 900 }))?.kind).toBe("audio");
    expect(parseClientMessage(JSON.stringify({ kind: "trigger", via: "keyboard" }))?.kind).toBe("trigger");
    expect(parseClientMessage(JSON.stringify({ kind: "retry", extra: "ignored" }))).toEqual({ kind: "retry" });
    expect(parseClientMessage(JSON.stringify({ kind: "screenshot", ts: 1, reason: "click", mimeType: "image/jpeg", data: "QUJD" }))?.kind).toBe("screenshot");
    expect(parseClientMessage(JSON.stringify({ kind: "screenshot", ts: 1, reason: "scroll", mimeType: "image/jpeg", data: "QUJD" }))).toBeNull();
  });
  it.each([
    JSON.stringify({ kind: "audio", id: "x", mimeType: "audio/mpeg", data: "AA==", durationMs: 1 }),
    JSON.stringify({ kind: "audio", id: "x", mimeType: "audio/wav", data: "not base64!", durationMs: 1 }),
    JSON.stringify({ kind: "trigger", via: "mouse" }),
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

  it("sends messages back to a connected page", async () => {
    let clientId = 0;
    hub = await startHub({ onMessage: () => {}, onConnect: (c) => (clientId = c.id) });
    const ws = connect(hub, {});
    await new Promise((r) => ws.on("open", r));
    for (let i = 0; i < 20 && !clientId; i++) await new Promise((r) => setTimeout(r, 10));
    const received = new Promise<string>((r) => ws.on("message", (d) => r(d.toString())));
    expect(hub.send(clientId, { kind: "say", text: "Got it" })).toBe(true);
    expect(JSON.parse(await received)).toEqual({ kind: "say", text: "Got it" });
    expect(hub.send(999, { kind: "say", text: "nobody" })).toBe(false);
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

  it("listens on a fixed port and reports EADDRINUSE when it is taken", async () => {
    const first = await startHub({ onMessage: () => {} });
    const port = first.port;
    await first.close();

    hub = await startHub({ port, onMessage: () => {} });
    expect(hub.port).toBe(port);

    const err = await startHub({ port, onMessage: () => {} }).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err?.code).toBe("EADDRINUSE");
    expect(describeListenError(err, port)).toContain(`Port ${port} on 127.0.0.1 is already in use`);
  });
});
