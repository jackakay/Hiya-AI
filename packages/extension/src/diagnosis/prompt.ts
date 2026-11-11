/**
 * What we ask the model, and the JSON shape it must answer with
 * (mirrors `Diagnosis` in @voice-bug/shared).
 */

export const SYSTEM_INSTRUCTION = `You are a senior engineer diagnosing a bug that a developer just hit while manually testing their web app.
You may also get screenshots of the page (S1, S2… in the bundle) taken after clicks and errors; use them to see what the user saw.
You get a bundle captured automatically in the last 60 seconds: a timeline of user actions, network requests, browser console output and dev-server output, each with a reference like E7; the click → request → server-log chain when it could be linked exactly; source excerpts around the code frames of the error (line numbers on the left, ">" marks the frame line); and the uncommitted git diff.

Rules:
- Evidence over inference. Base every claim on the bundle. "evidence" lists the event references that support the diagnosis, each as "E<n>: <why it matters>".
- "reproSteps" come only from the timeline (what the user actually did), written as short imperative steps.
- "expected" is what the developer said they expected. If they said nothing, infer it briefly from the UI action and say it was inferred.
- "actual" is what the evidence shows happened, including anything the user could not see (e.g. a 500 the UI ignored).
- "rootCause.file" must be one of the files in the "Source" section, exactly as written there, and "rootCause.line" a line number shown in its excerpt. If no source is included, use file "" and line 0 with confidence "low".
- "rootCause.confidence": "high" only if the stack trace and code make the cause unambiguous; "low" if you are guessing. With "low", ask one short "followUpQuestion" that the developer can answer aloud.
- A fix must change behaviour. Never return a diff that only adds comments or TODOs; if you can't write the real change, omit proposedFix and explain the fix in rootCause.explanation. Small files are shown in full, so you may add imports, state or helper functions where needed.
- "proposedFix.diff" is a minimal unified diff (with @@ hunk headers and 2-3 lines of context copied exactly from the excerpt) against that same file. Fix the cause, not the symptom; where it matters, also make the failure visible to the user instead of silent. Omit proposedFix if you are not confident.
- Lines like "[redacted]", "[email]" and "<root>" are placeholders added for privacy; never put them in a fix.
- Be concise; the developer is waiting. Title under 80 characters; summary, expected, actual and rootCause.explanation at most 2 sentences each; at most 5 reproSteps and 4 evidence items; the diff only touches the lines the fix needs.`;

export function buildUserPrompt(bundleText: string, expected: string | undefined): string {
  const said = expected?.trim() ? `The developer said they expected: "${expected.trim()}"` : "The developer did not say what they expected.";
  return `${said}\n\n${bundleText}`;
}

export function buildFollowUpPrompt(text: string): string {
  return (
    `The developer added, right after reading your diagnosis: "${text.trim()}"\n` +
    "Revise the diagnosis with this information. It may correct what they expected, point at a different symptom, " +
    "or answer your follow-up question. Keep what still holds and change what it contradicts. The same rules apply. Return the full JSON."
  );
}

/** JSON Schema for structured output (Gemini `responseJsonSchema`). */
export const DIAGNOSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    reproSteps: { type: "array", items: { type: "string" }, maxItems: 6 },
    expected: { type: "string" },
    actual: { type: "string" },
    rootCause: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer" },
        explanation: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["file", "line", "explanation", "confidence"],
    },
    evidence: { type: "array", items: { type: "string" }, maxItems: 5 },
    proposedFix: {
      type: "object",
      properties: { file: { type: "string" }, diff: { type: "string" } },
      required: ["file", "diff"],
    },
    followUpQuestion: { type: "string" },
  },
  required: ["title", "summary", "reproSteps", "expected", "actual", "rootCause", "evidence"],
} as const;
