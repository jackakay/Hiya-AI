import type { ValidatedDiagnosis } from "./validate";

/** Pure HTML for the diagnosis webview; everything model-provided is escaped. */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "E7" → its timeline line, parsed from the rendered bundle's Timeline block. */
export function extractTimelineRefs(bundleText: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of bundleText.split("\n")) {
    const m = /^(E\d+)\s+[+\- ]\d+\.\d{3}s\s{2}(.*)$/.exec(line);
    if (m && !refs.has(m[1]!)) refs.set(m[1]!, m[2]!);
  }
  return refs;
}

/** Escapes text and turns E<n> references into spans whose tooltip is the timeline line. */
function withRefs(text: string, refs: Map<string, string>): string {
  return escapeHtml(text).replace(/\bE(\d+)\b/g, (ref) => {
    const line = refs.get(ref);
    return line ? `<span class="ref" title="${escapeHtml(line)}">${ref}</span>` : ref;
  });
}

export type PanelMeta = { model: string; ms: number; calls: number; inputTokens: number; outputTokens: number };

export type PanelExtras = {
  /** The fix was applied from this panel. */
  applied?: boolean;
  /** What the developer said when refining an earlier diagnosis. */
  refinedWith?: string;
  /** Screenshot that was sent with the bundle. */
  screenshot?: { dataUri: string; caption: string };
  /** The model that answered isn't the configured one (e.g. local Ollama fallback). */
  note?: string;
};

export function renderDiagnosisHtml(
  v: ValidatedDiagnosis,
  refs: Map<string, string>,
  meta: PanelMeta,
  csp: { nonce: string; cspSource: string },
  extra: PanelExtras = {},
): string {
  const d = v.diagnosis;
  const rc = d.rootCause;
  const evidence = d.evidence
    .map((e) => {
      const lines = [...e.matchAll(/\bE\d+\b/g)].map((m) => refs.get(m[0])).filter((l): l is string => !!l);
      const detail = lines.length ? `<div class="tl">${lines.map(escapeHtml).join("<br>")}</div>` : "";
      return `<li>${withRefs(e, refs)}${detail}</li>`;
    })
    .join("");
  const fix = !d.proposedFix
    ? `<p class="muted">No fix proposed.</p>`
    : v.fix && "stale" in v.fix
      ? `<p class="warn">The proposed diff doesn't apply to the current file: ${escapeHtml(v.fix.reason)}</p><pre>${escapeHtml(d.proposedFix.diff)}</pre>`
      : extra.applied
        ? `<p class="ok">✓ Fix applied and saved. Undo with Ctrl+Z in the editor.</p>`
        : `<p><button data-cmd="showFix">Show proposed fix (diff)</button> <button data-cmd="applyFix">Apply fix</button> <span class="muted">Nothing changes until you click Apply.</span></p>`;
  const screenshot = extra.screenshot
    ? `<h2>Screenshot</h2><figure><img src="${escapeHtml(extra.screenshot.dataUri)}" alt="Page screenshot"><figcaption class="muted">${escapeHtml(extra.screenshot.caption)}</figcaption></figure>`
    : "";
  const location = rc.file
    ? `<button class="link" data-cmd="openRootCause">${escapeHtml(rc.file)}:${rc.line}</button>`
    : `<span class="muted">No source location (no code frames were captured).</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${csp.cspSource} 'nonce-${csp.nonce}'; script-src 'nonce-${csp.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Voice Bug diagnosis</title>
<style nonce="${csp.nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 24px; line-height: 1.5; }
  h1 { font-size: 1.4em; margin: 16px 0 4px; }
  h2 { font-size: 1.05em; margin: 20px 0 6px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  .meta, .muted { color: var(--vscode-descriptionForeground); font-size: .9em; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: .8em; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .high { background: var(--vscode-testing-iconPassed, #2e7d32); color: #fff; }
  .medium { background: var(--vscode-editorWarning-foreground, #b8860b); color: #fff; }
  .low { background: var(--vscode-editorError-foreground, #c62828); color: #fff; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
  .grid b { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .ref { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; cursor: help; }
  .tl { font-family: var(--vscode-editor-font-family); font-size: .85em; color: var(--vscode-descriptionForeground); margin: 2px 0 6px; white-space: pre-wrap; }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .ok { color: var(--vscode-testing-iconPassed, #2e7d32); font-weight: 600; }
  figure { margin: 0; }
  figure img { max-width: 100%; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 4px; }
  .question { border-left: 3px solid var(--vscode-focusBorder); padding: 4px 10px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: .9em; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; font-family: var(--vscode-editor-font-family); }
  button.link:hover { text-decoration: underline; background: none; }
  li { margin-bottom: 4px; }
</style>
</head>
<body>
<h1>${escapeHtml(d.title)}<span class="badge ${rc.confidence}">${rc.confidence} confidence</span></h1>
<div class="meta">${escapeHtml(meta.model)} · ${(meta.ms / 1000).toFixed(1)}s${meta.calls > 1 ? " · answer corrected once" : ""} · ${meta.inputTokens} in / ${meta.outputTokens} out tokens · <button class="link" data-cmd="showBundle">view bundle sent</button></div>
${extra.note ? `<p class="warn">${escapeHtml(extra.note)}</p>` : ""}
${extra.refinedWith ? `<p class="question"><b>Refined with:</b> “${escapeHtml(extra.refinedWith)}”</p>` : ""}

<p>${withRefs(d.summary, refs)}</p>

<div class="grid">
  <b>Expected</b><span>${withRefs(d.expected, refs)}</span>
  <b>Actual</b><span>${withRefs(d.actual, refs)}</span>
</div>

<h2>Root cause</h2>
<p>${location}</p>
<p>${withRefs(rc.explanation, refs)}</p>
${d.followUpQuestion ? `<p class="question"><b>Question:</b> ${withRefs(d.followUpQuestion, refs)}</p>` : ""}

<h2>Fix</h2>
${fix}

${screenshot}

<h2>Steps to reproduce</h2>
<ol>${d.reproSteps.map((s) => `<li>${withRefs(s, refs)}</li>`).join("")}</ol>

<h2>Evidence</h2>
<ul>${evidence}</ul>

<script nonce="${csp.nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener("click", (e) => {
    const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (cmd) vscode.postMessage({ type: cmd });
  });
</script>
</body>
</html>`;
}
