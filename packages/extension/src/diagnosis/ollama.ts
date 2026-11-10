import type { Generate } from "./gemini";
import { DIAGNOSIS_JSON_SCHEMA, SYSTEM_INSTRUCTION } from "./prompt";

/**
 * Local fallback via Ollama's /api/chat with a JSON-schema `format`. Used
 * only when Gemini can't answer (overloaded, rate-limited, offline). Nothing
 * leaves the machine. Images aren't sent: most local models are text-only.
 */

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";

/** Ollama isn't running or doesn't have the model: the caller should report the original Gemini error instead. */
export class FallbackUnavailable extends Error {
  readonly fallbackUnavailable = true;
}

type ChatChunk = { message?: { content?: string; thinking?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number; error?: string };

/** Parses Ollama's newline-delimited JSON stream; returns complete chunks and the unfinished tail. */
export function parseNdjson(buffer: string): { chunks: ChatChunk[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const chunks: ChatChunk[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      chunks.push(JSON.parse(line) as ChatChunk);
    } catch {
      // skip a malformed line
    }
  }
  return { chunks, rest };
}

export function ollamaGenerate(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): Generate {
  return async (turns, options = {}) => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: options.signal,
        body: JSON.stringify({
          model,
          stream: true,
          format: DIAGNOSIS_JSON_SCHEMA,
          options: { temperature: 0.2 },
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
          ],
        }),
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") throw err;
      throw new FallbackUnavailable(`Ollama isn't reachable at ${baseUrl}.`);
    }
    if (res.status === 404) throw new FallbackUnavailable(`Ollama doesn't have ${model} (run: ollama pull ${model}).`);
    if (!res.ok || !res.body) throw Object.assign(new Error(`Ollama returned ${res.status}`), { status: res.status });

    let text = "";
    let buffer = "";
    let usage: { inputTokens?: number; outputTokens?: number } = {};
    const decoder = new TextDecoder();
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      const parsed = parseNdjson(buffer + decoder.decode(bytes, { stream: true }));
      buffer = parsed.rest;
      for (const chunk of parsed.chunks) {
        if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
        if (chunk.message?.thinking) options.onProgress?.({ phase: "thinking", thought: "Thinking locally…" });
        if (chunk.message?.content) {
          text += chunk.message.content;
          options.onProgress?.({ phase: "answering", chars: text.length });
        }
        if (chunk.done) usage = { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count };
      }
    }
    return { text, usage };
  };
}
