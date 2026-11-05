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
Milestone 1 (pipeline) done: hub in `packages/extension/src/hub.ts` (127.0.0.1, token + localhost-origin check), SDK click capture, Vite plugin that injects the SDK using `.voice-bug/session.json`, demo app with planted bug 1. `packages/middleware` not created yet (milestone 4). Next: milestone 2.

## Commands
- `pnpm install` · `pnpm typecheck` · `pnpm test` · `pnpm build`
- Demo app: `pnpm dev:demo` → http://localhost:5173 (Express + Vite middleware, one process)
- Extension: open repo in VS Code, F5 ("Run Voice Bug extension"); it writes `.voice-bug/session.json` (gitignored) which the demo app's Vite plugin reads on each page load.
- Don't document planted bugs in demo-app source comments (the model reads that code) — use `demo-app/README.md`.

## Working conventions
- Keep components decoupled via the shared `Event` type.
- Prefer small, testable pure functions for buffer/slice/redact/correlate logic.
- Don't add features outside the milestone in progress without asking.
