import path from "node:path";
import { describe, expect, it } from "vitest";
import { goodDiagnosis } from "./fixtures";
import type { SentSource } from "../bundle";
import { isCosmeticDiff, normalizeFile, shapeProblems, validateDiagnosis, type ValidationContext } from "./validate";

const ABS = path.resolve("/repo/demo-app/server/index.ts");
const SOURCE_TEXT = Array.from({ length: 40 }, (_, i) => (i + 1 === 19 ? "  const name = req.body.name.trim();" : `line ${i + 1}`)).join("\n");
const sources: SentSource[] = [{ file: "demo-app/server/index.ts", absPath: ABS, from: 1, to: 39, line: 19 }];
const ctx: ValidationContext = { eventCount: 10, sources, readFile: (p) => (p === ABS ? SOURCE_TEXT : undefined) };

const run = (d: unknown) => validateDiagnosis(JSON.stringify(d), ctx);

describe("normalizeFile", () => {
  it.each([
    ["demo-app/server/index.ts", "demo-app/server/index.ts"],
    ["./demo-app/server/index.ts", "demo-app/server/index.ts"],
    ["<root>/demo-app/server/index.ts", "demo-app/server/index.ts"],
    ["demo-app\\server\\index.ts", "demo-app/server/index.ts"],
  ])("%s", (input, expected) => expect(normalizeFile(input)).toBe(expected));
});

describe("shapeProblems", () => {
  it("accepts a full diagnosis", () => expect(shapeProblems(goodDiagnosis())).toEqual([]));
  it("lists what is wrong", () => {
    const bad = { ...goodDiagnosis(), title: 3, reproSteps: "click", rootCause: { file: "x", line: 1.5, explanation: "", confidence: "sure" } };
    expect(shapeProblems(bad)).toEqual([
      '"title" must be a string.',
      '"reproSteps" must be an array of strings.',
      '"rootCause.line" must be an integer.',
      '"rootCause.confidence" must be low, medium or high.',
    ]);
  });
});

describe("isCosmeticDiff", () => {
  it("spots fixes that only add comments or whitespace", () => {
    expect(isCosmeticDiff("@@ -40,2 +40,3 @@\n   if (!q) return setResults(null);\n+  // Add request token tracking to ignore out-of-order responses\n   const res = await fetch(url);\n")).toBe(true);
    expect(isCosmeticDiff("@@ -1 +1 @@\n-const a = 1;\n+const a  =  1; // tidy\n")).toBe(true);
    expect(isCosmeticDiff("@@ -1 +1,2 @@\n-  setResults(data);\n+  if (id === latest.current) setResults(data);\n")).toBe(false);
    expect(isCosmeticDiff("@@ -1 +1 @@\n-import { useState } from \"react\";\n+import { useRef, useState } from \"react\";\n")).toBe(false);
    expect(isCosmeticDiff("@@ -1 +1 @@\n-const url = \"http://x\";\n+const url = \"https://x\";\n")).toBe(false);
  });
});

describe("validateDiagnosis", () => {
  it("asks again when the fix only adds a comment", () => {
    const r = run(goodDiagnosis({ proposedFix: { file: "demo-app/server/index.ts", diff: "@@ -19,1 +19,2 @@\n+  // TODO: check the name\n   const name = req.body.name.trim();\n" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("only adds or changes comments");
  });

  it("accepts a good answer and prepares the fix preview", () => {
    const r = run(goodDiagnosis());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rootCauseAbsPath).toBe(ABS);
    expect(r.value.fix && "patched" in r.value.fix && r.value.fix.patched).toContain('(req.body.name ?? "").trim()');
  });

  it("rejects invalid JSON", () => {
    expect(validateDiagnosis("{not json", ctx)).toEqual({ ok: false, problems: ["The answer is not valid JSON."] });
  });

  it("rejects references to events that don't exist", () => {
    const r = run(goodDiagnosis({ evidence: ["E42: made up"] }));
    expect(r).toEqual({ ok: false, problems: ["Event reference E42 does not exist (the bundle has E1–E10)."] });
  });

  it("rejects a root cause in a file that wasn't sent", () => {
    const r = run(goodDiagnosis({ rootCause: { file: "src/App.tsx", line: 3, explanation: "x", confidence: "low" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("is not one of the files in the Source section (demo-app/server/index.ts)");
  });

  it("rejects a line outside the excerpt", () => {
    const r = run(goodDiagnosis({ rootCause: { file: "demo-app/server/index.ts", line: 120, explanation: "x", confidence: "low" } }));
    expect(r.ok).toBe(false);
  });

  it("accepts an unknown location only when no source was sent", () => {
    const rc = { file: "", line: 0, explanation: "No stack captured.", confidence: "low" as const };
    expect(run(goodDiagnosis({ rootCause: rc, proposedFix: undefined })).ok).toBe(false);
    const noSources = validateDiagnosis(JSON.stringify(goodDiagnosis({ rootCause: rc, proposedFix: undefined })), { ...ctx, sources: [] });
    expect(noSources.ok).toBe(true);
  });

  it("marks a fix that doesn't apply as stale instead of failing", () => {
    const r = run(goodDiagnosis({ proposedFix: { file: "demo-app/server/index.ts", diff: "@@ -1,1 +1,1 @@\n-something else\n+x\n" } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fix && "stale" in r.value.fix).toBe(true);
  });

  it("normalises the file path the model used", () => {
    const r = run(goodDiagnosis({ rootCause: { file: "<root>/demo-app/server/index.ts", line: 19, explanation: "x", confidence: "medium" } }));
    expect(r.ok && r.value.diagnosis.rootCause.file).toBe("demo-app/server/index.ts");
  });
});
