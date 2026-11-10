import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { DIAGNOSIS_JSON_SCHEMA, SYSTEM_INSTRUCTION } from "./prompt";

/** One model turn: the conversation so far in, raw JSON text out. */
export type Turn = { role: "user" | "model"; text: string; images?: Array<{ mimeType: string; data: string }> };

/** Live progress while the model works: thought-summary headings, then answer characters. */
export type StreamProgress = { phase: "thinking"; thought: string } | { phase: "answering"; chars: number };

export type GenerateOptions = {
  signal?: AbortSignal;
  onProgress?: (p: StreamProgress) => void;
};

export type Generate = (
  turns: Turn[],
  options?: GenerateOptions,
) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number } }>;

export const DEFAULT_MODEL = "gemini-3.8-flash";
/** Used when the main model stays overloaded/rate-limited after its retries. Also on the free tier. */
export const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

const LEVELS: Record<Thinking, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** "**Tracing the TypeError**\n\nI'm looking…" → "Tracing the TypeError". */
export function thoughtHeading(text: string): string | undefined {
  const bold = /\*\*(.+?)\*\*/.exec(text);
  const line = (bold?.[1] ?? text.split("\n").find((l) => l.trim()) ?? "").trim();
  if (!line) return undefined;
  return line.length > 70 ? `${line.slice(0, 67)}…` : line;
}

/**
 * Streams the answer so the developer sees progress. Thought summaries are
 * requested only to show what the model is doing; they're never shown as the result.
 */
export function geminiGenerate(apiKey: string, model: string, thinking: Thinking = "low"): Generate {
  const ai = new GoogleGenAI({ apiKey });
  let useThinkingConfig = true;

  const call: Generate = async (turns, options = {}) => {
    const stream = await ai.models.generateContentStream({
      model,
      contents: turns.map((t) => ({
        role: t.role,
        parts: [...(t.images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })), { text: t.text }],
      })),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: DIAGNOSIS_JSON_SCHEMA,
        temperature: 0.2,
        abortSignal: options.signal,
        ...(useThinkingConfig ? { thinkingConfig: { thinkingLevel: LEVELS[thinking], includeThoughts: true } } : {}),
      },
    });
    let text = "";
    let usage: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number } = {};
    for await (const chunk of stream) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (!part.text) continue;
        if (part.thought) {
          const thought = thoughtHeading(part.text);
          if (thought) options.onProgress?.({ phase: "thinking", thought });
        } else {
          text += part.text;
          options.onProgress?.({ phase: "answering", chars: text.length });
        }
      }
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount,
          outputTokens: chunk.usageMetadata.candidatesTokenCount,
          thinkingTokens: chunk.usageMetadata.thoughtsTokenCount,
        };
      }
    }
    return { text, usage };
  };

  return async (turns, options) => {
    try {
      return await call(turns, options);
    } catch (err) {
      // Older models don't accept thinking levels; drop the option and try again once.
      if (useThinkingConfig && errorStatus(err) === 400 && /think/i.test(String((err as Error)?.message))) {
        useThinkingConfig = false;
        return call(turns, options);
      }
      throw err;
    }
  };
}

/** HTTP status of a failed call, from @google/genai's ApiError or anything shaped like it. */
export function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") return status;
  // Errors raised mid-stream only carry the JSON body in the message: {"error":{"code":503,...}}
  const m = /"code"\s*:\s*(\d{3})/.exec(String((err as Error | undefined)?.message ?? ""));
  return m ? Number(m[1]) : undefined;
}

/**
 * Tries each model in turn when one is overloaded or rate-limited after its
 * retries (e.g. the default Flash model → a lighter Flash-Lite).
 */
export function withFallback(models: { name: string; generate: Generate }[], onFallback?: (from: string, to: string, err: unknown) => void): Generate & { lastModel(): string } {
  let last = models[0]!.name;
  const run = async (turns: Turn[], options?: GenerateOptions) => {
    let firstErr: unknown;
    for (let i = 0; ; i++) {
      const m = models[i]!;
      last = m.name;
      try {
        return await m.generate(turns, options);
      } catch (err) {
        // A fallback that isn't set up (e.g. Ollama not running) shouldn't hide the real problem.
        if ((err as { fallbackUnavailable?: boolean })?.fallbackUnavailable && firstErr) throw firstErr;
        firstErr ??= err;
        const next = models[i + 1];
        if (!next || !shouldFallBack(err) || options?.signal?.aborted) throw err;
        onFallback?.(m.name, next.name, err);
      }
    }
  };
  return Object.assign(run, { lastModel: () => last });
}

/** Overload/rate limit, or no HTTP response at all (offline): another model might still answer. */
export function shouldFallBack(err: unknown): boolean {
  if (isAbort(err)) return false;
  return isRetryable(err) || errorStatus(err) === undefined;
}

export function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function isRetryable(err: unknown): boolean {
  if (isAbort(err)) return false;
  const status = errorStatus(err);
  return status === 429 || status === 500 || status === 503 || status === 504;
}

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; err: unknown }) => void;
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Retries rate-limit / overload errors with exponential backoff (1s, 2s, 4s). Cancelling stops it. */
export function withRetry(generate: Generate, opts: RetryOptions = {}): Generate {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? abortableSleep;
  return async (turns, options) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await generate(turns, options);
      } catch (err) {
        if (attempt >= attempts || !isRetryable(err) || options?.signal?.aborted) throw err;
        const delayMs = base * 2 ** (attempt - 1);
        opts.onRetry?.({ attempt, attempts, delayMs, err });
        await sleep(delayMs, options?.signal);
      }
    }
  };
}

/** A readable message for errors shown to the developer. */
export function describeModelError(err: unknown): string {
  if ((err as { name?: string })?.name === "TimeoutError") return "Gemini didn't answer in time. Try again, or raise \"voiceBug.geminiTimeoutSeconds\".";
  if (isAbort(err)) return "Cancelled.";
  const status = errorStatus(err);
  if (status === 400 && /API key/i.test(String((err as Error)?.message))) return "Gemini rejected the API key. Run \"Voice Bug: Set Gemini API Key\" with a valid key.";
  if (status === 401 || status === 403) return "Gemini refused the request (check the API key and that the Generative Language API is enabled).";
  if (status === 404) return "Gemini doesn't know that model. Check the \"voiceBug.geminiModel\" setting.";
  if (status === 429) return "Gemini rate limit reached (free tier). Wait a minute and try again.";
  if (status === 503 || status === 500 || status === 504) return "Gemini is overloaded right now (Google-side, usually brief). Try again in a minute, or pick another model in \"voiceBug.geminiModel\".";
  return `Gemini call failed: ${err instanceof Error ? err.message : String(err)}`;
}
