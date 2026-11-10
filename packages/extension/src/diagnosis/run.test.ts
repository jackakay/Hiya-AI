import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Bundle } from "../bundle";
import { describeModelError, errorStatus, isRetryable, thoughtHeading, withFallback, withRetry, type Generate, type Turn } from "./gemini";
import { buildUserPrompt } from "./prompt";
import { DiagnosisError, describeStage, runDiagnosis, type RunStage } from "./run";
import { goodDiagnosis } from "./fixtures";

const ABS = path.resolve("/repo/demo-app/server/index.ts");
const SOURCE_TEXT = Array.from({ length: 40 }, (_, i) => (i + 1 === 19 ? "  const name = req.body.name.trim();" : `line ${i + 1}`)).join("\n");
const bundle: Bundle = {
  text: "# Voice Bug bundle\n…",
  anchorRef: "E8",
  eventCount: 10,
  errorCount: 2,
  sourceFiles: ["demo-app/server/index.ts"],
  sources: [{ file: "demo-app/server/index.ts", absPath: ABS, from: 1, to: 39, line: 19 }],
  redactions: 0,
};
const readFile = (p: string) => (p === ABS ? SOURCE_TEXT : undefined);

describe("buildUserPrompt", () => {
  it("puts the developer's expectation before the bundle", () => {
    expect(buildUserPrompt("BUNDLE", "an error message")).toBe('The developer said they expected: "an error message"\n\nBUNDLE');
    expect(buildUserPrompt("BUNDLE", "  ")).toBe("The developer did not say what they expected.\n\nBUNDLE");
  });
});

describe("runDiagnosis", () => {
  it("makes exactly one call when the answer is valid", async () => {
    const generate = vi.fn<Generate>(async () => ({ text: JSON.stringify(goodDiagnosis()), usage: { inputTokens: 1200, outputTokens: 300 } }));
    const r = await runDiagnosis({ bundle, expected: "an error", generate, readFile });
    expect(generate).toHaveBeenCalledOnce();
    expect(r.calls).toBe(1);
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 300, thinkingTokens: 0 });
    expect(r.result.diagnosis.rootCause.line).toBe(19);
    expect(generate.mock.calls[0]![0][0]!.text).toContain('expected: "an error"');
  });

  it("asks once more with the problems when the first answer is invalid", async () => {
    const answers = [JSON.stringify(goodDiagnosis({ evidence: ["E99: nope"] })), JSON.stringify(goodDiagnosis())];
    const generate = vi.fn<Generate>(async () => ({ text: answers.shift()! }));
    const r = await runDiagnosis({ bundle, generate, readFile });
    expect(r.calls).toBe(2);
    const second = generate.mock.calls[1]![0] as Turn[];
    expect(second.map((t) => t.role)).toEqual(["user", "model", "user"]);
    expect(second[2]!.text).toContain("Event reference E99 does not exist");
  });

  it("gives up after the second invalid answer, with the problems", async () => {
    const generate: Generate = async () => ({ text: "{}" });
    const err = await runDiagnosis({ bundle, generate, readFile }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiagnosisError);
    expect((err as DiagnosisError).problems).toContain('"title" must be a string.');
  });
});

describe("refinement", () => {
  it("sends the previous answer and the follow-up as extra turns, with images on the first turn", async () => {
    const generate = vi.fn<Generate>(async () => ({ text: JSON.stringify(goodDiagnosis({ title: "Refined" })) }));
    const r = await runDiagnosis({
      bundle,
      generate,
      readFile,
      images: [{ mimeType: "image/jpeg", data: "AAAA" }],
      followUp: { previousAnswer: '{"title":"First"}', text: "the list doesn't refresh either" },
    });
    const turns = generate.mock.calls[0]![0] as Turn[];
    expect(turns.map((t) => t.role)).toEqual(["user", "model", "user"]);
    expect(turns[0]!.images).toEqual([{ mimeType: "image/jpeg", data: "AAAA" }]);
    expect(turns[1]!.text).toBe('{"title":"First"}');
    expect(turns[2]!.text).toContain("the list doesn't refresh either");
    expect(r.answer).toContain("Refined");
  });
});

describe("progress", () => {
  it("reports sending → thinking → answering → validating", async () => {
    const stages: RunStage[] = [];
    const generate: Generate = async (_turns, options) => {
      options?.onProgress?.({ phase: "thinking", thought: "Tracing the TypeError" });
      options?.onProgress?.({ phase: "answering", chars: 120 });
      return { text: JSON.stringify(goodDiagnosis()) };
    };
    await runDiagnosis({ bundle, generate, readFile, onStage: (s) => stages.push(s) });
    expect(stages.map((s) => s.stage)).toEqual(["sending", "thinking", "answering", "validating"]);
    expect(stages.map((s) => describeStage(s, 12_345))).toEqual([
      "Sending bundle (12.3k chars), waiting for Gemini…",
      "Thinking: Tracing the TypeError",
      "Writing the diagnosis… 120 chars",
      "Checking the answer against the bundle…",
    ]);
  });

  it("passes the abort signal to the model call", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const generate: Generate = async (_t, options) => {
      seen = options?.signal;
      return { text: JSON.stringify(goodDiagnosis()) };
    };
    await runDiagnosis({ bundle, generate, readFile, signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe("thoughtHeading", () => {
  it.each([
    ["**Tracing the TypeError**\n\nI'm looking at the stack…", "Tracing the TypeError"],
    ["\nChecking the request body", "Checking the request body"],
    ["", undefined],
    ["x".repeat(100), `${"x".repeat(67)}…`],
  ])("%j", (text, expected) => expect(thoughtHeading(text)).toBe(expected));
});

describe("withRetry", () => {
  const apiError = (status: number) => Object.assign(new Error(`status ${status}`), { status });

  it("retries 429/503 with exponential backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const generate: Generate = async () => {
      calls++;
      if (calls < 3) throw apiError(calls === 1 ? 429 : 503);
      return { text: "ok" };
    };
    const r = await withRetry(generate, { sleep: async (ms) => void sleeps.push(ms) })([]);
    expect(r.text).toBe("ok");
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("doesn't retry other errors", async () => {
    let calls = 0;
    const generate: Generate = async () => {
      calls++;
      throw apiError(400);
    };
    await expect(withRetry(generate, { sleep: async () => {} })([])).rejects.toThrow("status 400");
    expect(calls).toBe(1);
  });

  it("stops after the last attempt", async () => {
    let calls = 0;
    const generate: Generate = async () => {
      calls++;
      throw apiError(429);
    };
    await expect(withRetry(generate, { attempts: 3, sleep: async () => {} })([])).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("never retries a cancelled or timed-out call", async () => {
    let calls = 0;
    const generate: Generate = async () => {
      calls++;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    await expect(withRetry(generate, { sleep: async () => {} })([])).rejects.toThrow("aborted");
    expect(calls).toBe(1);
    expect(describeModelError(Object.assign(new Error("t"), { name: "TimeoutError" }))).toContain("didn't answer in time");
  });

  it("reports each retry with its delay", async () => {
    const retries: number[] = [];
    let calls = 0;
    const generate: Generate = async () => {
      if (++calls === 1) throw apiError(429);
      return { text: "ok" };
    };
    await withRetry(generate, { sleep: async () => {}, onRetry: ({ delayMs }) => void retries.push(delayMs) })([]);
    expect(retries).toEqual([1000]);
  });

  it("reads the status from a mid-stream error whose message is the JSON body", () => {
    const err = new Error('{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 503 }}","code":503,"status":"Service Unavailable"}}');
    expect(errorStatus(err)).toBe(503);
    expect(isRetryable(err)).toBe(true);
  });

  it("falls back to the next model when one stays overloaded", async () => {
    const switched: string[] = [];
    const g = withFallback(
      [
        { name: "big", generate: async () => Promise.reject(apiError(503)) },
        { name: "lite", generate: async () => ({ text: "ok" }) },
      ],
      (from, to) => switched.push(`${from}→${to}`),
    );
    expect((await g([])).text).toBe("ok");
    expect(g.lastModel()).toBe("lite");
    expect(switched).toEqual(["big→lite"]);
  });

  it("doesn't fall back on errors a different model wouldn't fix", async () => {
    const lite = vi.fn(async () => ({ text: "ok" }));
    const g = withFallback([
      { name: "big", generate: async () => Promise.reject(apiError(401)) },
      { name: "lite", generate: lite },
    ]);
    await expect(g([])).rejects.toThrow("status 401");
    expect(lite).not.toHaveBeenCalled();
  });

  it("classifies errors", () => {
    expect(errorStatus(apiError(429))).toBe(429);
    expect(errorStatus(new Error("x"))).toBeUndefined();
    expect(isRetryable(apiError(503))).toBe(true);
    expect(isRetryable(apiError(401))).toBe(false);
  });
});
