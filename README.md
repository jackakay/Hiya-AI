# Voice Bug Reporter

Say **"that's a bug"** while testing your web app and get a diagnosis in VS Code.

Voice Bug keeps the last minute of your clicks, network requests, console
output and server logs in memory on your machine. When you report a bug, by
voice or with a shortcut, it links your click to its request and the server's
stack trace, finds the responsible code, and asks Gemini for a diagnosis. The
diagnosis opens beside your code with the root-cause line highlighted and a
fix you can apply in one click.

## Demo video

▶️ **[Watch the demo on YouTube](https://youtu.be/1NzejxjYnD8)**. The video is also in the project files.

## How it works

```
 Browser (your app)          VS Code extension (hub)             Gemini
 ┌──────────────────┐ local  ┌──────────────────────────────┐   ┌──────────┐
 │ Capture SDK      │──────▶ │ Last 90 s in memory          │──▶│ Speech + │
 │ Voice overlay    │◀────── │ Bundle, redact, validate     │◀──│ diagnosis│
 └──────────────────┘        │ Diagnosis panel + Apply fix  │   └──────────┘
 Dev server (Express) ──────▶│ (runs your dev server)       │
 + request-id middleware     └──────────────────────────────┘
```

- **`packages/sdk`**: browser capture (clicks, console, errors, fetch/XHR, masked screenshots) and the voice overlay, injected by a Vite plugin.
- **`packages/middleware`**: an Express middleware that tags each server log line with the request's `X-Debug-Id`.
- **`packages/extension`**: the VS Code extension. It runs the dev server and holds the captured data in memory. It builds and redacts the bundle, calls Gemini, checks the answer, and shows the panel.
- **`demo-app`**: a small React + Express notes app with four planted bugs (spoilers in [`demo-app/README.md`](demo-app/README.md)).

## Requirements

- **Node.js 20+** and **pnpm** (via corepack)
- **VS Code 1.90+**
- **Chrome** (or another Chromium browser) with a microphone, for voice
- A free **Gemini API key** from <https://aistudio.google.com/apikey>

## Installation

```bash
git clone https://github.com/jackakay/Hiya-AI.git
cd Hiya-AI
```

Install pnpm. Node 25+ no longer bundles corepack, so install it first:

```bash
npm install -g corepack
corepack enable
```

Install the dependencies:

```bash
pnpm install
```

> **Windows:** if PowerShell says *"running scripts is disabled on this system"*, use
> `npm.cmd`, `corepack.cmd` and `pnpm.cmd` instead, or run
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

Check that everything builds and the tests pass:

```bash
pnpm typecheck
pnpm test
```

## Running it

1. **Open the `Hiya-AI` folder in VS Code and press F5** ("Run Voice Bug extension").
   A second VS Code window opens on `demo-app` with the extension running.
2. In that window, open the Command Palette (**Ctrl+Shift+P**) and run:
   - **Voice Bug: Set Gemini API Key** and paste your key. It's stored in VS Code's encrypted secret storage.
   - **Voice Bug: Start Dev Server**, which runs `pnpm dev:demo` and captures its output.
3. Open <http://localhost:5173> in Chrome.

### Reporting a bug

1. Click **Start listening** on the Voice Bug pill (bottom right) and allow the microphone.
2. Trigger a bug, for example leave the title empty and click **Save**.
3. Say **"That's a bug, save did nothing"**, or press **Ctrl+Shift+B** in the page.
4. You hear "Got it, looking into it". A few seconds later the diagnosis panel opens in VS Code, with the root-cause line highlighted. Click **Show proposed fix** to preview it, or **Apply fix** to apply it (undo with Ctrl+Z).

Other ways to report:
- Run **Voice Bug: Diagnose Last Error** from the Command Palette.
- Say a follow-up within 30 seconds to refine a diagnosis.
- Say "try again" to resend a request that failed.

### Installing without F5 (optional)

```bash
pnpm package:extension
```

This builds `packages/extension/voice-bug.vsix`. Install it in VS Code with
**Extensions: Install from VSIX…**, open the `Hiya-AI` folder and follow the
steps above from step 2.

## Privacy

- Everything stays in memory on your machine until you report a bug.
- Form values are never read, and screenshots mask typed text.
- Secrets, emails, `.env` values and local paths are redacted before anything is sent.
- Speech detection runs in the browser; only sentences containing "that's a bug" are kept.
- Code changes are only made when you click **Apply fix**.

## More

- Full feature list, settings and design notes: [`docs/DETAILS.md`](docs/DETAILS.md)
- Project brief and milestones: [`CLAUDE.md`](CLAUDE.md)
