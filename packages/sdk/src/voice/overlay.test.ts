// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@voice-bug/shared";
import { VoiceOverlay, speechTimeoutMs, type OverlayDeps } from "./overlay";
import type { VadCallbacks } from "./vad";
import { clip, encodeWav, toBase64 } from "./wav";

function fakeVad() {
  let cb: VadCallbacks | undefined;
  const vad = { start: vi.fn(async () => {}), pause: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
  return { vad, create: vi.fn(async (c: VadCallbacks, _ctx?: AudioContext) => ((cb = c), vad)), callbacks: () => cb! };
}

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

let overlay: VoiceOverlay | undefined;
afterEach(() => overlay?.destroy());

function setup(extra: Partial<OverlayDeps> = {}) {
  sessionStorage.clear();
  const sent: ClientMessage[] = [];
  const v = fakeVad();
  const storage = memoryStorage();
  overlay = new VoiceOverlay({ send: (m) => sent.push(m), connected: () => true, createVad: v.create, speak: (_t, done) => done(), storage, ...extra });
  return { sent, v, storage, overlay };
}

describe("wav", () => {
  it("writes a 16 kHz mono 16-bit PCM header and clamps samples", () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 2]));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  });

  it("base64-encodes and clips long audio", () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(clip(new Float32Array(32000), 1000)).toHaveLength(16000);
  });
});

describe("VoiceOverlay", () => {
  it("is marked so its clicks aren't captured, and starts with the mic off", () => {
    const { overlay } = setup();
    expect(overlay.host.hasAttribute("data-voice-bug-ignore")).toBe(true);
    expect(overlay.currentMode()).toBe("off");
  });

  it("loads the VAD only when the mic is turned on, and remembers the choice", async () => {
    const { v, storage, overlay } = setup();
    expect(v.create).not.toHaveBeenCalled();
    await overlay.start();
    expect(v.create).toHaveBeenCalledOnce();
    expect(overlay.currentMode()).toBe("listening");
    expect(storage.m.get("voiceBug.listening")).toBe("1");
    await overlay.stop();
    expect(storage.m.has("voiceBug.listening")).toBe(false);
  });

  it("sends each utterance as base64 WAV", async () => {
    const { v, sent, overlay } = setup();
    await overlay.start();
    v.callbacks().onSpeechEnd(new Float32Array(8000));
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<ClientMessage, { kind: "audio" }>;
    expect(msg.kind).toBe("audio");
    expect(msg.mimeType).toBe("audio/wav");
    expect(msg.durationMs).toBe(500);
    expect(atob(msg.data).slice(0, 4)).toBe("RIFF");
    expect(overlay.status()).toBe("Transcribing…");
  });

  it("sends nothing while paused", async () => {
    const { v, sent, overlay } = setup();
    await overlay.start();
    await overlay.pause();
    v.callbacks().onSpeechEnd(new Float32Array(8000));
    expect(sent).toHaveLength(0);
  });

  it("pauses the mic while speaking so it doesn't hear itself", async () => {
    let finish!: () => void;
    const { v, overlay } = setup({ speak: (_t, done) => void (finish = done) });
    await overlay.start();
    v.vad.start.mockClear();
    overlay.receive({ kind: "say", text: "Got it, looking into it." });
    expect(v.vad.pause).toHaveBeenCalled();
    v.callbacks().onSpeechEnd(new Float32Array(8000)); // its own voice
    finish();
    expect(v.vad.start).toHaveBeenCalledOnce();
  });

  it("resumes the mic only after the last of overlapping replies, and shows dropped speech", async () => {
    const finishers: Array<() => void> = [];
    const { v, sent, overlay } = setup({ speak: (_t, done) => void finishers.push(done) });
    await overlay.start();
    v.vad.start.mockClear();
    overlay.receive({ kind: "say", text: "Got it, looking into it." });
    overlay.receive({ kind: "say", text: "Saving an empty note crashes the server." });
    v.callbacks().onSpeechEnd(new Float32Array(8000));
    expect(sent).toHaveLength(0);
    expect(overlay.transcript().at(-1)).toMatchObject({ role: "ignored", text: "0.5s of speech, not sent: Voice Bug was speaking" });
    finishers[0]!();
    expect(v.vad.start).not.toHaveBeenCalled();
    finishers[1]!();
    finishers[1]!(); // a late duplicate callback is harmless
    expect(v.vad.start).toHaveBeenCalledOnce();
    v.callbacks().onSpeechEnd(new Float32Array(8000));
    expect(sent).toHaveLength(1);
  });

  it("shows speech that couldn't be sent because VS Code isn't connected", async () => {
    const { v, sent, overlay } = setup({ connected: () => false });
    await overlay.start();
    v.callbacks().onSpeechEnd(new Float32Array(16000));
    expect(sent).toHaveLength(0);
    expect(overlay.transcript()).toMatchObject([{ role: "ignored", text: "1.0s of speech, not sent: not connected to VS Code" }]);
    expect(overlay.status()).toContain("Not connected to VS Code");
  });

  it("bounds how long the mic can stay paused for a reply", () => {
    expect(speechTimeoutMs("Got it, looking into it.")).toBe(2500 + 24 * 90);
  });

  it("moves the level meter and warns when the microphone is silent", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { v, overlay } = setup();
      await overlay.start();
      const meter = overlay.host.shadowRoot!.querySelector<HTMLElement>(".meter i")!;
      vi.setSystemTime(100);
      v.callbacks().onFrame!(0.9, 0.05);
      expect(meter.style.width).not.toBe("0%");
      expect(meter.className).toBe("speech");
      // Quiet room noise keeps it happy…
      for (let t = 200; t <= 8000; t += 32) {
        vi.setSystemTime(t);
        v.callbacks().onFrame!(0, 0.001);
      }
      expect(overlay.status()).toBe("Listening for “that's a bug…”");
      // …but six seconds of digital silence means a muted or wrong mic.
      for (let t = 8032; t <= 15000; t += 32) {
        vi.setSystemTime(t);
        v.callbacks().onFrame!(0, 0.00001);
      }
      expect(overlay.status()).toContain("No sound from your microphone");
      vi.setSystemTime(15100);
      v.callbacks().onFrame!(0.8, 0.03);
      expect(overlay.status()).toBe("Listening for “that's a bug…”");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an AudioContext created inside the click to the VAD, and asks for a click if Chrome suspended it", async () => {
    const resume = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        resume = resume;
      },
    );
    try {
      const { v, overlay } = setup();
      await overlay.start();
      expect(v.create.mock.calls[0]![1]).toBeDefined();
      expect(overlay.status()).toBe("Click anywhere on the page to turn the microphone on");
      resume.mockClear();
      window.dispatchEvent(new Event("pointerdown"));
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Ctrl+Shift+B sends a keyboard trigger", () => {
    const { sent } = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", ctrlKey: true, shiftKey: true }));
    expect(sent).toEqual([{ kind: "trigger", via: "keyboard" }]);
  });

  it("shows transcripts and status from VS Code", () => {
    const { overlay } = setup();
    overlay.receive({ kind: "transcript", id: "u1", text: "that's a bug", triggered: true });
    expect(overlay.status()).toBe("Bug noted: “that's a bug”");
    overlay.receive({ kind: "status", state: "diagnosing", text: "Thinking: Tracing the TypeError" });
    expect(overlay.status()).toBe("Thinking: Tracing the TypeError");
  });

  it("offers Retry after a failure and sends a retry when clicked", () => {
    const { sent, overlay } = setup();
    const retry = overlay.host.shadowRoot!.querySelector<HTMLButtonElement>(".retry")!;
    expect(retry.hidden).toBe(true);
    overlay.receive({ kind: "status", state: "error", text: "Gemini is busy right now.", canRetry: true });
    expect(retry.hidden).toBe(false);
    retry.click();
    expect(sent).toEqual([{ kind: "retry" }]);
    expect(retry.hidden).toBe(true);
    overlay.receive({ kind: "status", state: "error", text: "x", canRetry: true });
    overlay.receive({ kind: "status", state: "diagnosing", text: "Thinking…" });
    expect(retry.hidden).toBe(true);
  });

  it("keeps a transcript: pending → what was heard and what it did, plus spoken replies", async () => {
    const { v, overlay } = setup();
    await overlay.start();
    v.callbacks().onSpeechEnd(new Float32Array(16000));
    expect(overlay.transcript()).toMatchObject([{ role: "pending", text: "1.0s of speech" }]);
    const id = overlay.transcript()[0]!.id;

    overlay.receive({ kind: "transcript", id, text: "That's a bug, save did nothing", triggered: true, role: "report" });
    overlay.receive({ kind: "say", text: "Got it, looking into it." });
    overlay.receive({ kind: "transcript", id: "u2", text: "let me check something", triggered: false, role: "ignored" });

    expect(overlay.transcript().map((e) => [e.role, e.text])).toEqual([
      ["report", "That's a bug, save did nothing"],
      ["reply", "Got it, looking into it."],
      ["ignored", "let me check something"],
    ]);
    // Opened by itself when the first phrase was heard.
    const root = overlay.host.shadowRoot!;
    expect(root.querySelector<HTMLElement>(".log")!.hidden).toBe(false);
    const rows = [...root.querySelectorAll(".entry")].map((r) => r.querySelector(".said")!.textContent);
    expect(rows).toEqual(["“That's a bug, save did nothing”", "Got it, looking into it.", "“let me check something”"]);
  });

  it("stays closed once the developer closes it", () => {
    const { overlay } = setup();
    const root = overlay.host.shadowRoot!;
    overlay.receive({ kind: "transcript", id: "a", text: "one", triggered: false, role: "ignored" });
    root.querySelector<HTMLButtonElement>(".close-log")!.click();
    overlay.receive({ kind: "transcript", id: "b", text: "two", triggered: false, role: "ignored" });
    expect(root.querySelector<HTMLElement>(".log")!.hidden).toBe(true);
  });

  it("renders transcripts as text, never HTML", () => {
    const { overlay } = setup();
    overlay.receive({ kind: "transcript", id: "x", text: "<img src=x onerror=alert(1)>", triggered: false, role: "ignored" });
    expect(overlay.host.shadowRoot!.querySelector(".entries img")).toBeNull();
  });

  it("explains a blocked microphone", async () => {
    const { overlay } = setup({ createVad: async () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })) });
    await overlay.start();
    expect(overlay.currentMode()).toBe("error");
    expect(overlay.status()).toContain("Microphone blocked");
  });
});
