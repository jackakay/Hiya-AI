import { describe, expect, it } from "vitest";
import { applyPatch, parseHunks } from "./patch";

const FILE = ['app.post("/api/save", (req, res) => {', "  const name = req.body.name.trim();", "  notes.push(name);", "  res.status(201).json(name);", "});"].join("\n");

const FIX = `--- a/demo-app/server/index.ts
+++ b/demo-app/server/index.ts
@@ -18,3 +18,6 @@
 app.post("/api/save", (req, res) => {
-  const name = req.body.name.trim();
+  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
+  if (!name) {
+    return res.status(400).json({ error: "Name is required" });
+  }
   notes.push(name);
`;

describe("parseHunks", () => {
  it("splits context, removed and added lines", () => {
    const [h] = parseHunks(FIX);
    expect(h?.oldStart).toBe(18);
    expect(h?.oldLines).toEqual(['app.post("/api/save", (req, res) => {', "  const name = req.body.name.trim();", "  notes.push(name);"]);
    expect(h?.newLines).toHaveLength(6);
  });
});

describe("applyPatch", () => {
  it("applies by content even when the hunk's line numbers are wrong", () => {
    const r = applyPatch(FILE, FIX);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('return res.status(400).json({ error: "Name is required" });');
      expect(r.text).not.toContain("req.body.name.trim();\n  notes");
      expect(r.text.split("\n")).toHaveLength(8);
    }
  });

  it("keeps CRLF line endings", () => {
    const r = applyPatch(FILE.replace(/\n/g, "\r\n"), FIX);
    expect(r.ok && r.text.includes("\r\n  if (!name) {\r\n")).toBe(true);
  });

  it("ignores trailing whitespace differences when matching", () => {
    expect(applyPatch(FILE.replace("trim();", "trim();   "), FIX).ok).toBe(true);
  });

  it("fails clearly when the file has changed", () => {
    const r = applyPatch(FILE.replace("req.body.name.trim()", "String(req.body.name)"), FIX);
    expect(r).toEqual({ ok: false, error: "Hunk 1 doesn't match the current file (it may have changed since the diagnosis)." });
  });

  it("applies several hunks in order", () => {
    const text = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const diff = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -6,2 +6,2 @@\n f\n-g\n+G\n";
    expect(applyPatch(text, diff)).toEqual({ ok: true, text: "a\nB\nc\nd\ne\nf\nG" });
  });

  it("rejects a diff without hunks", () => {
    expect(applyPatch(FILE, "just some text").ok).toBe(false);
  });
});
