import { describe, expect, it } from "vitest";
import { withFallback, type Generate } from "./gemini";
import { FallbackUnavailable, ollamaGenerate, parseNdjson } from "./ollama";

describe("parseNdjson", () => {
  it("returns complete lines and keeps the tail", () => {
    expect(parseNdjson('{"a":1}\n{"b":2}\n{"c"')).toEqual({ chunks: [{ a: 1 }, { b: 2 }], rest: '{"c"' });
  });
});

describe("ollamaGenerate", () => {
  it("streams the answer, sends the schema and maps roles", async () => {
    let body: Record<string, unknown> = {};
    const stream = [
      JSON.stringify({ message: { content: '{"title":' } }),
      JSON.stringify({ message: { content: '"x"}' } }),
      JSON.stringify({ done: true, prompt_eval_count: 900, eval_count: 40 }),
    ].join("\n");
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(stream + "\n", { status: 200 });
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    const r = await ollamaGenerate("http://127.0.0.1:11434", "qwen3:8b", fakeFetch)(
      [
        { role: "user", text: "bundle" },
        { role: "model", text: "{}" },
        { role: "user", text: "follow-up" },
      ],
      { onProgress: (p) => p.phase === "answering" && progress.push(p.chars) },
    );
    expect(r).toEqual({ text: '{"title":"x"}', usage: { inputTokens: 900, outputTokens: 40 } });
    expect(progress).toEqual([9, 13]);
    expect(body.model).toBe("qwen3:8b");
    expect((body.format as { type: string }).type).toBe("object");
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("reports Ollama not running or the model missing as unavailable", async () => {
    const refused = (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    await expect(ollamaGenerate("http://x", "m", refused)([])).rejects.toBeInstanceOf(FallbackUnavailable);
    const missing = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    await expect(ollamaGenerate("http://x", "m", missing)([])).rejects.toThrow("ollama pull m");
  });
});

describe("withFallback with Ollama", () => {
  const overloaded = Object.assign(new Error("overloaded"), { status: 503 });

  it("falls back to the local model when Gemini is overloaded", async () => {
    const g = withFallback([
      { name: "gemini", generate: async () => Promise.reject(overloaded) },
      { name: "ollama:qwen3:8b", generate: async () => ({ text: "local" }) },
    ]);
    expect((await g([])).text).toBe("local");
    expect(g.lastModel()).toBe("ollama:qwen3:8b");
  });

  it("falls back when offline (no HTTP status at all)", async () => {
    const g = withFallback([
      { name: "gemini", generate: async () => Promise.reject(new TypeError("fetch failed")) },
      { name: "ollama:m", generate: async () => ({ text: "local" }) },
    ]);
    expect((await g([])).text).toBe("local");
  });

  it("reports Gemini's error, not Ollama's, when Ollama isn't set up", async () => {
    const notRunning: Generate = async () => Promise.reject(new FallbackUnavailable("not running"));
    const g = withFallback([
      { name: "gemini", generate: async () => Promise.reject(overloaded) },
      { name: "ollama:m", generate: notRunning },
    ]);
    await expect(g([])).rejects.toBe(overloaded);
  });
});
