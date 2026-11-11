# Voice Bug Reporter

Say "that's a bug" while testing your web app; get a diagnosis in VS Code.
The project brief and design principles are in [CLAUDE.md](../CLAUDE.md).

**Status:** milestone 7 (polish), except session replay. On top of milestone 6:
- **Apply fix:** one click applies the proposed diff (undoable) and saves.
- **Follow-ups:** a sentence within 30s of a diagnosis refines it, as does **Voice Bug: Refine Diagnosis**.
- **Screenshots:** masked screenshots are taken after clicks and errors, sent with the bundle and shown in the panel.
- **Source-mapped browser stacks:** browser errors point at the real `.tsx` lines.
- **Related code:** for bugs without a stack, code is found by searching for the request URLs involved.
- **Local fallback:** an Ollama model answers when Gemini can't.
- **More demo bugs:** four planted bugs (see `demo-app/README.md`).
- **Packaging:** `pnpm package:extension` builds a `.vsix`.

Milestone 6 recap (voice): Say **"that's a bug, save did nothing"**
while testing. The overlay in your app hears it and Gemini transcribes it.
VS Code then diagnoses the last minute and speaks the result back, while the
diagnosis panel opens beside your code. **Diagnose Last Error** still works
from the Command Palette. The fix is a preview only; nothing is applied.

## Voice

A small **Voice Bug** pill sits at the bottom right of your app.

1. Click **Start listening**, and allow the microphone when the browser asks.
   The red dot means it's listening. **Pause** stops it, and **Stop** turns
   it off. The choice is remembered across reloads.
2. While testing, say **"That's a bug"** (also "this is a bug", "bug:", "I
   found a bug"), followed by what you expected or saw, for example *"That's
   a bug, save did nothing"*.
3. You hear *"Got it, looking into it"*. The pill shows each stage, and when
   the diagnosis is ready you hear a one-line summary. The panel is already
   open in VS Code.

No microphone, or you'd rather not speak? Press **Ctrl+Shift+B** in the page.

**Take your time:** say just "That's a bug" and pause. Voice Bug replies "Go
ahead" and treats your next sentence (within 10s) as the description. A
pause of up to 1.2s mid-sentence doesn't cut you off. To skip the trigger
phrase entirely, turn off `voiceBug.requireTriggerPhrase`. Then everything
you say while the overlay is listening is a bug report, and every sentence
is sent to Gemini.

**Transcript:** click **Transcript** on the pill to see everything you've
said, newest at the bottom. Each phrase is labelled with what happened to it:
*bug report*, *follow-up*, *retry*, or *ignored* (no trigger phrase). Voice
Bug's spoken replies are listed too. A phrase shows as *transcribingâ€¦* until
VS Code answers. The list lives only in this browser tab (sessionStorage),
keeps the last 30 entries, and survives the dev server's page reloads.
**Clear** empties it. VS Code itself still doesn't keep ignored phrases.

How it works and what leaves your machine:
- **Speech detection:** voice-activity detection (Silero VAD via `@ricky0123/vad-web`) runs **in the page**. Silence is never sent anywhere. Its model and the ONNX runtime are served from `node_modules` by the Vite plugin, not a CDN.
- **Transcription:** each utterance (16 kHz WAV, max 15s) goes over the local WebSocket to VS Code, which transcribes it with Gemini (`voiceBug.transcribeModel`, default `gemini-3.5-flash-lite`, same API key). The browser never holds the key.
- **Trigger phrases:** utterances without a trigger phrase are discarded. Only the overlay shows what was heard; VS Code doesn't log or keep the words.
- **What a trigger does:** the words after the phrase become the "expected" field. A voice trigger skips the "what did you expect?" box and the send confirmation, because your eyes are on the app. The bundle sent is still viewable from the panel ("view bundle sent").
- **Muting while speaking:** the mic pauses while the page speaks, so it doesn't hear itself.

Chrome's built-in Web Speech API is deliberately not used, because it streams all audio to Google.

Milestone 4 recap: The browser SDK captures clicks, console output,
uncaught errors, unhandled rejections and fetch/XHR requests. The VS Code
extension runs your dev server and captures its output. Events are kept in
in-memory ring buffers (last 90 seconds), and **Voice Bug: Diagnose Last
Error** shows the redacted bundle that will be sent to the model. Requests
are linked to their server logs by an `X-Debug-Id` header, and to the click
that started them. No AI call is made yet.

## Requirements

- Node 20+ and pnpm (`corepack enable` sets up the pinned pnpm version)
- VS Code 1.90+

## Try it

```bash
pnpm install
```

1. Open this folder in VS Code and press **F5** ("Run Voice Bug extension").
   A second VS Code window (Extension Development Host) opens on `demo-app`
   (VS Code will not open the same folder in two windows).
2. In that window, run **Voice Bug: Start Dev Server** from the Command Palette.
   This runs `pnpm dev:demo` and shows its output in a **Voice Bug: dev server** terminal.
3. Open http://localhost:5173, leave the box empty and click **Save**.
4. Run **Voice Bug: Show Output**. You should see something like:

   ```
   [18:42:01.120] action/click #save "Save"  @ /
   [18:42:01.123] network/request [vb-3172b89224] POST /api/save â†’ 500 (9ms, fetch)
   [18:42:01.127] backend/stderr [vb-3172b89224] TypeError: Cannot read properties of undefined (reading 'trim')
   [18:42:01.127] backend/stderr [vb-3172b89224]     at <anonymous> (â€¦\demo-app\server\index.ts:19:30)
   ```

5. Run **Voice Bug: Diagnose Last Error**:
   1. Type what you expected to happen (optional; Enter skips it).
   2. The bundle that will be sent opens as a Markdown preview. Click **Send to Gemini**.
   3. The first time, you're asked for a Gemini API key (see below).
   4. A few seconds later the **diagnosis panel** opens. The root-cause line
      is highlighted in the editor and listed under Problems, and **Show
      proposed fix** opens a diff preview.
6. Run **Voice Bug: Stop Dev Server** (or press Ctrl+C in that terminal, or
   close it). The whole process tree is killed, so port 5173 is freed.

## Diagnosis (Gemini)

**API key:** run **Voice Bug: Set Gemini API Key**. The key is stored in VS
Code's encrypted secret storage, never in a file. A free key from
https://aistudio.google.com/apikey is enough. As a fallback, `GEMINI_API_KEY`
is read from the environment or the repo's `.env`. **Voice Bug: Clear Gemini
API Key** removes the stored key.

**What happens on Diagnose Last Error:**
1. The buffers are frozen.
2. You're asked what you expected; this stands in for the voice note until milestone 6.
3. The redacted bundle is previewed, and with `voiceBug.confirmBeforeSending` you confirm.
4. One Gemini call is made with a JSON schema mirroring `Diagnosis`.
5. The answer is validated:
   - the JSON shape matches;
   - every `E<n>` it cites exists;
   - `rootCause.file` is one of the files whose excerpt was sent;
   - the line is inside that excerpt.

   If validation fails, the model is asked once to correct its answer. If its
   diff doesn't apply to the file on disk, the fix is shown as stale.
6. Calls are retried with backoff on 429/5xx.

The panel shows:
- confidence, summary, and expected vs actual;
- the root cause (click to open the file);
- a follow-up question when confidence is low;
- repro steps;
- evidence, where hovering a reference shows its timeline line.

The highlight and the Problems entry disappear once you edit the file.

| Setting | Default | |
|---------|---------|---|
| `voiceBug.geminiModel` | `gemini-3.8-flash` | Model id. The default is on the free tier; `gemini-3.5-flash-lite` is a faster free alternative. |
| `voiceBug.geminiFallbackModel` | `gemini-3.5-flash-lite` | Used automatically when the main model stays overloaded (503) or rate-limited (429) after 3 tries. Empty disables it. |
| `voiceBug.transcribeModel` | `gemini-3.5-flash-lite` | Speech-to-text model for the overlay. Falls back to other Flash-Lite models; models your key can't use are skipped. |
| `voiceBug.sendScreenshots` | `true` | Send masked screenshots with the bundle and show the latest in the panel. |
| `voiceBug.ollamaModel` | `qwen3:8b` | Local fallback model; empty disables it. |
| `voiceBug.ollamaUrl` | `http://127.0.0.1:11434` | Where Ollama listens. |
| `voiceBug.geminiThinking` | `low` | `minimal` / `low` / `medium` / `high`. Higher means slower; `low` is usually enough. |
| `voiceBug.geminiTimeoutSeconds` | `90` | Give up on a call after this long. |
| `voiceBug.confirmBeforeSending` | `true` | Ask before each send. The bundle preview is always shown. |

While Gemini works, the notification shows the stage and the elapsed seconds:
sending, then a heading from the model's thought summary ("Thinking: â€¦"),
then the number of answer characters received, then validation. It has a
**Cancel** button. Each stage is also logged in the Voice Bug output.

Note: the Gemini free tier may use submitted content to improve Google's
products. That's fine for the demo app; think twice for real code.

### Applying and refining

- **Apply fix:** shown when the proposed diff applies cleanly. It re-applies
  the diff to the file as it is *now* (including unsaved edits) as one
  undoable edit, saves it so the dev server reloads, and opens the file.
  Ctrl+Z undoes it. Nothing is ever changed without that click.
- **Refine:** within 30s of a voice diagnosis, just say what's wrong or
  answer its question, e.g. *"No, the save works, the list doesn't refresh"*.
  The overlay says when it's listening for a follow-up. In that window any
  sentence counts as a follow-up and is sent. **Voice Bug: Refine
  Diagnosis** does the same from the Command Palette at any time. A
  refinement reuses the frozen bundle and adds one turn with your sentence.
- **First voice send of a session:** with `voiceBug.confirmBeforeSending` on
  (default), it opens the bundle preview and asks once. Later voice reports
  in that session are sent without asking.

### What else goes into the bundle

- **Screenshots:** up to two of the most recent, taken ~0.4s after a click or
  right after an error, downscaled JPEG. Typed form values are replaced with
  `â€¢â€¢â€¢` in the copy that is rendered, and the overlay is left out. They're
  sent to Gemini as images and the latest is shown in the panel. Turn this off
  with `voiceBug.sendScreenshots`.
- **Browser stacks:** frames pointing at Vite-served modules are mapped back
  to the original file and line using the dev server's inline source maps.
- **Related code:** the code that sends or serves the requests involved,
  found by searching the open workspace folder for the request path with ids
  cut off (e.g. `/api/notes/`). Failing requests are searched first, else the
  latest ones. This gives the model the right code for bugs with no stack,
  such as a 404 the UI ignores or a race. 4xx responses now count as errors.

### Retrying a failed request

If a diagnosis fails (Gemini overloaded or rate-limited after its retries,
a timeout, Cancel, or an answer that fails validation), the request is
**saved exactly as it was sent**: the frozen bundle, what you expected and
the screenshots. You can send it again without reproducing the bug:
- the **Retry** button on the error notification in VS Code;
- **Voice Bug: Retry Last Request** in the Command Palette;
- the **Retry** button that appears on the page overlay;
- saying **"try again"** (also "retry", "send it again").

It's kept in memory for 30 minutes, or until a diagnosis succeeds. Nothing
is written to disk.

### Local fallback (Ollama)

If Gemini stays overloaded, rate-limited or unreachable after retries and the
lighter model, the diagnosis goes to a local [Ollama](https://ollama.com)
model (`voiceBug.ollamaModel`, default `qwen3:8b`; empty disables it). The
panel says when the local model answered. If Ollama isn't installed or
running, you just see Gemini's error. Screenshots aren't sent to the local
model.

```bash
ollama pull qwen3:8b
```

### Packaging

```bash
pnpm package:extension
```

This builds `packages/extension/voice-bug.vsix` (minified, ~200 KB). Install it
in any VS Code window with **Extensions: Install from VSIXâ€¦**. Your app still
needs the SDK's Vite plugin, and the middleware for server correlation.

## Linking requests to server logs

The SDK adds `X-Debug-Id: vb-<random>` to every **same-origin** request. It
doesn't add it to cross-origin requests, where a custom header would trigger
a CORS preflight. Add the middleware to your Express (or Connect) server,
before your routes and in development only:

```ts
import { voiceBug } from "@voice-bug/middleware";
app.use(voiceBug());
```

While a request with that header is handled, every `console.*` line
(including Express's own error stack traces) is written as
`[debug:vb-â€¦] <line>`. The extension strips the prefix again: your terminal
looks the same as before, and the backend event gets `debugId`. Requests
started within 1.5s of a click also carry that click's `actionId`. So the
bundle can show the exact chain: click â†’ `POST /api/save â†’ 500` â†’ the
server's stack trace. For custom loggers, `getDebugId()` returns the current
request's id.

## The bundle

**Diagnose Last Error** freezes the buffers and builds, from the last 60 seconds:

- **Last error:** the newest error event. That is an uncaught error, unhandled
  rejection, `console.error`, a request that got a 5xx or no response, or a
  backend line like `TypeError: â€¦`. All errors in the window are listed too.
- **What happened:** for the newest error that carries an `X-Debug-Id`, the
  click that started the request, the request itself, and everything the
  server logged while handling it.
- **Timeline:** every event with a reference (`E1`, `E2`, â€¦) and its time
  relative to the last error. Stack frames from `node_modules` and the Node
  runtime are collapsed to one line.
- **Stack and source:** the user-code frames of the newest error that has a
  stack, plus Â±20 lines around each frame (up to 3 files). Only files inside
  the workspace are read.
- **Uncommitted changes:** `git diff HEAD`, without lockfiles, Markdown and
  build output, truncated to 6,000 characters.

Before display, the whole text is redacted:
- values from `.env` files and the hub token;
- API keys (Google, OpenAI, Groq, GitHub, AWS, Slack), JWTs and `Bearer` tokens;
- secret-looking query parameters and quoted `password`/`token`/`apiKey` values;
- emails and credentials in URLs.

Absolute paths are shortened to `<root>` and `~`. What you see in the tab is
exactly what milestone 5 will send.

## What is captured

| Source    | Types | Notes |
|-----------|-------|-------|
| `action`  | `click` | Selector and visible label. Form field values are never read. |
| `console` | `log` `info` `warn` `error` `debug` | Arguments serialised safely: depth, length and item limits, cycles handled. Messages starting with `[voice-bug]` are the SDK's own and are skipped. |
| `console` | `uncaught-error` `unhandled-rejection` `resource-error` | Message, stack, source location. |
| `network` | `request` | fetch and XHR: method, URL, status, duration, or failure reason. Request and response bodies are never read. The hub's WebSocket is not touched. |
| `backend` | `stdout` `stderr` `start` `exit` | One event per line of dev-server output, with ANSI colour codes stripped. |

Everything stays in memory on your machine: each source has a ring buffer
holding the last 90 seconds (capped at 500 events, or 2,000 for backend
lines). Nothing is written to disk or sent anywhere.

## Settings

| Setting | Default | |
|---------|---------|---|
| `voiceBug.port` | `0` | Port of the capture hub, always on `127.0.0.1`. `0` picks a free port. Set a fixed port to forward it (see below). If the port is busy, the hub doesn't start and the Voice Bug output says so. Changing the setting restarts the hub. |
| `voiceBug.devCommand` | `pnpm dev:demo` | Command run by **Start Dev Server**, through the system shell. |
| `voiceBug.devCwd` | *(workspace root)* | Working directory for it. Empty means the monorepo root at or above the open folder (nearest `pnpm-workspace.yaml`), so opening `demo-app` alone still works. Relative paths are resolved against the workspace folder. |

### Using a GitHub Codespace from desktop VS Code

The extension, the hub and the dev server all run in the Codespace. Your
local browser has to reach two ports there: the app's port (5173) and the hub's port.

1. Set a fixed hub port in the Codespace's workspace settings, for example `"voiceBug.port": 4777`.
2. Forward that port and 5173 (in the **Ports** view; 5173 is usually forwarded automatically).
3. Open http://localhost:5173 locally. The SDK connects to `ws://127.0.0.1:4777`,
   and VS Code forwards that to the Codespace.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests use Vitest. Browser code runs under happy-dom (`// @vitest-environment happy-dom` per file).

See [demo-app/README.md](../demo-app/README.md) for the planted bugs.
