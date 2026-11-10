import { describe, expect, it } from "vitest";
import type { Event } from "@voice-bug/shared";
import { EventStore, RingBuffer, type BufferLimits } from "./buffer";

const ev = (ts: number, source: Event["source"] = "action", type = "click"): Event => ({ ts, source, type, payload: { ts } });

describe("RingBuffer", () => {
  it("drops events older than maxAge", () => {
    const b = new RingBuffer(100, 1000);
    b.push(ev(0), 0);
    b.push(ev(500), 500);
    b.push(ev(1600), 1600);
    expect(b.slice(-Infinity, Infinity).map((e) => e.ts)).toEqual([1600]);
    expect(b.droppedCount()).toBe(2);
  });

  it("caps the number of events, dropping the oldest", () => {
    const b = new RingBuffer(3, 60_000);
    for (let t = 1; t <= 5; t++) b.push(ev(t), t);
    expect(b.slice(-Infinity, Infinity).map((e) => e.ts)).toEqual([3, 4, 5]);
  });

  it("slices by time, inclusive", () => {
    const b = new RingBuffer(10, 60_000);
    for (const t of [10, 20, 30, 40]) b.push(ev(t), 40);
    expect(b.slice(20, 30).map((e) => e.ts)).toEqual([20, 30]);
  });
});

describe("EventStore", () => {
  const limits: BufferLimits = { maxAgeMs: 90_000, maxEvents: { action: 2, network: 10, console: 10, backend: 10, voice: 10 } };

  it("keeps a separate cap per source", () => {
    let now = 0;
    const store = new EventStore(limits, () => now);
    for (let i = 0; i < 5; i++) store.record(ev(i, "action"));
    store.record(ev(5, "backend", "stderr"));
    now = 10;
    const snap = store.snapshot(60_000);
    expect(snap.filter((e) => e.source === "action").map((e) => e.ts)).toEqual([3, 4]);
    expect(snap.filter((e) => e.source === "backend")).toHaveLength(1);
  });

  it("returns the last window merged and sorted by time, including late-arriving requests", () => {
    let now = 100_000;
    const store = new EventStore(limits, () => now);
    store.record(ev(30_000, "action")); // outside a 60s window
    store.record(ev(95_000, "action"));
    store.record(ev(95_030, "backend", "stderr"));
    // A request recorded on completion with its start time.
    store.record(ev(95_010, "network", "request"));
    now = 96_000;
    expect(store.snapshot(60_000).map((e) => `${e.source}@${e.ts}`)).toEqual(["action@95000", "network@95010", "backend@95030"]);
  });

  it("keeps arrival order for events with the same timestamp", () => {
    const store = new EventStore(limits, () => 1000);
    store.record({ ts: 1000, source: "backend", type: "stderr", payload: { line: "TypeError: x" } });
    store.record({ ts: 1000, source: "backend", type: "stderr", payload: { line: "    at a" } });
    store.record({ ts: 1000, source: "backend", type: "stderr", payload: { line: "    at b" } });
    expect(store.snapshot(60_000).map((e) => (e.payload as { line: string }).line)).toEqual(["TypeError: x", "    at a", "    at b"]);
  });

  it("breaks same-ms ties across sources by arrival order", () => {
    const store = new EventStore(limits, () => 1000);
    store.record(ev(1000, "network", "request")); // creates the network buffer first
    store.record(ev(1000, "action", "click"));
    store.record(ev(1000, "network", "request"));
    expect(store.snapshot(60_000).map((e) => e.source)).toEqual(["network", "action", "network"]);
  });

  it("snapshots are frozen copies", () => {
    let now = 1000;
    const store = new EventStore(limits, () => now);
    store.record(ev(1000, "console", "log"));
    const snap = store.snapshot(60_000);
    store.record(ev(1001, "console", "log"));
    now = 2000;
    expect(snap).toHaveLength(1);
  });

  it("forgets everything after 90s", () => {
    let now = 0;
    const store = new EventStore(limits, () => now);
    store.record(ev(0, "console", "log"));
    now = 91_000;
    expect(store.snapshot(1_000_000)).toHaveLength(0);
  });
});
