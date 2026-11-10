import { describe, expect, it } from "vitest";
import { escapeHtml, extractTimelineRefs, renderDiagnosisHtml } from "./panelHtml";
import { goodDiagnosis } from "./fixtures";

const BUNDLE = [
  "## Timeline (seconds relative to the last error)",
  "",
  "```",
  'E7    -0.023s  action/click #save "Save"  @ /',
  "E6    -0.023s  network/request [vb-1] POST /api/save → 500 (22ms, fetch)",
  "E8     0.000s  backend/stderr [vb-1] TypeError: Cannot read properties of undefined (reading 'trim')",
  "       0.000s  backend/stderr     … 9 frames in dependencies/runtime",
  "E12   +1.250s  console/log done",
  "```",
].join("\n");

const meta = { model: "gemini-3.8-flash", ms: 4200, calls: 1, inputTokens: 1500, outputTokens: 400 };
const csp = { nonce: "abc", cspSource: "vscode-resource:" };

describe("extractTimelineRefs", () => {
  it("maps refs to their timeline lines", () => {
    const refs = extractTimelineRefs(BUNDLE);
    expect(refs.get("E6")).toBe("network/request [vb-1] POST /api/save → 500 (22ms, fetch)");
    expect(refs.get("E12")).toBe("console/log done");
    expect(refs.size).toBe(4);
  });
});

describe("renderDiagnosisHtml", () => {
  it("escapes everything the model wrote", () => {
    const d = goodDiagnosis({ title: "<img src=x onerror=alert(1)>", summary: "a & b" });
    const html = renderDiagnosisHtml({ diagnosis: d }, new Map(), meta, csp);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("links evidence refs to their timeline lines", () => {
    const html = renderDiagnosisHtml({ diagnosis: goodDiagnosis() }, extractTimelineRefs(BUNDLE), meta, csp);
    expect(html).toContain(`<span class="ref" title="${escapeHtml("network/request [vb-1] POST /api/save → 500 (22ms, fetch)")}">E6</span>`);
  });

  it("offers the fix preview and Apply, or explains why it can't", () => {
    const fix = { absPath: "/x", original: "a", patched: "b" };
    const ok = renderDiagnosisHtml({ diagnosis: goodDiagnosis(), fix }, new Map(), meta, csp);
    expect(ok).toContain('data-cmd="showFix"');
    expect(ok).toContain('data-cmd="applyFix"');
    const applied = renderDiagnosisHtml({ diagnosis: goodDiagnosis(), fix }, new Map(), meta, csp, { applied: true });
    expect(applied).not.toContain('data-cmd="applyFix"');
    expect(applied).toContain("Fix applied and saved");
    const stale = renderDiagnosisHtml({ diagnosis: goodDiagnosis(), fix: { stale: true, reason: "Hunk 1 doesn't match" } }, new Map(), meta, csp);
    expect(stale).not.toContain('data-cmd="showFix"');
    expect(stale).toContain("Hunk 1 doesn&#39;t match");
  });

  it("shows the screenshot, the refinement and fallback notes", () => {
    const html = renderDiagnosisHtml({ diagnosis: goodDiagnosis() }, new Map(), meta, csp, {
      screenshot: { dataUri: "data:image/jpeg;base64,AAAA", caption: "S1: after a click" },
      refinedWith: "it's the list <b>",
      note: "Answered by the local model qwen3:8b because Gemini was unavailable.",
    });
    expect(html).toContain('<img src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain("img-src data:");
    expect(html).toContain("Refined with:</b> “it&#39;s the list &lt;b&gt;”");
    expect(html).toContain("local model qwen3:8b");
  });

  it("locks the webview down with a nonce-based CSP", () => {
    const html = renderDiagnosisHtml({ diagnosis: goodDiagnosis() }, new Map(), meta, csp);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<script nonce="abc">');
  });
});
