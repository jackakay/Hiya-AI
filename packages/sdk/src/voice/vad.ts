import { MicVAD } from "@ricky0123/vad-web";

/** Served by the Vite plugin from node_modules, so nothing is fetched from a CDN. */
export const VAD_ASSET_BASE = "/__voice-bug/vad/";
export const ORT_ASSET_BASE = "/__voice-bug/ort/";

export type Vad = { start(): Promise<void>; pause(): Promise<void>; destroy(): Promise<void> };

export type VadCallbacks = {
  onSpeechStart: () => void;
  /** 16 kHz Float32 samples of one utterance. */
  onSpeechEnd: (audio: Float32Array) => void;
  onMisfire?: () => void;
  /** Speech probability (0–1) and loudness (RMS, 0–1) of each ~32ms frame, for the level meter. */
  onFrame?: (speechProbability: number, level: number) => void;
};

/**
 * Silero VAD in the browser: detects when the developer starts and stops
 * speaking, so only actual utterances ever leave the page. `audioContext` is
 * created by the caller inside the click that turned the mic on, so Chrome's
 * autoplay policy doesn't leave it suspended (which would mean silence).
 */
export async function createVad(cb: VadCallbacks, audioContext?: AudioContext): Promise<Vad> {
  return MicVAD.new({
    baseAssetPath: VAD_ASSET_BASE,
    onnxWASMBasePath: ORT_ASSET_BASE,
    model: "v5",
    audioContext,
    // Single-threaded WASM: the dev server doesn't send COOP/COEP headers.
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = "error";
    },
    // A short phrase like "that's a bug" is ~0.7s; ignore coughs and clicks.
    minSpeechMs: 400,
    redemptionMs: 700,
    preSpeechPadMs: 300,
    startOnLoad: true,
    onFrameProcessed: (p, frame) => {
      if (!cb.onFrame) return;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
      cb.onFrame(p.isSpeech, Math.sqrt(sum / Math.max(frame.length, 1)));
    },
    onSpeechStart: cb.onSpeechStart,
    onSpeechEnd: cb.onSpeechEnd,
    onVADMisfire: cb.onMisfire ?? (() => {}),
  });
}
