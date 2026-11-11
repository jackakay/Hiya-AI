import { GoogleGenAI } from "@google/genai";

/** Speech to text with Gemini (same API key as the diagnosis). */

/**
 * `gemini-3.5-transcribe` answers 404 through generateContent with a normal
 * API key, so a fast general model transcribes instead (about 1–2s per phrase).
 */
export const DEFAULT_TRANSCRIBE_MODEL = "gemini-3.5-flash-lite";

export type Transcribe = (wavBase64: string, signal?: AbortSignal) => Promise<string>;

const INSTRUCTION =
  "Transcribe this short English utterance from a software developer verbatim. " +
  "Output only the words spoken, with normal punctuation. If there is no intelligible speech, output nothing.";

export function geminiTranscribe(apiKey: string, model: string): Transcribe {
  const ai = new GoogleGenAI({ apiKey });
  return async (wavBase64, signal) => {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: wavBase64 } }, { text: INSTRUCTION }] }],
      config: { temperature: 0, abortSignal: signal },
    });
    return cleanTranscript(res.text ?? "");
  };
}

/** Strips quotes/labels some models wrap transcripts in. */
export function cleanTranscript(text: string): string {
  return text
    .trim()
    .replace(/^(?:transcript(?:ion)?\s*:\s*)/i, "")
    .replace(/^["“](.*)["”]$/s, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
