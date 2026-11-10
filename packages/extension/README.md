# Voice Bug Reporter

Say **"that's a bug"** while testing your web app. Voice Bug has been
watching the last minute: your clicks, network requests, console output and
dev-server logs. It links them together, finds the responsible code and opens
a diagnosis with a proposed fix beside your editor.

- Runs your dev server (**Voice Bug: Start Dev Server**) and captures its output.
- A browser SDK and Vite plugin (`@voice-bug/sdk`) capture the page, and an
  Express middleware (`@voice-bug/middleware`) links requests to server logs.
- **Voice Bug: Diagnose Last Error**, the page overlay, or Ctrl+Shift+B in the
  page sends a redacted bundle to Gemini. Ollama is the local fallback.
- Fixes are only applied when you click **Apply fix**.

Everything is kept in memory on your machine until you report a bug. See the
repository README for setup, settings and privacy details.
