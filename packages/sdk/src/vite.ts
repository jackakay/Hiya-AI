import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { SESSION_DIR, SESSION_FILE, type SessionInfo } from "@voice-bug/shared";

/** Walks up from `start` looking for the session file the extension writes. */
export function findSessionFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, SESSION_DIR, SESSION_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readSession(file: string): SessionInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as SessionInfo;
    return typeof info.port === "number" && typeof info.token === "string" ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dev-server only: injects the capture SDK into index.html, configured from
 * the session file. Re-read on every page load so an extension restart is
 * picked up by a refresh.
 */
export function voiceBug(): Plugin {
  let root = process.cwd();
  let warned = false;
  return {
    name: "voice-bug",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    transformIndexHtml: {
      // "pre" so Vite still resolves the bare import in the injected inline module.
      order: "pre",
      handler() {
        const file = findSessionFile(root);
        const session = file && readSession(file);
        if (!session) {
          if (!warned) {
            console.warn("[voice-bug] No .voice-bug/session.json found — is the VS Code extension running? Capture disabled.");
            warned = true;
          }
          return [];
        }
        warned = false;
        const config = JSON.stringify({ port: session.port, token: session.token });
        return [
          {
            tag: "script",
            attrs: { type: "module" },
            children: `import { init } from "@voice-bug/sdk";\ninit(${config});`,
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}
