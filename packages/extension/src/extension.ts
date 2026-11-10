import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  PROTOCOL_VERSION,
  SESSION_DIR,
  SESSION_FILE,
  parseDebugPrefix,
  type BugEvent,
  type ClientMessage,
  type ServerMessage,
  type SessionInfo,
  type VoicePayload,
} from "@voice-bug/shared";
import { stripDebugPrefixes } from "./lines";
import { describeListenError, startHub, type Hub } from "./hub";
import { findWorkspaceRoot, startDevServer, type DevServer } from "./devServer";
import { formatEvent } from "./format";
import { readFileSync } from "node:fs";
import { EventStore } from "./buffer";
import { BUNDLE_WINDOW_MS, collectBundle } from "./collect";
import type { Bundle } from "./bundle";
import type { PanelExtras } from "./diagnosis/panelHtml";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, ollamaGenerate } from "./diagnosis/ollama";
import { readEnvVar } from "./redact";
import {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  THINKING_LEVELS,
  describeModelError,
  errorStatus,
  geminiGenerate,
  isAbort,
  withFallback,
  withRetry,
  type Thinking,
} from "./diagnosis/gemini";
import { DiagnosisError, describeStage, runDiagnosis } from "./diagnosis/run";
import { DiagnosisView } from "./diagnosis/view";
import { isRetryPhrase, parseTrigger, spokenSummary } from "./voice/trigger";
import { DEFAULT_TRANSCRIBE_MODEL, geminiTranscribe } from "./voice/transcribe";

const API_KEY_SECRET = "voiceBug.geminiApiKey";
let secrets: vscode.SecretStorage;
let diagnosisView: DiagnosisView;

const store = new EventStore();
/** Pages that have connected this session, for the bundle header. */
const pages = new Set<string>();
/** Bundles shown this session, served read-only from memory to the Markdown preview. */
const BUNDLE_SCHEME = "voice-bug-bundle";
const bundleDocs = new Map<string, string>();

let hub: Hub | undefined;
let sessionFilePath: string | undefined;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let devServer: DevServer | undefined;
let devTerminal: vscode.Terminal | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Voice Bug");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "voiceBug.showOutput";
  secrets = context.secrets;
  diagnosisView = new DiagnosisView(() => {
    const last = [...bundleDocs.keys()].at(-1);
    if (last) void vscode.commands.executeCommand("markdown.showPreviewToSide", vscode.Uri.parse(last));
  });
  context.subscriptions.push(
    output,
    status,
    diagnosisView,
    vscode.commands.registerCommand("voiceBug.setGeminiApiKey", setApiKey),
    vscode.commands.registerCommand("voiceBug.clearGeminiApiKey", async () => {
      await secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage("Voice Bug: stored Gemini API key removed.");
    }),
    vscode.commands.registerCommand("voiceBug.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("voiceBug.restartHub", restart),
    vscode.commands.registerCommand("voiceBug.startDevServer", startDev),
    vscode.commands.registerCommand("voiceBug.stopDevServer", stopDev),
    vscode.commands.registerCommand("voiceBug.diagnoseLastError", diagnoseLastError),
    vscode.commands.registerCommand("voiceBug.refineDiagnosis", refineCommand),
    vscode.commands.registerCommand("voiceBug.retryLastRequest", () => retryLastRequest()),
    vscode.workspace.registerTextDocumentContentProvider(BUNDLE_SCHEME, {
      provideTextDocumentContent: (uri) => bundleDocs.get(uri.toString()) ?? "This bundle is no longer in memory.",
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("voiceBug.port")) {
        output.appendLine("voiceBug.port changed — restarting capture hub");
        void restart();
      }
    }),
  );
  await start();
}

export async function deactivate(): Promise<void> {
  await devServer?.stop();
  await stop();
}

/** Every captured event goes through here: into the ring buffers, and echoed to the output. */
function record(event: BugEvent): void {
  store.record(event);
  output.appendLine(formatEvent(event));
}

/** Folders source files may be read from for the bundle; the repo root comes first. */
function sourceRoots(): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const devCwd = resolveDevCwd();
  return [...new Set([...folders.map(findWorkspaceRoot), ...(devCwd ? [devCwd] : []), ...folders])];
}

/** Keeps a bundle as a read-only in-memory document (never written to disk). */
function rememberBundle(text: string): vscode.Uri {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "-");
  const uri = vscode.Uri.from({ scheme: BUNDLE_SCHEME, path: `/Voice Bug bundle ${stamp}.md` });
  bundleDocs.set(uri.toString(), text);
  // Keep only the last few in memory.
  for (const key of [...bundleDocs.keys()].slice(0, -10)) bundleDocs.delete(key);
  return uri;
}

/** Shows a bundle in the Markdown preview. */
async function previewBundle(text: string): Promise<vscode.Uri> {
  const uri = rememberBundle(text);
  await vscode.commands.executeCommand("markdown.showPreviewToSide", uri);
  return uri;
}

/** SecretStorage first, then GEMINI_API_KEY from the environment or the repo's .env files. */
async function getApiKey(roots: string[]): Promise<string | undefined> {
  const stored = await secrets.get(API_KEY_SECRET);
  if (stored) return stored;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  for (const root of roots) {
    for (const name of [".env.local", ".env"]) {
      const content = await fs.readFile(path.join(root, name), "utf8").catch(() => "");
      const value = readEnvVar(content, "GEMINI_API_KEY");
      if (value) return value;
    }
  }
  return undefined;
}

async function setApiKey(): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: "Voice Bug: Gemini API key",
    prompt: "Stored in VS Code's encrypted secret storage, never in a file. Get one at https://aistudio.google.com/apikey",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length < 20 ? "That doesn't look like an API key." : undefined),
  });
  if (!key) return false;
  await secrets.store(API_KEY_SECRET, key.trim());
  void vscode.window.showInformationMessage("Voice Bug: Gemini API key saved.");
  return true;
}

/** Set while a diagnosis runs, so a second trigger doesn't start a parallel one. */
let diagnosing = false;

/** The last diagnosis, kept so a follow-up sentence (or the Refine command) can revise it. */
type LastDiagnosis = {
  bundle: Bundle;
  expected?: string;
  /** Raw JSON of the latest answer; the refinement turn builds on it. */
  answer: string;
  images: Img[];
  screenshot?: PanelExtras["screenshot"];
  at: number;
  clientId?: number;
};
let lastDiagnosis: LastDiagnosis | undefined;
/** A spoken sentence this soon after a diagnosis refines it instead of being discarded. */
const REFINE_WINDOW_MS = 30_000;
/** Voice sends skip the confirmation only after it has been approved once per session. */
let voiceSendApproved = false;

type Img = { mimeType: string; data: string };

/** The command: asks what was expected, previews the bundle and (by default) confirms before sending. */
async function diagnoseLastError(): Promise<void> {
  await diagnose(undefined);
}

async function refineCommand(): Promise<void> {
  if (!lastDiagnosis) {
    void vscode.window.showInformationMessage("Voice Bug: there's no diagnosis to refine yet.");
    return;
  }
  const text = await vscode.window.showInputBox({
    title: "Voice Bug: refine the diagnosis",
    prompt: "What did it get wrong, or what should it know? (answers its follow-up question too)",
    placeHolder: "e.g. The save works, the problem is the list doesn't refresh",
    ignoreFocusOut: true,
  });
  if (text?.trim()) await diagnose(undefined, text.trim());
}

type VoiceTrigger = { clientId: number; note: string; via: "voice" | "keyboard"; transcript: string };

function tellPage(clientId: number | undefined, msg: ServerMessage): void {
  if (clientId !== undefined) hub?.send(clientId, msg);
}

/** Screenshots from the page, newest last, kept in memory like the event buffers. */
const screenshots: Array<{ ts: number; reason: "click" | "error"; data: string }> = [];

function recordScreenshot(msg: Extract<ClientMessage, { kind: "screenshot" }>): void {
  screenshots.push({ ts: msg.ts, reason: msg.reason, data: msg.data });
  const cutoff = Date.now() - 90_000;
  while (screenshots.length > 10 || (screenshots[0] && screenshots[0].ts < cutoff)) screenshots.shift();
}

/** The two most recent screenshots in the bundle window (they show what the user saw last). */
function pickScreenshots(): Array<{ ts: number; reason: "click" | "error"; data: string }> {
  if (!config().get<boolean>("sendScreenshots", true)) return [];
  const from = Date.now() - BUNDLE_WINDOW_MS;
  return screenshots.filter((s) => s.ts >= from).slice(-2);
}

/**
 * Freeze → bundle → (command: ask what was expected → preview → confirm) →
 * one Gemini call → validate → panel. A voice trigger skips the prompts
 * (after the first approval of the session): the spoken sentence is the
 * expectation and the developer's eyes are on the app, so progress and the
 * result are spoken back. `refine` revises the last diagnosis instead.
 * Never edits code.
 */
async function diagnose(voice: VoiceTrigger | undefined, refine?: string): Promise<void> {
  if (diagnosing) {
    tellPage(voice?.clientId, { kind: "say", text: "Still working on the last one." });
    void vscode.window.showInformationMessage("Voice Bug: a diagnosis is already running.");
    return;
  }
  diagnosing = true;
  try {
    if (refine !== undefined) await refineInner(refine, voice?.clientId);
    else await diagnoseInner(voice);
  } finally {
    diagnosing = false;
  }
}

async function diagnoseInner(voice: VoiceTrigger | undefined): Promise<void> {
  const roots = sourceRoots();
  if (!roots.length) {
    void vscode.window.showErrorMessage("Voice Bug: open a folder first.");
    return;
  }
  if (voice) {
    // The report itself goes on the timeline, so the model sees when it was made relative to the evidence.
    const payload: VoicePayload = { text: voice.transcript, note: voice.note, via: voice.via };
    record({ ts: Date.now(), source: "voice", type: voice.via === "voice" ? "transcript" : "keyboard", payload });
  }
  // Freeze first, so what happens while the developer types doesn't change the evidence.
  const shots = pickScreenshots();
  const bundle = await collectBundle({
    store,
    roots,
    // The app being debugged is the open folder (F5 opens demo-app), not the whole monorepo.
    searchRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    pages: [...pages],
    secrets: hub ? [hub.token] : [],
    screenshots: shots,
  });
  output.appendLine(
    `Bundle: ${bundle.eventCount} events, ${bundle.errorCount} errors${bundle.anchorRef ? ` (last ${bundle.anchorRef})` : ""}, ` +
      `${bundle.sourceFiles.length} source excerpt(s), ${shots.length} screenshot(s), ${bundle.redactions} redaction(s), ${bundle.text.length} chars`,
  );
  if (!bundle.eventCount) {
    void vscode.window.showInformationMessage("Voice Bug: nothing captured in the last 60 seconds. Reproduce the bug, then try again.");
    return;
  }

  const confirm = config().get<boolean>("confirmBeforeSending", true);
  const sendSummary = `${bundle.text.length} chars, ${shots.length} screenshot(s), ${bundle.redactions} redaction(s)`;
  let expected: string | undefined;
  if (voice) {
    expected = voice.note;
    if (confirm && !voiceSendApproved) {
      // Privacy: the first voice send of a session is previewed and approved like the command's.
      tellPage(voice.clientId, { kind: "say", text: "Please check what will be sent in VS Code, once." });
      tellPage(voice.clientId, { kind: "status", state: "diagnosing", text: "Approve the first send in VS Code (once per session)…" });
      await previewBundle(bundle.text);
      const choice = await vscode.window.showInformationMessage(
        `Voice Bug: send this bundle to Gemini? (${sendSummary}). Later voice reports this session are sent without asking.`,
        "Send, and don't ask again this session",
        "Cancel",
      );
      if (choice !== "Send, and don't ask again this session") {
        tellPage(voice.clientId, { kind: "status", state: "idle", text: "Not sent." });
        return;
      }
      voiceSendApproved = true;
    } else {
      // The bundle stays viewable from the panel's "view bundle sent".
      rememberBundle(bundle.text);
    }
  } else {
    expected = await vscode.window.showInputBox({
      title: "Voice Bug: what did you expect to happen?",
      prompt: "Optional: press Enter to skip, Escape to cancel.",
      placeHolder: "e.g. Saving with an empty title should show an error",
      ignoreFocusOut: true,
    });
    if (expected === undefined) return;

    // Privacy: the developer sees exactly what will be sent.
    await previewBundle(bundle.text);
    if (confirm) {
      const choice = await vscode.window.showInformationMessage(`Voice Bug: send this bundle to Gemini? (${sendSummary})`, "Send to Gemini", "Cancel");
      if (choice !== "Send to Gemini") return;
    }
  }

  const images = shots.map((s) => ({ mimeType: "image/jpeg", data: s.data }));
  const latest = shots.at(-1);
  const screenshot = latest ? { dataUri: `data:image/jpeg;base64,${latest.data}`, caption: `S${shots.length}: after a ${latest.reason} (${new Date(latest.ts).toLocaleTimeString()})` } : undefined;
  await callModel({ bundle, expected, images, screenshot, clientId: voice?.clientId });
}

async function refineInner(text: string, clientId: number | undefined): Promise<void> {
  const last = lastDiagnosis;
  if (!last) return;
  output.appendLine(`Refining the last diagnosis with: “${text}”`);
  tellPage(clientId, { kind: "status", state: "diagnosing", text: "Refining the diagnosis…" });
  // Same frozen bundle and images; only the developer's new sentence is added.
  await callModel({ bundle: last.bundle, expected: last.expected, images: last.images, screenshot: last.screenshot, clientId, followUp: { previousAnswer: last.answer, text } });
}

type ModelRequest = {
  bundle: Bundle;
  expected?: string;
  images: Img[];
  screenshot?: PanelExtras["screenshot"];
  clientId?: number;
  followUp?: { previousAnswer: string; text: string };
};

/**
 * The last request that failed (Gemini busy, timeout, cancelled, bad answer),
 * kept exactly as sent, frozen bundle included, so it can be sent again
 * without reproducing the bug. In memory only; dropped after a success or
 * after RETRY_KEEP_MS.
 */
let failedRequest: { req: ModelRequest; at: number; reason: string } | undefined;
const RETRY_KEEP_MS = 30 * 60_000;

function retryAvailable(): boolean {
  if (failedRequest && Date.now() - failedRequest.at > RETRY_KEEP_MS) failedRequest = undefined;
  return !!failedRequest;
}

/** Sends the saved failed request again (same bundle, expectation and screenshots). */
async function retryLastRequest(clientId?: number): Promise<void> {
  if (!retryAvailable()) {
    tellPage(clientId, { kind: "status", state: "idle", text: "Nothing to retry." });
    void vscode.window.showInformationMessage("Voice Bug: there's no failed request to retry (they're kept for 30 minutes).");
    return;
  }
  if (diagnosing) {
    void vscode.window.showInformationMessage("Voice Bug: a diagnosis is already running.");
    return;
  }
  const saved = failedRequest!;
  const age = Math.round((Date.now() - saved.at) / 1000);
  output.appendLine(`Retrying the request that failed ${age}s ago (${saved.reason}).`);
  tellPage(clientId ?? saved.req.clientId, { kind: "say", text: "Trying again." });
  diagnosing = true;
  try {
    await callModel({ ...saved.req, clientId: clientId ?? saved.req.clientId });
  } finally {
    diagnosing = false;
  }
}

/** Error notification with a Retry button; doesn't block the caller. */
function showFailure(message: string): void {
  void vscode.window.showErrorMessage(`Voice Bug: ${message}`, "Retry").then((choice) => {
    if (choice === "Retry") void retryLastRequest();
  });
}

/** Model call with progress, fallbacks (Gemini → lighter Gemini → local Ollama) and the result shown. */
async function callModel(opts: ModelRequest): Promise<void> {
  const { bundle, clientId } = opts;
  const roots = sourceRoots();
  let apiKey = await getApiKey(roots);
  if (!apiKey) {
    if (clientId !== undefined) {
      tellPage(clientId, { kind: "say", text: "Set your Gemini API key in VS Code first." });
      void vscode.window.showErrorMessage("Voice Bug: no Gemini API key. Run \"Voice Bug: Set Gemini API Key\".");
      return;
    }
    if (!(await setApiKey())) return;
    apiKey = await getApiKey(roots);
    if (!apiKey) return;
  }

  const model = config().get<string>("geminiModel", DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const thinkingSetting = config().get<string>("geminiThinking", "low");
  const thinking: Thinking = (THINKING_LEVELS as readonly string[]).includes(thinkingSetting) ? (thinkingSetting as Thinking) : "low";
  const timeoutMs = Math.max(10, config().get<number>("geminiTimeoutSeconds", 90)) * 1000;

  // What the notification shows; a timer re-renders it every half second with the elapsed time.
  let progressText = "Starting…";
  const setStatus = (text: string, log = true) => {
    if (text === progressText) return;
    progressText = text;
    if (log) {
      output.appendLine(`  ${text}`);
      tellPage(clientId, { kind: "status", state: "diagnosing", text });
    }
  };
  const fallback = config().get<string>("geminiFallbackModel", DEFAULT_FALLBACK_MODEL).trim();
  const ollamaModel = config().get<string>("ollamaModel", DEFAULT_OLLAMA_MODEL).trim();
  const ollamaUrl = config().get<string>("ollamaUrl", DEFAULT_OLLAMA_URL).trim() || DEFAULT_OLLAMA_URL;
  const chain = [...new Set([model, fallback].filter(Boolean))].map((name) => ({
    name,
    generate: withRetry(geminiGenerate(apiKey, name, thinking), {
      attempts: 3,
      baseDelayMs: 2000,
      onRetry: ({ attempt, attempts, delayMs, err }) =>
        setStatus(`${name} is busy or rate-limited (${errorStatus(err) ?? "error"}); retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${attempts})…`),
    }),
  }));
  if (ollamaModel) chain.push({ name: `ollama:${ollamaModel}`, generate: ollamaGenerate(ollamaUrl, ollamaModel) });
  const generate = withFallback(chain, (from, to) => setStatus(`${from} is unavailable; switching to ${to}…`));

  output.appendLine(`Asking ${model} (thinking: ${thinking}, timeout ${timeoutMs / 1000}s)…`);
  try {
    const run = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Voice Bug: ${opts.followUp ? "refining" : "diagnosing"} with ${model}`, cancellable: true },
      async (progress, token) => {
        const cancel = new AbortController();
        token.onCancellationRequested(() => cancel.abort(new DOMException("Cancelled", "AbortError")));
        const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(timeoutMs)]);
        const started = Date.now();
        const render = () => progress.report({ message: `${progressText} (${Math.round((Date.now() - started) / 1000)}s)` });
        const timer = setInterval(render, 500);
        render();
        try {
          return await runDiagnosis({
            bundle,
            expected: opts.expected,
            generate,
            readFile: readFileSafe,
            signal,
            images: opts.images,
            followUp: opts.followUp,
            // Character counts change constantly; only log the other stages.
            onStage: (s) => setStatus(describeStage(s, bundle.text.length), s.stage !== "answering"),
          });
        } finally {
          clearInterval(timer);
        }
      },
    );
    const d = run.result.diagnosis;
    const answeredBy = generate.lastModel();
    output.appendLine(
      `Diagnosis (${answeredBy}, ${(run.ms / 1000).toFixed(1)}s, ${run.calls} call(s), ` +
        `${run.usage.inputTokens} in / ${run.usage.thinkingTokens} thinking / ${run.usage.outputTokens} out tokens): ` +
        `${d.title} — ${d.rootCause.file || "no file"}:${d.rootCause.line} (${d.rootCause.confidence})`,
    );
    diagnosisView.show(
      run.result,
      bundle.text,
      { model: answeredBy, ms: run.ms, calls: run.calls, ...run.usage },
      {
        screenshot: opts.screenshot,
        refinedWith: opts.followUp?.text,
        note: answeredBy.startsWith("ollama:") ? `Answered by the local model ${answeredBy.slice(7)} because Gemini was unavailable.` : undefined,
      },
    );
    lastDiagnosis = { bundle, expected: opts.expected, answer: run.answer, images: opts.images, screenshot: opts.screenshot, at: Date.now(), clientId };
    failedRequest = undefined;
    if (clientId !== undefined) {
      tellPage(clientId, { kind: "status", state: "done", text: `Ready in VS Code: ${d.title}. Add a follow-up within 30s to refine it.` });
      tellPage(clientId, { kind: "say", text: spokenSummary(d) });
    }
  } catch (err) {
    let spoken = "Sorry, the diagnosis failed. Say try again, or retry from VS Code.";
    let reason: string;
    if (err instanceof DiagnosisError) {
      reason = "the answer failed validation";
      output.appendLine(`ERROR ${err.message}`);
      for (const p of err.problems) output.appendLine(`  - ${p}`);
      showFailure(`${err.message} See the Voice Bug output.`);
    } else if (isAbort(err) && (err as Error).name === "AbortError") {
      reason = "cancelled";
      output.appendLine("Diagnosis cancelled. Run \"Voice Bug: Retry Last Request\" to send it again.");
      spoken = "Cancelled.";
    } else {
      const message = describeModelError(err);
      reason = message;
      output.appendLine(`ERROR ${message}`);
      showFailure(message);
      if (errorStatus(err) === 503 || errorStatus(err) === 429) spoken = "Gemini is busy right now. Say try again in a minute.";
    }
    // Keep it so the developer doesn't have to reproduce the bug to try again.
    failedRequest = { req: opts, at: Date.now(), reason };
    output.appendLine(`  Request saved for retry (kept ${RETRY_KEEP_MS / 60_000} min): "Voice Bug: Retry Last Request", the Retry button, or say "try again".`);
    if (clientId !== undefined) {
      tellPage(clientId, { kind: "status", state: "error", text: spoken, canRetry: true });
      tellPage(clientId, { kind: "say", text: spoken });
    }
  }
}

/**
 * One utterance from the overlay: transcribe with Gemini, keep it only if it
 * contains a trigger phrase, then acknowledge aloud and diagnose. Audio and
 * non-trigger transcripts are never stored or logged.
 */
async function handleAudio(msg: Extract<ClientMessage, { kind: "audio" }>, clientId: number): Promise<void> {
  // Resolves the overlay's "transcribing…" transcript line when nothing gets transcribed.
  const notTranscribed = () => tellPage(clientId, { kind: "transcript", id: msg.id, text: "", triggered: false, role: "ignored" });
  if (diagnosing) {
    notTranscribed();
    tellPage(clientId, { kind: "status", state: "diagnosing", text: "Still diagnosing the last bug…" });
    return;
  }
  const apiKey = await getApiKey(sourceRoots());
  if (!apiKey) {
    notTranscribed();
    tellPage(clientId, { kind: "status", state: "error", text: "No Gemini API key: run “Voice Bug: Set Gemini API Key” in VS Code." });
    return;
  }
  tellPage(clientId, { kind: "status", state: "transcribing", text: "Transcribing…" });
  const primary = config().get<string>("transcribeModel", DEFAULT_TRANSCRIBE_MODEL).trim() || DEFAULT_TRANSCRIBE_MODEL;
  const fallback = config().get<string>("geminiFallbackModel", DEFAULT_FALLBACK_MODEL).trim();
  const started = Date.now();
  let text: string | undefined;
  let lastErr: unknown;
  for (const model of [...new Set([primary, fallback].filter(Boolean))]) {
    try {
      text = await geminiTranscribe(apiKey, model)(msg.data, AbortSignal.timeout(20_000));
      break;
    } catch (err) {
      lastErr = err;
      // A bad key won't work on the fallback either.
      if (errorStatus(err) === 401 || errorStatus(err) === 403) break;
      output.appendLine(`Transcription with ${model} failed (${errorStatus(err) ?? (err as Error)?.message}); ${model === fallback ? "giving up" : `trying ${fallback}`}.`);
    }
  }
  if (text === undefined) {
    const message = describeModelError(lastErr);
    output.appendLine(`ERROR Transcription failed: ${message}`);
    notTranscribed();
    tellPage(clientId, { kind: "status", state: "error", text: "Transcription failed (see the Voice Bug output in VS Code)." });
    return;
  }

  // "Try again" resends the saved failed request; it doesn't need a new bundle.
  if (isRetryPhrase(text) && retryAvailable()) {
    tellPage(clientId, { kind: "transcript", id: msg.id, text, triggered: true, role: "retry" });
    await retryLastRequest(clientId);
    return;
  }

  const trigger = parseTrigger(text);
  // Shortly after a diagnosis, a sentence without a trigger phrase is a follow-up to it.
  const refining = !trigger.triggered && !!text && lastDiagnosis?.clientId === clientId && Date.now() - lastDiagnosis.at < REFINE_WINDOW_MS;
  tellPage(clientId, {
    kind: "transcript",
    id: msg.id,
    text,
    triggered: trigger.triggered || refining,
    role: refining ? "followup" : trigger.triggered ? "report" : "ignored",
  });
  if (refining) {
    output.appendLine(`Voice follow-up (${Date.now() - started}ms): “${text}”`);
    tellPage(clientId, { kind: "say", text: "Okay, updating the diagnosis." });
    await diagnose({ clientId, note: "", via: "voice", transcript: text }, text);
    return;
  }
  if (!trigger.triggered) {
    // Privacy: not a bug report, so the words aren't kept anywhere.
    output.appendLine(`Voice: ${(msg.durationMs / 1000).toFixed(1)}s utterance, no trigger phrase (discarded, ${Date.now() - started}ms).`);
    tellPage(clientId, { kind: "status", state: "idle", text: "Listening for “that's a bug…”" });
    return;
  }
  output.appendLine(`Voice trigger (${Date.now() - started}ms): “${text}”`);
  tellPage(clientId, { kind: "say", text: "Got it, looking into it." });
  await diagnose({ clientId, note: trigger.note, via: "voice", transcript: text });
}

async function handleKeyboardTrigger(clientId: number): Promise<void> {
  output.appendLine("Keyboard trigger from the page (Ctrl+Shift+B).");
  tellPage(clientId, { kind: "say", text: "Got it, looking into it." });
  await diagnose({ clientId, note: "", via: "keyboard", transcript: "" });
}

function readFileSafe(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("voiceBug");
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

async function start(): Promise<void> {
  const port = config().get<number>("port", 0);
  try {
    hub = await startHub({
      port,
      onConnect: (c) => {
        output.appendLine(`Client ${c.id} connected (${c.origin})`);
        updateStatus();
      },
      onDisconnect: (c) => {
        output.appendLine(`Client ${c.id} disconnected`);
        updateStatus();
      },
      onWarning: (m) => output.appendLine(`WARN ${m}`),
      onMessage: (msg, c) => {
        if (msg.kind === "hello") {
          const mismatch = msg.protocol !== PROTOCOL_VERSION ? ` (protocol ${msg.protocol}, expected ${PROTOCOL_VERSION})` : "";
          output.appendLine(`Client ${c.id} hello from ${msg.url}${mismatch}`);
          pages.add(msg.url);
        } else if (msg.kind === "event") {
          record(msg.event);
        } else if (msg.kind === "audio") {
          void handleAudio(msg, c.id);
        } else if (msg.kind === "trigger") {
          void handleKeyboardTrigger(c.id);
        } else if (msg.kind === "screenshot") {
          recordScreenshot(msg);
        } else if (msg.kind === "retry") {
          void retryLastRequest(c.id);
        }
      },
    });
  } catch (err) {
    const message = describeListenError(err, port);
    output.appendLine(`ERROR Failed to start capture hub. ${message}`);
    output.show(true);
    void vscode.window.showErrorMessage(`Voice Bug: ${message}`);
    updateStatus();
    return;
  }

  output.appendLine(`Capture hub listening on ws://127.0.0.1:${hub.port}${port ? " (fixed port from voiceBug.port)" : ""}`);
  await writeSessionFile(hub);
  updateStatus();
}

async function stop(): Promise<void> {
  if (sessionFilePath) {
    await fs.rm(sessionFilePath, { force: true }).catch(() => {});
    sessionFilePath = undefined;
  }
  await hub?.close();
  hub = undefined;
  updateStatus();
}

/** Lets the dev-server plugin discover the port + token. */
async function writeSessionFile(h: Hub): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    output.appendLine("No workspace folder open — the SDK must be initialised with the port/token manually.");
    output.appendLine(`  port=${h.port}`);
    return;
  }
  const dir = path.join(folder.uri.fsPath, SESSION_DIR);
  await fs.mkdir(dir, { recursive: true });
  sessionFilePath = path.join(dir, SESSION_FILE);
  const info: SessionInfo = { port: h.port, token: h.token, pid: process.pid };
  await fs.writeFile(sessionFilePath, JSON.stringify(info, null, 2), { mode: 0o600 });
  output.appendLine(`Session file written to ${sessionFilePath}`);
}

function resolveDevCwd(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const configured = config().get<string>("devCwd", "").trim();
  if (!configured) return folder && findWorkspaceRoot(folder);
  if (path.isAbsolute(configured)) return configured;
  return folder ? path.resolve(folder, configured) : undefined;
}

/** A terminal that only displays what the dev server writes; Ctrl+C stops it. */
function createDevTerminal(onInput: (data: string) => void, onClose: () => void) {
  const writeEmitter = new vscode.EventEmitter<string>();
  let opened = false;
  const pending: string[] = [];
  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    open: () => {
      opened = true;
      for (const text of pending.splice(0)) writeEmitter.fire(text);
    },
    close: onClose,
    handleInput: onInput,
  };
  const write = (text: string) => {
    // Terminals need \r\n; a lone \n would leave the cursor in the same column.
    const normalized = text.replace(/\r?\n/g, "\r\n");
    if (opened) writeEmitter.fire(normalized);
    else pending.push(normalized);
  };
  return { pty, write, dispose: () => writeEmitter.dispose() };
}

async function startDev(): Promise<void> {
  if (devServer?.running()) {
    void vscode.window.showInformationMessage("Voice Bug: the dev server is already running.");
    devTerminal?.show(true);
    return;
  }
  const command = config().get<string>("devCommand", "pnpm dev:demo").trim();
  const cwd = resolveDevCwd();
  if (!command) {
    void vscode.window.showErrorMessage('Voice Bug: "voiceBug.devCommand" is empty.');
    return;
  }
  if (!cwd) {
    void vscode.window.showErrorMessage('Voice Bug: open a folder or set "voiceBug.devCwd" to an absolute path.');
    return;
  }

  devTerminal?.dispose();
  let server: DevServer | undefined;
  const term = createDevTerminal(
    (data) => {
      if (data === "\x03") void stopDev();
    },
    () => {
      // The user closed the terminal: take the server down with it.
      if (server && server === devServer && server.running()) void stopDev();
    },
  );
  devTerminal = vscode.window.createTerminal({ name: "Voice Bug: dev server", pty: term.pty });
  devTerminal.show(true);
  term.write(`\x1b[2m$ ${command}  (in ${cwd})\x1b[0m\n`);

  server = startDevServer({
    command,
    cwd,
    onOutput: (_stream, text) => term.write(stripDebugPrefixes(text)),
    onLine: (stream, raw) => {
      // The middleware tags lines written while handling a request: "[debug:<id>] …".
      const { debugId, line } = parseDebugPrefix(raw);
      if (!line.trim()) return;
      const event: BugEvent = { ts: Date.now(), source: "backend", type: stream, payload: { line } };
      if (debugId) event.debugId = debugId;
      record(event);
    },
    onError: (err) => {
      output.appendLine(`ERROR Dev server failed to start: ${err.message}`);
      term.write(`\x1b[31mFailed to start: ${err.message}\x1b[0m\n`);
      void vscode.window.showErrorMessage(`Voice Bug: dev server failed to start (${err.message}).`);
    },
    onExit: (code, signal) => {
      record({ ts: Date.now(), source: "backend", type: "exit", payload: { code, signal } });
      term.write(`\n\x1b[2m[dev server exited${signal ? ` (${signal})` : code !== null ? ` with code ${code}` : ""}]\x1b[0m\n`);
    },
  });
  devServer = server;
  record({ ts: Date.now(), source: "backend", type: "start", payload: { command, cwd, pid: server.pid } });
}

async function stopDev(): Promise<void> {
  const server = devServer;
  if (!server?.running()) {
    void vscode.window.showInformationMessage("Voice Bug: the dev server is not running.");
    return;
  }
  output.appendLine("Stopping dev server…");
  await server.stop();
  if (server.running()) {
    output.appendLine(`WARN Dev server (pid ${server.pid}) did not exit.`);
    void vscode.window.showWarningMessage("Voice Bug: the dev server did not stop. Check the process list.");
  }
}

function updateStatus(): void {
  if (!status) return;
  if (!hub) {
    status.text = "$(circle-slash) Voice Bug: off";
    status.tooltip = "Capture hub is not running";
  } else {
    const n = hub.clientCount();
    status.text = n > 0 ? `$(record) Voice Bug: capturing (${n})` : "$(circle-outline) Voice Bug: waiting";
    status.tooltip = n > 0 ? `${n} page(s) connected — capture stays in memory locally` : "No app connected yet";
  }
  status.show();
}
