import type { Diagnosis } from "@voice-bug/shared";

/** A plausible model answer for the planted demo bug (tests only). */
export function goodDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    title: "Saving an empty note crashes the server",
    summary: "POST /api/save (E6) throws a TypeError (E8) because req.body.name is undefined.",
    reproSteps: ["Leave the title empty", "Click Save"],
    expected: "An error message (inferred)",
    actual: "Nothing visible; the server returned 500 (E6).",
    rootCause: { file: "demo-app/server/index.ts", line: 19, explanation: "Calls .trim() on undefined.", confidence: "high" },
    evidence: ["E6: POST /api/save → 500", "E8: TypeError reading 'trim'"],
    proposedFix: { file: "demo-app/server/index.ts", diff: '@@ -19,1 +19,1 @@\n-  const name = req.body.name.trim();\n+  const name = (req.body.name ?? "").trim();\n' },
    ...overrides,
  };
}
