/**
 * Decides whether a transcript is a bug report. Only an utterance that starts
 * with (or contains) a trigger phrase counts; everything else is discarded.
 * What follows the phrase is the developer's note: what they expected or saw.
 */

export type TriggerResult = { triggered: false } | { triggered: true; note: string };

// "that's a bug", "that is a bug", "thats a bug", "that's a bag" (common mishearing), "bug:" / "bug report"
const PATTERNS = [
  /\b(?:that'?s|that is|this is|it'?s)\s+(?:a|another)\s+b[ua]g\b/i,
  /\bfound\s+a\s+bug\b/i,
  /^\s*bug\s*(?::|report\b|[,.!-])/i,
];

export function parseTrigger(transcript: string): TriggerResult {
  const text = transcript.replace(/[’‘]/g, "'").trim();
  for (const pattern of PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const note = text
      .slice(m.index + m[0].length)
      .replace(/^[\s,.:;!?-]+/, "")
      .replace(/^(?:so|and|because|cause)\s+/i, "")
      .trim();
    return { triggered: true, note };
  }
  return { triggered: false };
}

/** "Try again", "retry", "send it again"… as the whole utterance (not inside a longer sentence). */
export function isRetryPhrase(transcript: string): boolean {
  const t = transcript.toLowerCase().replace(/[’']/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:(?:ok|okay|please|can you|could you)\s+)*(?:try (?:it |that )?again|retry(?: it| that)?|send it again|resend(?: it)?|again please)(?:\s+please)?$/.test(t);
}

/** True when what followed the trigger phrase is too short to describe the bug ("", "okay", "um"). */
export function needsDetails(note: string): boolean {
  return note.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean).length < 3;
}

/** One sentence to speak when the diagnosis is ready. */
export function spokenSummary(d: { title: string; rootCause: { file: string; line: number; confidence: string }; followUpQuestion?: string }): string {
  const file = d.rootCause.file.split("/").pop();
  const where = file ? ` In ${file.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "")}, line ${d.rootCause.line}.` : "";
  const ask = d.rootCause.confidence === "low" && d.followUpQuestion ? ` ${d.followUpQuestion}` : "";
  return `${d.title.replace(/[.!]+$/, "")}.${where}${ask}`;
}
