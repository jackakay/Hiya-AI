# Voice Bug Reporter — Project Brief

## What this is
A prototype for a voice AI product challenge (Real-Time Assistance track). A developer manually testing a web app says one sentence when they see a bug (e.g. "that's a bug, save did nothing") and keeps testing. In the background, the system captures the last ~60s of their actions, frontend errors, network requests and backend terminal logs, correlates them on one timeline, finds the responsible code, and opens a diagnosis panel in VS Code with the root cause and a proposed fix.

## Why voice (the core pitch — keep the design faithful to this)
- The bug appears while the developer's eyes are on the app and hands are on the mouse. Speaking is the only way to report it without breaking flow.
- The spoken sentence carries what no log contains: what they *expected* to happen.
- Differentiator vs Copilot/Claude/Cursor: those start when asked and only see code/terminal. This tool is always capturing (local ring buffer), so it records the minute *before* the bug was noticed, links click → request → backend stack trace → source line exactly, and captures intent at the moment of failure.
- Pitch line: "AI coding tools can fix a bug once you've explained it. This one was watching when it happened, so you don't have to."

## Design principles (non-negotiable)
1. **Local-first:** all captured data stays in memory on the user's machine until a bug is triggered. Old data is continuously discarded.
2. **One trigger → one model call:** predictable latency, stays within free-tier limits.
3. **Exact correlation:** frontend and backend linked via an `X-Debug-Id` request header, not timestamp guessing.
4. **Evidence over inference:** repro steps come from the event log; the model explains the cause.
5. **Privacy:** scoped to localhost + the project's dev server only. Mask form inputs, redact secrets (tokens, API keys, .env values, emails) before sending. Show a preview of what will be sent. Visible recording indicator + pause.
6. **Never auto-apply code changes.** Always show a diff preview; user accepts.

## Architecture
```
 Browser (your app)                    VS Code extension (hub)
 ┌────────────────────┐  WebSocket     ┌──────────────────────────┐
 │ Capture SDK        │ ─────────────▶ │ Ring buffers (~90s)      │
 │ Voice overlay      │  127.0.0.1     │ Snapshot + redaction     │
 └────────┬───────────┘  + token       │ LLM client               │
          │ audio                      │ Diagnosis panel (webview)│
          ▼                            └───────▲─────────┬────────┘
     Groq Whisper            Dev server stdout │         │ bundle
                             (run by extension)│         ▼
                                                    Gemini Flash
```

### Components
**A. Capture SDK** (`packages/sdk`, browser, dev-only, injected via Vite plugin or script tag)
- `rrweb` for DOM + interaction recording, `maskAllInputs: true`, `checkoutEveryNms: 30000` (so every buffer slice contains a full snapshot and is replayable).
- Wrap `console.*`, `window.onerror`, `unhandledrejection`.
- `fetch`/XHR wrapper: log method, URL, status, duration; add `X-Debug-Id` header (random ID) to every request.
- Lightweight DOM screenshots (e.g. `modern-screenshot`) at clicks and errors, downscaled, keep last ~10. No screen-share/getDisplayMedia by default (less invasive).
- Sends events over WebSocket to the extension.

**B. Voice overlay** (part of SDK, framework-free floating widget)
- Mic via normal browser permission prompt. Listening indicator + pause button.
- VAD (`@ricky0123/vad-web`) to segment utterances → Groq Whisper → check for trigger phrases ("that's a bug", "bug:"); discard non-trigger transcripts. Do NOT use Chrome Web Speech API for always-on listening (streams audio to Google).
- Keyboard shortcut fallback trigger.
- TTS confirmations via `speechSynthesis` ("Got it, looking into it").
- NOTE: VS Code extensions/webviews cannot reliably access the microphone — voice lives in the browser overlay by design.

**C. Server middleware** (`packages/middleware`, Express)
- Read `X-Debug-Id`, prefix every log line for that request (including errors/stack traces) with it. ~15 lines. Other languages (Flask, Go) are future "drop-in adapters".

**D. VS Code extension** (`packages/extension`, the hub)
- Runs the dev server itself (task/child process) and owns stdout/stderr — avoids relying on terminal-reading APIs.
- WebSocket server bound to `127.0.0.1` only, random session token required.
- Ring buffers per source, time-bounded (~90s) and size-capped.
- On trigger: freeze → slice last ~60s → pull backend lines by debugId → parse stack frames → read those files (±20 lines) + truncated `git diff` → redact → preview → one Gemini call → validate JSON → panel.
- UI: webview panel (diagnosis, evidence, rrweb replay later), editor line highlight/diagnostics, `vscode.diff` preview, apply via `WorkspaceEdit` on accept.
- LLM: Gemini Flash (free tier, structured JSON output), retry with backoff on 429, Ollama fallback. Note: Gemini free tier content may be used to improve Google products — fine for the demo app, flag for real code.

## Data model (`packages/shared`)
```ts
export type Event = {
  ts: number; // Date.now()
  source: "action" | "network" | "console" | "backend" | "voice";
  type: string; // "click", "request", "error", "transcript", ...
  debugId?: string;
  payload: unknown;
};

export type Diagnosis = {
  title: string;
  summary: string;
  reproSteps: string[];
  expected: string; // from the voice note
  actual: string;   // from the evidence
  rootCause: { file: string; line: number; explanation: string; confidence: "low" | "medium" | "high" };
  evidence: string[]; // event refs supporting the claim
  proposedFix?: { file: string; diff: string }; // unified diff
  followUpQuestion?: string; // asked aloud if confidence is low
};
```

## Flows
- **Trigger:** detect → Whisper transcript → immediate TTS ack → snapshot → correlate → redact → preview → Gemini → validate schema + check diff applies → panel opens, line highlighted, TTS one-line summary.
- **Refinement:** follow-up speech within ~30s patches the current diagnosis (second call including previous result).
- **Failures:** no backend error → frontend-only diagnosis; no error at all → ticket with repro steps, no root cause; rate limited → backoff then Ollama; low confidence → ask followUpQuestion aloud; diff won't apply → show explanation, flag diff stale.
- **Latency target:** < 10s total; ack < 1s, Whisper ~1s, bundle < 0.3s, Gemini 3–7s.

## Tech stack
- TypeScript everywhere. pnpm workspace monorepo.
- Extension: VS Code API, esbuild bundler, `ws`.
- SDK: Vite build, `rrweb`, `@ricky0123/vad-web`, `modern-screenshot`.
- Panel: Preact or Svelte (or plain DOM).
- Models: `@google/genai` (Gemini), `openai` package pointed at `https://api.groq.com/openai/v1` (Whisper `whisper-large-v3-turbo`).
- Tests: Vitest for buffer, slicing, correlation and redaction logic.
- Env vars in `.env` (gitignored): `GEMINI_API_KEY`, `GROQ_API_KEY`.

## Repo layout
```
voice-bug/
├── packages/
│   ├── shared/       # Event + Diagnosis types
│   ├── sdk/          # capture + voice overlay
│   ├── middleware/   # Express debug-ID logger
│   └── extension/    # VS Code extension (hub + UI)
└── demo-app/         # deliberately buggy React (Vite) + Express app
```

## Demo app
React + Express with deliberate bugs. First planted bug: `POST /api/save` does `req.body.name.trim()` → crashes when the form is submitted empty (frontend shows nothing happened; backend logs TypeError). Add more varied bugs later (frontend-only error, wrong status handling, race condition).

## Milestones (build in this order; commit after each)
1. **Pipeline:** extension starts WebSocket server; SDK sends click events; extension logs them to an Output Channel. Test via F5 (Extension Development Host).
2. **Capture:** errors, console, fetch wrapper, then rrweb. Extension runs the dev server and captures output.
3. **Bundle:** ring buffers + "Diagnose last error" command that prints the bundle (no AI).
4. **Correlation:** X-Debug-Id + middleware; planted bug's click links to its stack trace.
5. **Diagnosis:** Gemini call, schema validation, panel with highlighted line. ← minimum viable demo.
6. **Voice:** overlay, VAD, Whisper, TTS acks.
7. **Polish:** diff preview/apply, refinement, rrweb replay in panel, redaction preview.

## Current status
Milestone 1 (pipeline) done: hub in `packages/extension/src/hub.ts` (127.0.0.1, token + localhost-origin check), SDK click capture, Vite plugin that injects the SDK using `.voice-bug/session.json`, demo app with planted bug 1.

Milestone 2a (capture without rrweb) done:
- `voiceBug.port` setting (0 = random; fixed port for Codespace forwarding). EADDRINUSE produces a clear error in the Voice Bug output (`describeListenError` in `hub.ts`).
- SDK (`packages/sdk/src/capture/`): `console.ts` wraps log/info/warn/error/debug and skips `[voice-bug]`-prefixed messages and anything logged while emitting. `serialize.ts` does bounded serialization. `errors.ts` handles window `error` (capture phase, so resource errors are included) and `unhandledrejection`. `network.ts` wraps fetch and XHR (no bodies; the hub URL is ignored). It has a `decorateRequest` hook that can add headers and a `debugId`, which is unused until the X-Debug-Id work in milestone 4.
- Shared payload types: `ConsolePayload`, `ErrorPayload`, `NetworkPayload`, `Backend*Payload`.
- Extension: `devServer.ts` spawns `voiceBug.devCommand` in `voiceBug.devCwd` through a shell (`FORCE_COLOR=1`). On Windows, stop uses `taskkill /T /F`; on POSIX it signals the process group. `lines.ts` has `LineSplitter` and `stripAnsi`. Each non-blank line becomes a `backend/stdout|stderr` event, and the raw output is mirrored to a Pseudoterminal (Ctrl+C or closing it stops the server). `extension.ts` `record()` is the single sink for events; it only prints for now.

Milestone 3 (bundle, no AI) done:
- `buffer.ts`: `RingBuffer` per source (90s, count caps) and `EventStore.snapshot(windowMs)`, which returns a frozen copy merged by `ts` with arrival order kept on ties.
- `bundle.ts` (pure): `isErrorEvent`, `framesFor` (a backend stack is the run of `at …` lines after the error line), `resolveFrameFile` (absolute path, dev-server URL or `/@fs/`, only inside roots), `excerpt` (±20 lines, target marked `>`), `compactStackLines`, `buildBundle` → Markdown with event refs `E1…`, last error, timeline relative to it, code frames, source excerpts and truncated git diff. Then everything is redacted.
- `stack.ts`: V8 frame parsing and `isInternalFrame`. `redact.ts`: secrets, key formats, query params, quoted secret literals, emails, URL credentials, `.env` values, and path shortening to `<root>`/`~`.
- `collect.ts`: the I/O half. It snapshots the store and reads files (≤512 KB), `.env*` values and `git diff HEAD` (excluding lockfiles, `*.md` and dist). Command **Voice Bug: Diagnose Last Error** opens the result in an untitled Markdown tab.
- Verified on the real demo bug: anchor is the backend TypeError, the excerpt marks `demo-app/server/index.ts:17`, and the 500 and the click are in the timeline.

Milestone 4 (correlation) done:
- `@voice-bug/shared`: `DEBUG_HEADER` (`X-Debug-Id`), `DEBUG_ID_PATTERN`, `debugPrefix(id)` / `parseDebugPrefix(line)` (format `[debug:<id>] `), `ACTION_WINDOW_MS` (1500). `ClickPayload.actionId` and `NetworkPayload.actionId` were added.
- `packages/middleware` (`@voice-bug/middleware`, no Express dependency): `voiceBug()` validates the header, echoes it in the response, and runs the rest of the chain in AsyncLocalStorage. `patchConsole()` prefixes every line of `console.*` output inside a request. Also exports `getDebugId()` and `runWithDebugId()`. Used in `demo-app/server/index.ts`, which moved the planted bug to line 19.
- SDK `capture/correlation.ts`: `newId()` gives `vb-<10 hex>`. `ActionTracker` gives each click an `actionId`; requests within 1.5s get it too. `debugIdDecorator` adds the header to same-origin requests only (no CORS preflights). Wired in `sdk/src/index.ts`.
- Extension: backend lines go through `parseDebugPrefix` → `event.debugId`. The terminal output is cleaned with `stripDebugPrefixes`. The Output channel shows `[id]` after source/type.
- Bundle: `causalChain()` builds click → request → backend lines for the newest error with a debugId. It renders as "What happened". Backend stacks are grouped by debugId, so concurrent requests can't interleave. `EventStore` breaks same-ms ties by global arrival order.

Milestone 5 (diagnosis) done, in `packages/extension/src/diagnosis/`:
- `prompt.ts`: system rules and `DIAGNOSIS_JSON_SCHEMA`, sent as Gemini `responseJsonSchema`.
- `gemini.ts`: `geminiGenerate` (`@google/genai`), which streams the answer with `generateContentStream`. It uses `thinkingConfig { thinkingLevel (setting voiceBug.geminiThinking, default low), includeThoughts: true }` so thought-summary headings can drive the progress UI; if a model rejects thinking options with a 400, it retries without them. Also `withRetry` (429/5xx, 1s/2s/4s, never after an abort), `describeModelError`. `run.ts` emits `RunStage`s (sending/thinking/answering/validating/correcting), and the extension shows them in a cancellable notification with elapsed seconds, with `AbortSignal.any(cancel, timeout voiceBug.geminiTimeoutSeconds=90)`. Default model `gemini-3.8-flash` (free tier per the pricing page, 2026-11) (setting `voiceBug.geminiModel`).
- `validate.ts`: shape check, plus E-refs that exist, `rootCause.file` among the sent excerpts (`Bundle.sources`) and the line inside its excerpt. A fix that doesn't apply via `patch.ts` is marked stale rather than re-asked.
- `patch.ts`: content-located unified-diff applier (tolerates wrong hunk line numbers, keeps CRLF).
- `run.ts`: one call, plus one correction turn if validation fails.
- `panelHtml.ts` (pure, escaped, nonce CSP) and `view.ts`: webview, line decoration, a Problems entry (cleared on edit), and a `vscode.diff` fix preview from an in-memory `voice-bug-fix:` document.
- Flow in `extension.ts` `diagnoseLastError`: freeze → bundle → "what did you expect?" input → Markdown preview of the bundle (`voice-bug-bundle:` virtual doc) → confirm (`voiceBug.confirmBeforeSending`) → key from SecretStorage (`voiceBug.setGeminiApiKey`), else `GEMINI_API_KEY` env/.env → call → panel. Tests use canned answers (`diagnosis/fixtures.ts`); no network.
- `pnpm-workspace.yaml` sets `allowBuilds: protobufjs: false` (a dependency of `@google/genai`; its postinstall isn't needed).

Milestone 6 (voice) done. **Groq/Whisper was replaced by Gemini transcription** (the user couldn't sign up for Groq; the same Gemini key is used):
- Protocol v2 (`shared`): `ClientMessage` adds `audio` (base64 16 kHz WAV, ≤ `MAX_UTTERANCE_MS` 15s) and `trigger` (keyboard). The new `ServerMessage` (hub → page) has `transcript`, `say` and `status`. `VoicePayload` covers `source:"voice"` events. The hub validates the new kinds and has `send(clientId, msg)`.
- SDK `voice/`:
  - `overlay.ts`: `VoiceOverlay` in a shadow DOM with `data-voice-bug-ignore`. It has a mic toggle, a pulsing red recording dot, Pause, a status line and `speechSynthesis` TTS (the VAD is paused while speaking). Ctrl+Shift+B is the keyboard trigger, and localStorage remembers "listening".
  - `vad.ts`: lazy-imported `MicVAD` (Silero v5, single-thread ORT).
  - `wav.ts`: `encodeWav`, `toBase64`, `clip`.
  - `sdk/src/vite.ts` serves `/__voice-bug/vad/*` (vad-web dist) and `/__voice-bug/ort/*` (onnxruntime-web dist) from node_modules, with safe file-name checks.
- Extension `voice/`: `transcribe.ts` (`geminiTranscribe`, model setting `voiceBug.transcribeModel` = `gemini-3.5-transcribe`, falling back to `geminiFallbackModel`) and `trigger.ts` (`parseTrigger` → note after the phrase; `spokenSummary`). In `extension.ts`, `handleAudio` transcribes, discards non-triggers without logging the words, says "Got it, looking into it.", then calls `diagnose({ clientId, note, via })`. A voice/keyboard trigger skips the input box and confirmation, records a `voice` event on the timeline, streams status to the page, and speaks the summary. A `diagnosing` flag blocks parallel runs.
- Not live-tested by Claude: the real microphone/VAD in a browser and the Gemini transcription call (the key is in the user's SecretStorage). Asset serving and the Vite transform of the VAD module were verified over HTTP.

Milestone 7 done, except session replay (rrweb/2b is still not done, by the user's choice):
- **Apply fix:** `DiagnosisView.applyFix` re-applies the diff (`applyPatch`) to the current document text as one `WorkspaceEdit`, saves, and re-renders the panel as applied. Panel extras (`PanelExtras`): `applied`, `refinedWith`, `screenshot`, `note`; the CSP allows `img-src data:`.
- **Demo bugs 2–4** (described in `demo-app/README.md` only):
  - a frontend crash: `selected.tags.join` on a note without tags, so React unmounts;
  - delete sends the list index (`/api/notes/0`), gets a 404, and the UI removes the row anyway;
  - a search race: `/api/search` delay is random 100–800ms, and the latest response wins.
- **Bundle:**
  - `isErrorEvent` counts network ≥ 400.
  - `searchTerms` gives request paths with ids cut off (failing ones first).
  - `BundleInput.related` adds excerpts (±12 lines) "mentions <term> at line N", deduped against stack excerpts, max 4 sources.
  - `BundleInput.screenshots` adds an "S1…" list.
  - `collect.ts`: `remapBrowserStacks` (via `sourcemap.ts`: VLQ decode + inline maps fetched from the dev server), `findReferences` (walks `searchRoots` = the open workspace folders, skipping node_modules/dist/tests), `CollectOptions.searchRoots`.
- **Refinement:** `lastDiagnosis` keeps the bundle, expected, raw answer, images and screenshot. Within `REFINE_WINDOW_MS` (30s), a non-trigger utterance from the same page goes to `diagnose(voice, text)` → `refineInner`, which calls `runDiagnosis` with `followUp` (adds model+user turns, `buildFollowUpPrompt`). There's also the command `voiceBug.refineDiagnosis`.
- **Voice approval:** the first voice send per VS Code session previews and asks when `confirmBeforeSending` is on (`voiceSendApproved`).
- **Screenshots:** SDK `capture/screenshots.ts` uses modern-screenshot `domToJpeg` (lazy import), shooting 400ms after a click and immediately on errors. It's throttled to 1.5s, uses `maskClonedNode` and `screenshotFilter`, and caps at 600 KB. Protocol message `screenshot`. The extension keeps the last 10 within 90s, and `pickScreenshots` sends the last 2 as `Turn.images` (setting `voiceBug.sendScreenshots`).
- **Ollama:** `diagnosis/ollama.ts` (`/api/chat`, `format` = JSON schema, NDJSON streaming) comes last in the `withFallback` chain (setting `voiceBug.ollamaModel` = `qwen3:8b`, `voiceBug.ollamaUrl`). `withFallback` now falls back on overload or on no HTTP response (`shouldFallBack`). A `FallbackUnavailable` error re-throws the original Gemini error.
- **Packaging:** `pnpm package:extension` runs esbuild `--production`, then `vsce package --no-dependencies` → `packages/extension/voice-bug.vsix`. `pnpm-workspace.yaml` denies the build scripts of `@vscode/vsce-sign`.
- Verified on port 5174:
  - source map: served line 113 → `App.tsx:72` (`selected.tags.join`);
  - delete bug: click → DELETE 404 chain, with related code `App.tsx:33` and `server/index.ts:27`;
  - search race: `App.tsx:41` and `server/index.ts:39`.
- Not live-tested by Claude: Apply fix in VS Code, screenshots in a real browser, a voice refinement, and Ollama.
- **Transcript in the overlay:** the "Transcript" button opens a list of the last 30 utterances and spoken replies, kept in sessionStorage `voiceBug.transcript`, rendered with textContent only. A pending entry is added when audio is sent and replaced when the `transcript` ServerMessage with the same id arrives, which now carries `role` (`TranscriptRole`: report/followup/retry/ignored). The extension sends an empty `ignored` transcript when it can't transcribe (busy, no key, failure).
- **Better fixes:**
  - `sourceWindow` sends source files of ≤ `WHOLE_FILE_LINES` (250) lines whole; larger files get ±20 lines (frames) or ±12 (related). A real fix often needs imports or state at the top of the file, and without them the model returned a comment-only "fix".
  - `isCosmeticDiff` in `validate.ts` rejects diffs that only change comments or whitespace, which triggers the correction turn.
  - The prompt forbids comment/TODO-only fixes.
- **Retry a failed request:** `callModel(req: ModelRequest)` saves `failedRequest` on any failure (validation, cancel, model error). It's kept 30 min and cleared on success. `retryLastRequest()` resends it unchanged. Triggers:
  - the "Retry" button on the error notification (`showFailure`);
  - the command `voiceBug.retryLastRequest`;
  - the overlay Retry button (`status.canRetry` → page sends `{ kind: "retry" }`);
  - the voice phrase "try again" (`isRetryPhrase` in `voice/trigger.ts`, checked before trigger parsing).

## Commands
- `pnpm install` · `pnpm typecheck` · `pnpm test` · `pnpm build`
- Demo app: `pnpm dev:demo` → http://localhost:5173 (Express + Vite middleware, one process)
- Extension: open repo in VS Code, F5 ("Run Voice Bug extension"). The Extension Development Host opens `demo-app` (VS Code refuses to open a folder that is already open in another window) and writes `demo-app/.voice-bug/session.json` (gitignored), which the Vite plugin finds by walking up from the app root.
- In the Extension Development Host: "Voice Bug: Start Dev Server" / "Stop Dev Server" (runs `voiceBug.devCommand`, default `pnpm dev:demo`), "Voice Bug: Show Output", "Voice Bug: Restart Capture Hub", "Voice Bug: Diagnose Last Error" (prints the redacted bundle, no AI).
- Windows: the F5 build task uses `pnpm.cmd` (PowerShell may block `pnpm.ps1`). Node 25+ doesn't bundle corepack: run `npm install -g corepack` first.
- Settings: `voiceBug.port` (0 = random), `voiceBug.devCommand`, `voiceBug.devCwd` (empty = nearest monorepo root at or above the workspace folder).
- Tests: browser-code tests use `// @vitest-environment happy-dom` at the top of the file.
- Requires Node 20+ (Vitest 3 / Vite 6).
- Don't document planted bugs in demo-app source comments (the model reads that code) — use `demo-app/README.md`.

## Working conventions
- Keep components decoupled via the shared `Event` type.
- Prefer small, testable pure functions for buffer/slice/redact/correlate logic.
- Don't add features outside the milestone in progress without asking.
