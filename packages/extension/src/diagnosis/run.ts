import type { Bundle } from "../bundle";
import type { Generate, Turn } from "./gemini";
import { buildFollowUpPrompt, buildUserPrompt } from "./prompt";
import { validateDiagnosis, type ValidatedDiagnosis } from "./validate";

export type RunResult = {
  result: ValidatedDiagnosis;
  /** The raw JSON answer, kept for a later refinement turn. */
  answer: string;
  /** Model calls made: 1 normally, 2 if the first answer had to be corrected. */
  calls: number;
  ms: number;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
};

/** What the run is doing right now, for the progress notification. */
export type RunStage =
  | { stage: "sending"; call: number }
  | { stage: "thinking"; thought: string }
  | { stage: "answering"; chars: number }
  | { stage: "validating" }
  | { stage: "correcting"; problems: string[] };

export class DiagnosisError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

/**
 * One trigger → one model call. If the answer fails validation (bad JSON,
 * unknown file/line/ref), the model gets exactly one chance to correct it.
 */
export async function runDiagnosis(opts: {
  bundle: Bundle;
  expected?: string;
  generate: Generate;
  readFile: (absPath: string) => string | undefined;
  signal?: AbortSignal;
  onStage?: (s: RunStage) => void;
  /** Refinement: the previous answer (raw JSON) and what the developer added. */
  followUp?: { previousAnswer: string; text: string };
  /** Images (e.g. screenshots) sent with the first turn. */
  images?: Array<{ mimeType: string; data: string }>;
  now?: () => number;
}): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const report = opts.onStage ?? (() => {});
  const started = now();
  const ctx = { eventCount: opts.bundle.eventCount, sources: opts.bundle.sources, readFile: opts.readFile };
  const turns: Turn[] = [{ role: "user", text: buildUserPrompt(opts.bundle.text, opts.expected), images: opts.images }];
  if (opts.followUp) {
    turns.push(
      { role: "model", text: opts.followUp.previousAnswer },
      { role: "user", text: buildFollowUpPrompt(opts.followUp.text) },
    );
  }
  const usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

  for (let call = 1; call <= 2; call++) {
    report({ stage: "sending", call });
    const answer = await opts.generate(turns, {
      signal: opts.signal,
      onProgress: (p) => report(p.phase === "thinking" ? { stage: "thinking", thought: p.thought } : { stage: "answering", chars: p.chars }),
    });
    usage.inputTokens += answer.usage?.inputTokens ?? 0;
    usage.outputTokens += answer.usage?.outputTokens ?? 0;
    usage.thinkingTokens += answer.usage?.thinkingTokens ?? 0;
    report({ stage: "validating" });
    const checked = validateDiagnosis(answer.text, ctx);
    if (checked.ok) return { result: checked.value, answer: answer.text, calls: call, ms: now() - started, usage };
    if (call === 2) throw new DiagnosisError("The model's answer didn't pass validation twice.", checked.problems);
    report({ stage: "correcting", problems: checked.problems });
    turns.push(
      { role: "model", text: answer.text },
      { role: "user", text: `Your answer has these problems:\n${checked.problems.map((p) => `- ${p}`).join("\n")}\nReturn the corrected JSON only.` },
    );
  }
  throw new DiagnosisError("unreachable");
}

/** One-line description of a stage for the progress notification. */
export function describeStage(s: RunStage, bundleChars: number): string {
  switch (s.stage) {
    case "sending":
      return s.call === 1 ? `Sending bundle (${(bundleChars / 1000).toFixed(1)}k chars), waiting for Gemini…` : "Asking Gemini to correct its answer…";
    case "thinking":
      return `Thinking: ${s.thought}`;
    case "answering":
      return `Writing the diagnosis… ${s.chars.toLocaleString("en")} chars`;
    case "validating":
      return "Checking the answer against the bundle…";
    case "correcting":
      return `Answer had ${s.problems.length} problem(s), asking for a correction…`;
  }
}
