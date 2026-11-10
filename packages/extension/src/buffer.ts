import type { Event } from "@voice-bug/shared";

/**
 * In-memory capture store: one ring buffer per event source, bounded by age
 * and by count. Nothing is ever written to disk (local-first principle).
 */

export type Source = Event["source"];

export type BufferLimits = {
  /** Events older than this are discarded. */
  maxAgeMs: number;
  /** Per-source cap; the oldest events are dropped first. */
  maxEvents: Record<Source, number>;
};

export const DEFAULT_LIMITS: BufferLimits = {
  maxAgeMs: 90_000,
  maxEvents: { action: 500, network: 500, console: 500, backend: 2000, voice: 100 },
};

/** A time-bounded, size-capped FIFO of events from one source. */
export class RingBuffer {
  private events: Event[] = [];
  private dropped = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly maxAgeMs: number,
  ) {}

  push(event: Event, now: number): void {
    this.events.push(event);
    this.prune(now);
  }

  /** Drops events that are too old or over the cap. */
  prune(now: number): void {
    const cutoff = now - this.maxAgeMs;
    let start = 0;
    // Events arrive almost in order (a request is recorded with its start
    // time when it completes), so trimming from the head is enough.
    while (start < this.events.length && this.events[start]!.ts < cutoff) start++;
    const over = this.events.length - start - this.maxEvents;
    if (over > 0) start += over;
    if (start > 0) {
      this.events.splice(0, start);
      this.dropped += start;
    }
  }

  /** Events with from <= ts <= to, in arrival order. */
  slice(from: number, to: number): Event[] {
    return this.events.filter((e) => e.ts >= from && e.ts <= to);
  }

  size(): number {
    return this.events.length;
  }

  droppedCount(): number {
    return this.dropped;
  }
}

export class EventStore {
  private readonly buffers = new Map<Source, RingBuffer>();
  /** Global arrival order, to break timestamp ties across sources. */
  private readonly arrival = new WeakMap<Event, number>();
  private seq = 0;

  constructor(
    private readonly limits: BufferLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  record(event: Event): void {
    let buffer = this.buffers.get(event.source);
    if (!buffer) {
      buffer = new RingBuffer(this.limits.maxEvents[event.source] ?? 500, this.limits.maxAgeMs);
      this.buffers.set(event.source, buffer);
    }
    this.arrival.set(event, this.seq++);
    buffer.push(event, this.now());
  }

  /**
   * A frozen copy of every source's events in the last `windowMs`, merged and
   * sorted by timestamp; same-ms events keep the order they arrived in, even
   * across sources. Later events don't change the returned array.
   */
  snapshot(windowMs: number): Event[] {
    const to = this.now();
    const from = to - windowMs;
    const all: Event[] = [];
    for (const buffer of this.buffers.values()) {
      buffer.prune(to);
      all.push(...buffer.slice(from, to));
    }
    const order = (e: Event) => this.arrival.get(e) ?? 0;
    return all.sort((a, b) => a.ts - b.ts || order(a) - order(b));
  }

  stats(): Record<string, { size: number; dropped: number }> {
    const out: Record<string, { size: number; dropped: number }> = {};
    for (const [source, buffer] of this.buffers) out[source] = { size: buffer.size(), dropped: buffer.droppedCount() };
    return out;
  }

  clear(): void {
    this.buffers.clear();
  }
}
