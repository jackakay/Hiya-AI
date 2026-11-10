import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { extractTimelineRefs, renderDiagnosisHtml, type PanelExtras, type PanelMeta } from "./panelHtml";
import { applyPatch } from "./patch";
import type { ValidatedDiagnosis } from "./validate";

const FIX_SCHEME = "voice-bug-fix";

/**
 * Shows a diagnosis: webview panel, root-cause line highlight, a Problems
 * entry, and a read-only diff preview of the proposed fix. Never edits files.
 */
export class DiagnosisView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("Voice Bug");
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private readonly fixDocs = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  /** `marked` turns false once the file is edited, so the stale highlight goes away. */
  private current: { v: ValidatedDiagnosis; uri?: vscode.Uri; line?: number; marked: boolean } | undefined;

  constructor(private readonly showBundle: () => void) {
    this.disposables.push(
      this.diagnostics,
      this.highlight,
      vscode.workspace.registerTextDocumentContentProvider(FIX_SCHEME, { provideTextDocumentContent: (uri) => this.fixDocs.get(uri.toString()) ?? "" }),
      // Re-apply the highlight when the file is (re)opened.
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      // Once the developer edits the file, the marker is out of date.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.current?.marked && this.current.uri && e.document.uri.toString() === this.current.uri.toString() && e.contentChanges.length) this.clearMarkers();
      }),
    );
  }

  show(v: ValidatedDiagnosis, bundleText: string, meta: PanelMeta, extra: PanelExtras = {}): void {
    const d = v.diagnosis;
    this.clearMarkers();
    const uri = v.rootCauseAbsPath ? vscode.Uri.file(v.rootCauseAbsPath) : undefined;
    this.current = { v, uri, line: uri ? d.rootCause.line - 1 : undefined, marked: true };

    if (uri && this.current.line !== undefined) {
      const range = new vscode.Range(this.current.line, 0, this.current.line, Number.MAX_SAFE_INTEGER);
      const diag = new vscode.Diagnostic(range, `${d.title}: ${d.rootCause.explanation}`, vscode.DiagnosticSeverity.Warning);
      diag.source = "Voice Bug";
      this.diagnostics.set(uri, [diag]);
      void this.openRootCause();
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("voiceBug.diagnosis", "Voice Bug diagnosis", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m: { type?: string }) => {
        if (m.type === "openRootCause") void this.openRootCause();
        else if (m.type === "showFix") void this.showFix();
        else if (m.type === "applyFix") void this.applyFix();
        else if (m.type === "showBundle") this.showBundle();
      });
    }
    this.rendered = { bundleText, meta, extra };
    this.applied = false;
    this.render();
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private rendered: { bundleText: string; meta: PanelMeta; extra: PanelExtras } | undefined;
  private applied = false;

  private render(): void {
    if (!this.panel || !this.current || !this.rendered) return;
    const nonce = randomBytes(16).toString("base64");
    const d = this.current.v.diagnosis;
    this.panel.title = `Bug: ${d.title}`.slice(0, 60);
    this.panel.webview.html = renderDiagnosisHtml(this.current.v, extractTimelineRefs(this.rendered.bundleText), this.rendered.meta, {
      nonce,
      cspSource: this.panel.webview.cspSource,
    }, { ...this.rendered.extra, applied: this.applied });
  }

  /**
   * Applies the proposed diff to the file as it is *now* (open editor
   * contents included), as one undoable edit, then saves so the dev server
   * reloads. Only ever runs on an explicit click.
   */
  private async applyFix(): Promise<void> {
    const v = this.current?.v;
    const fix = v?.fix;
    const diff = v?.diagnosis.proposedFix?.diff;
    if (!fix || "stale" in fix || !diff || this.applied) return;
    const uri = vscode.Uri.file(fix.absPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const patched = applyPatch(doc.getText(), diff);
    if (!patched.ok) {
      void vscode.window.showErrorMessage(`Voice Bug: the fix no longer applies. ${patched.error}`);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), patched.text);
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage("Voice Bug: VS Code refused the edit.");
      return;
    }
    await doc.save();
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    this.applied = true;
    this.clearMarkers();
    this.render();
    void vscode.window.showInformationMessage(`Voice Bug: fix applied to ${path.basename(fix.absPath)} and saved. Undo with Ctrl+Z.`);
  }

  private async openRootCause(): Promise<void> {
    const c = this.current;
    if (!c?.uri || c.line === undefined) return;
    const editor = await vscode.window.showTextDocument(c.uri, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    const pos = new vscode.Position(c.line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    this.decorate();
  }

  private async showFix(): Promise<void> {
    const fix = this.current?.v.fix;
    if (!fix || "stale" in fix) return;
    const original = vscode.Uri.file(fix.absPath);
    const proposed = vscode.Uri.from({ scheme: FIX_SCHEME, path: `/${path.basename(fix.absPath)}`, query: String(Date.now()) });
    this.fixDocs.set(proposed.toString(), fix.patched);
    await vscode.commands.executeCommand("vscode.diff", original, proposed, `${path.basename(fix.absPath)} ↔ proposed fix (preview)`);
  }

  private decorate(): void {
    const c = this.current;
    for (const editor of vscode.window.visibleTextEditors) {
      const isTarget = c?.marked && c.uri && c.line !== undefined && editor.document.uri.toString() === c.uri.toString();
      editor.setDecorations(this.highlight, isTarget ? [new vscode.Range(c.line!, 0, c.line!, 0)] : []);
    }
  }

  private clearMarkers(): void {
    this.diagnostics.clear();
    if (this.current) this.current.marked = false;
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.highlight, []);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
