import { MAX_UTTERANCE_MS, type ClientMessage, type ServerMessage, type TranscriptRole } from "@voice-bug/shared";
import { newId } from "../capture/correlation";
import type { Vad, VadCallbacks } from "./vad";
import { clip, encodeWav, toBase64 } from "./wav";

/**
 * Floating voice widget: mic toggle with a visible recording indicator,
 * pause, status line, TTS for the extension's spoken replies, and the
 * Ctrl+Shift+B keyboard trigger. Framework-free, in a shadow root so the
 * app's CSS can't touch it, and marked so its clicks aren't captured.
 */

export type OverlayDeps = {
  send: (msg: ClientMessage) => void;
  connected: () => boolean;
  /** Lazily creates the VAD (imports onnxruntime only when the mic is turned on). */
  createVad: (cb: VadCallbacks, audioContext?: AudioContext) => Promise<Vad>;
  speak?: (text: string, done: () => void) => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

type Mode = "off" | "loading" | "listening" | "hearing" | "paused" | "error";

const STORAGE_KEY = "voiceBug.listening";

const CSS = `
:host { all: initial; }
.box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
  max-width: 360px; padding: 6px 8px 6px 10px; border-radius: 18px; background: rgba(24,24,27,.92); color: #f4f4f5;
  font: 12px/1.3 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #71717a; flex: none; }
.dot.on { background: #ef4444; animation: pulse 1.6s infinite; }
.dot.hearing { background: #ef4444; animation: pulse .6s infinite; }
.dot.paused { background: #f59e0b; }
@keyframes pulse { 50% { opacity: .35; } }
.text { flex: 1; min-width: 0; }
.title { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.meter { display: inline-block; width: 48px; height: 5px; border-radius: 3px; background: #3f3f46; overflow: hidden; }
.meter i { display: block; height: 100%; width: 0; background: #a1a1aa; transition: width 80ms linear; }
.meter i.speech { background: #22c55e; }
.status { color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 12px; background: #3f3f46; color: #f4f4f5; font-weight: 600; }
button:hover { background: #52525b; }
button[hidden] { display: none; }
.log { position: fixed; right: 16px; bottom: 60px; z-index: 2147483647; width: 340px; max-height: 50vh; display: flex; flex-direction: column;
  border-radius: 12px; background: rgba(24,24,27,.95); color: #f4f4f5; font: 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.log[hidden] { display: none; }
.log header { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid #3f3f46; font-weight: 600; }
.log header button { padding: 2px 8px; font-weight: 500; }
.entries { overflow-y: auto; padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.entry { display: flex; flex-direction: column; gap: 1px; }
.meta { color: #a1a1aa; font-size: 11px; display: flex; gap: 6px; align-items: center; }
.tag { padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
.tag.report { background: #b91c1c; } .tag.followup { background: #1d4ed8; } .tag.retry { background: #7c3aed; }
.tag.ignored { background: #3f3f46; color: #a1a1aa; } .tag.pending { background: #3f3f46; } .tag.reply { background: #047857; }
.entry.ignored .said { color: #a1a1aa; }
.entry.reply .said { font-style: italic; }
.empty { color: #a1a1aa; padding: 4px 0; }
`;

/** One line in the transcript: something the developer said, or Voice Bug's spoken reply. */
export type TranscriptEntry = { id: string; ts: number; text: string; role: TranscriptRole | "pending" | "reply" };

const TAGS: Record<TranscriptEntry["role"], string> = {
  report: "bug report",
  followup: "follow-up",
  retry: "retry",
  ignored: "ignored",
  pending: "transcribing…",
  reply: "Voice Bug",
};

/** RMS below this is digital silence: a muted, disconnected or wrong microphone. */
const SILENCE_LEVEL = 0.0003;

const LOG_KEY = "voiceBug.transcript";
const MAX_ENTRIES = 30;

/** Utterances being spoken. Chrome may garbage-collect one mid-speech and never fire `onend` unless it's referenced. */
const speakingNow = new Set<SpeechSynthesisUtterance>();

/** Rough upper bound on how long `text` takes to say, so a lost `onend` can't leave the mic paused forever. */
export function speechTimeoutMs(text: string): number {
  return 2500 + text.length * 90;
}

function defaultSpeak(text: string, done: () => void): void {
  if (typeof speechSynthesis === "undefined") return done();
  let finished = false;
  const u = new SpeechSynthesisUtterance(text);
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    speakingNow.delete(u);
    done();
  };
  const safety = setTimeout(finish, speechTimeoutMs(text));
  u.rate = 1.05;
  u.onend = finish;
  u.onerror = finish;
  speakingNow.add(u);
  speechSynthesis.speak(u);
}

export class VoiceOverlay {
  readonly host: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly micButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly logEl: HTMLElement;
  private readonly entriesEl: HTMLElement;
  private readonly toggleLogButton: HTMLButtonElement;
  private entries: TranscriptEntry[] = [];
  private readonly meterFill: HTMLElement;
  private audioCtx: AudioContext | undefined;
  private listeningSince = 0;
  private lastSoundAt = 0;
  private lastMeterUpdate = 0;
  private warnedSilent = false;
  /** The list opens by itself when something is heard, unless the developer closed it. */
  private logClosedByUser = false;
  private vad: Vad | undefined;
  private mode: Mode = "off";
  private speakingCount = 0;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "B" || e.key === "b")) {
      e.preventDefault();
      this.trigger();
    }
  };

  constructor(private readonly deps: OverlayDeps) {
    this.host = document.createElement("voice-bug-overlay");
    this.host.setAttribute("data-voice-bug-ignore", "");
    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="box" role="region" aria-label="Voice Bug">
        <span class="dot" aria-hidden="true"></span>
        <div class="text"><div class="title">Voice Bug <span class="meter" title="Microphone level (green = speech detected)"><i></i></span></div><div class="status" aria-live="polite">Mic off · Ctrl+Shift+B to report a bug</div></div>
        <button class="retry" hidden title="Send the failed request again">Retry</button>
        <button class="toggle-log" title="Show what you've said">Transcript</button>
        <button class="pause" hidden>Pause</button>
        <button class="mic">Start listening</button>
      </div>
      <section class="log" hidden aria-label="Voice Bug transcript">
        <header><span>Transcript</span><span><button class="clear-log">Clear</button> <button class="close-log" aria-label="Close">✕</button></span></header>
        <div class="entries" aria-live="polite"></div>
      </section>`;
    this.meterFill = root.querySelector(".meter i")!;
    this.logEl = root.querySelector(".log")!;
    this.entriesEl = root.querySelector(".entries")!;
    this.toggleLogButton = root.querySelector(".toggle-log")!;
    this.toggleLogButton.addEventListener("click", () => {
      if (!this.logEl.hidden) this.logClosedByUser = true;
      this.showTranscript(this.logEl.hidden);
    });
    root.querySelector(".close-log")!.addEventListener("click", () => {
      this.logClosedByUser = true;
      this.showTranscript(false);
    });
    root.querySelector(".clear-log")!.addEventListener("click", () => {
      this.entries = [];
      this.saveEntries();
      this.renderEntries();
    });
    this.entries = this.loadEntries();
    this.renderEntries();
    this.dot = root.querySelector(".dot")!;
    this.statusEl = root.querySelector(".status")!;
    this.micButton = root.querySelector(".mic")!;
    this.pauseButton = root.querySelector(".pause")!;
    this.retryButton = root.querySelector(".retry")!;
    this.retryButton.addEventListener("click", () => {
      this.retryButton.hidden = true;
      this.deps.send({ kind: "retry" });
      this.setStatus("Trying again…");
    });
    this.micButton.addEventListener("click", () => void (this.mode === "off" || this.mode === "error" ? this.start() : this.stop()));
    this.pauseButton.addEventListener("click", () => void (this.mode === "paused" ? this.resume() : this.pause()));
    document.documentElement.append(this.host);
    window.addEventListener("keydown", this.onKey, true);

    if (this.storage("get") === "1") void this.start();
  }

  status(): string {
    return this.statusEl.textContent ?? "";
  }

  currentMode(): Mode {
    return this.mode;
  }

  /** Keyboard (or button) fallback for "that's a bug". */
  trigger(): void {
    if (!this.deps.connected()) return this.setStatus("Not connected to VS Code");
    this.deps.send({ kind: "trigger", via: "keyboard" });
    this.setStatus("Bug reported, diagnosing in VS Code…");
  }

  async start(): Promise<void> {
    // Created synchronously inside the click, so Chrome's autoplay policy lets it run.
    if (!this.audioCtx && typeof AudioContext !== "undefined") this.audioCtx = new AudioContext();
    void this.audioCtx?.resume().catch(() => {});
    this.setMode("loading", "Loading voice detection…");
    try {
      this.vad ??= await this.deps.createVad(
        {
          onSpeechStart: () => this.mode === "listening" && this.setMode("hearing", "Hearing you…"),
          onSpeechEnd: (audio) => this.utterance(audio),
          onMisfire: () => this.mode === "hearing" && this.setMode("listening", "Too short; say the whole sentence"),
          onFrame: (p, level) => this.frame(p, level),
        },
        this.audioCtx,
      );
      await this.vad.start();
      this.storage("set");
      this.listeningSince = Date.now();
      this.lastSoundAt = 0;
      this.setMode("listening", "Listening for “that's a bug…”");
      if (this.audioCtx?.state === "suspended") this.waitForGesture();
    } catch (err) {
      const denied = err instanceof Error && /denied|NotAllowed|Permission/i.test(`${err.name} ${err.message}`);
      this.setMode("error", denied ? "Microphone blocked. Allow it in the address bar, then retry." : `Voice failed to start: ${String((err as Error)?.message ?? err)}`);
    }
  }

  async stop(): Promise<void> {
    await this.vad?.pause();
    this.storage("remove");
    this.setMode("off", "Mic off · Ctrl+Shift+B to report a bug");
  }

  async pause(): Promise<void> {
    await this.vad?.pause();
    this.setMode("paused", "Paused (not listening)");
  }

  async resume(): Promise<void> {
    await this.vad?.start();
    this.setMode("listening", "Listening for “that's a bug…”");
  }

  /** Handles messages from the extension. */
  receive(msg: ServerMessage): void {
    if (msg.kind === "transcript") {
      const role = msg.role ?? (msg.triggered ? "report" : "ignored");
      this.setStatus(
        role === "ignored" ? `Heard (ignored): “${msg.text || "…"}”` : role === "followup" ? `Follow-up: “${msg.text}”` : role === "retry" ? "Trying again…" : `Bug noted: “${msg.text}”`,
      );
      this.upsertEntry({ id: msg.id, ts: Date.now(), text: msg.text || "(nothing transcribed)", role });
    } else if (msg.kind === "status") {
      this.setStatus(msg.text);
      this.retryButton.hidden = !msg.canRetry;
    } else if (msg.kind === "say") {
      this.upsertEntry({ id: `say-${Date.now()}-${this.entries.length}`, ts: Date.now(), text: msg.text, role: "reply" });
      this.say(msg.text);
    }
  }

  /**
   * Started without a click (auto-resume after a reload): Chrome keeps the
   * audio suspended, which means silence. Resume on the next interaction.
   */
  private waitForGesture(): void {
    this.setStatus("Click anywhere on the page to turn the microphone on");
    const resume = () => {
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("keydown", resume, true);
      void this.audioCtx?.resume().then(() => {
        if (this.mode === "listening") this.setStatus("Listening for “that's a bug…”");
      });
    };
    window.addEventListener("pointerdown", resume, true);
    window.addEventListener("keydown", resume, true);
  }

  /** Per audio frame: drives the level meter and spots a silent microphone. */
  private frame(speechProbability: number, level: number): void {
    const now = Date.now();
    // A working mic picks up some room noise; a muted or wrong one gives ~0.
    if (level >= SILENCE_LEVEL) this.lastSoundAt = now;
    if (now - this.lastMeterUpdate > 80) {
      this.lastMeterUpdate = now;
      const width = Math.min(100, Math.round(Math.sqrt(level) * 250));
      this.meterFill.style.width = `${width}%`;
      this.meterFill.className = speechProbability > 0.5 ? "speech" : "";
    }
    // 6s without any sound while listening: wrong or muted mic.
    const silentFor = now - Math.max(this.listeningSince, this.lastSoundAt);
    if (this.mode === "listening" && !this.warnedSilent && silentFor > 6000) {
      this.warnedSilent = true;
      this.setStatus("No sound from your microphone. Check which mic is selected (mic icon in the address bar).");
    } else if (this.warnedSilent && silentFor < 1000) {
      this.warnedSilent = false;
      if (this.mode === "listening") this.setStatus("Listening for “that's a bug…”");
    }
  }

  /** Opens or closes the transcript list (remembered across reloads). */
  showTranscript(open: boolean): void {
    this.logEl.hidden = !open;
    this.toggleLogButton.textContent = open ? "Hide transcript" : "Transcript";
    if (open) this.entriesEl.scrollTop = this.entriesEl.scrollHeight;
  }

  transcript(): readonly TranscriptEntry[] {
    return this.entries;
  }

  private upsertEntry(entry: TranscriptEntry): void {
    const i = this.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) this.entries[i] = { ...entry, ts: this.entries[i]!.ts };
    else this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.saveEntries();
    this.renderEntries();
    if (this.logEl.hidden && !this.logClosedByUser) this.showTranscript(true);
  }

  private renderEntries(): void {
    this.entriesEl.replaceChildren();
    if (!this.entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nothing yet. Start listening and say “That's a bug, …”.";
      this.entriesEl.append(empty);
      return;
    }
    for (const e of this.entries) {
      const row = document.createElement("div");
      row.className = `entry ${e.role}`;
      const meta = document.createElement("div");
      meta.className = "meta";
      const time = document.createElement("span");
      time.textContent = new Date(e.ts).toLocaleTimeString();
      const tag = document.createElement("span");
      tag.className = `tag ${e.role}`;
      tag.textContent = TAGS[e.role];
      meta.append(time, tag);
      const said = document.createElement("div");
      said.className = "said";
      // textContent, never innerHTML: transcripts are untrusted text.
      said.textContent = e.role === "reply" || e.role === "pending" ? e.text : `“${e.text}”`;
      row.append(meta, said);
      this.entriesEl.append(row);
    }
    this.entriesEl.scrollTop = this.entriesEl.scrollHeight;
  }

  /** Kept in this tab's sessionStorage only, so it survives the dev server's reloads but not closing the tab. */
  private loadEntries(): TranscriptEntry[] {
    try {
      const raw = sessionStorage.getItem(LOG_KEY);
      const parsed = raw ? (JSON.parse(raw) as TranscriptEntry[]) : [];
      return Array.isArray(parsed) ? parsed.filter((e) => e.role !== "pending").slice(-MAX_ENTRIES) : [];
    } catch {
      return [];
    }
  }

  private saveEntries(): void {
    try {
      sessionStorage.setItem(LOG_KEY, JSON.stringify(this.entries));
    } catch {
      // storage unavailable
    }
  }

  /** Speaks, with the mic paused so the VAD doesn't hear the speakers. */
  say(text: string): void {
    // Replies can overlap ("Got it…" then the summary); the mic resumes after the last one.
    this.speakingCount++;
    if (this.speakingCount === 1 && (this.mode === "listening" || this.mode === "hearing")) void this.vad?.pause();
    let done = false;
    (this.deps.speak ?? defaultSpeak)(text, () => {
      if (done) return;
      done = true;
      this.speakingCount = Math.max(0, this.speakingCount - 1);
      if (this.speakingCount === 0 && (this.mode === "listening" || this.mode === "hearing")) void this.vad?.start();
    });
  }

  private get speaking(): boolean {
    return this.speakingCount > 0;
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKey, true);
    void this.vad?.destroy();
    this.host.remove();
  }

  private utterance(audio: Float32Array): void {
    if (this.mode === "paused" || this.mode === "off") return;
    const seconds = `${(Math.min(audio.length, (MAX_UTTERANCE_MS / 1000) * 16000) / 16000).toFixed(1)}s of speech`;
    // Every dropped utterance is visible in the transcript, so nothing disappears silently.
    if (this.speaking) return this.upsertEntry({ id: newId("utt"), ts: Date.now(), text: `${seconds}, not sent: Voice Bug was speaking`, role: "ignored" });
    if (!this.deps.connected()) {
      this.setMode("listening", "Not connected to VS Code. Is the extension running?");
      return this.upsertEntry({ id: newId("utt"), ts: Date.now(), text: `${seconds}, not sent: not connected to VS Code`, role: "ignored" });
    }
    this.setMode("listening", "Transcribing…");
    const samples = clip(audio, MAX_UTTERANCE_MS);
    const id = newId("utt");
    // Shown right away; replaced by the transcript when VS Code answers.
    this.upsertEntry({ id, ts: Date.now(), text: `${(samples.length / 16000).toFixed(1)}s of speech`, role: "pending" });
    this.deps.send({
      kind: "audio",
      id,
      mimeType: "audio/wav",
      data: toBase64(encodeWav(samples)),
      durationMs: Math.round((samples.length / 16000) * 1000),
    });
  }

  private setMode(mode: Mode, text: string): void {
    this.mode = mode;
    this.dot.className = `dot ${mode === "listening" ? "on" : mode === "hearing" ? "hearing" : mode === "paused" ? "paused" : ""}`;
    const live = mode === "listening" || mode === "hearing" || mode === "paused";
    this.micButton.textContent = live ? "Stop" : mode === "loading" ? "…" : "Start listening";
    this.pauseButton.hidden = !live;
    this.pauseButton.textContent = mode === "paused" ? "Resume" : "Pause";
    this.setStatus(text);
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.title = text;
  }

  private storage(op: "get" | "set" | "remove"): string | null {
    try {
      const s = this.deps.storage ?? localStorage;
      if (op === "get") return s.getItem(STORAGE_KEY);
      if (op === "set") s.setItem(STORAGE_KEY, "1");
      else s.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable (private mode etc.)
    }
    return null;
  }
}
