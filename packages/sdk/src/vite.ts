import { createReadStream, existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
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

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

/** Directories the voice overlay loads its VAD worklet, Silero model and ONNX runtime WASM from. */
export function voiceAssetDirs(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const vadDir = path.join(path.dirname(require.resolve("@ricky0123/vad-web/package.json")), "dist");
  const ortDir = path.dirname(createRequire(path.join(vadDir, "index.js")).resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"));
  return { "/__voice-bug/vad/": vadDir, "/__voice-bug/ort/": ortDir };
}

/** Maps a request path to a file in one of `dirs`, refusing anything but a plain file name. */
export function resolveVoiceAsset(url: string, dirs: Record<string, string>): string | undefined {
  const pathname = url.split("?")[0] ?? "";
  for (const [prefix, dir] of Object.entries(dirs)) {
    if (!pathname.startsWith(prefix)) continue;
    const name = pathname.slice(prefix.length);
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".") || !CONTENT_TYPES[path.extname(name)]) return undefined;
    return path.join(dir, name);
  }
  return undefined;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** Serves the voice assets from node_modules, so nothing is loaded from a CDN. */
export function voiceAssetMiddleware(): Middleware {
  let dirs: Record<string, string> | undefined;
  return (req, res, next) => {
    if (!req.url?.startsWith("/__voice-bug/")) return next();
    try {
      dirs ??= voiceAssetDirs();
    } catch {
      res.statusCode = 404;
      return res.end("Voice assets not installed (@ricky0123/vad-web)");
    }
    const file = resolveVoiceAsset(req.url, dirs);
    if (!file || !existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("Content-Type", CONTENT_TYPES[path.extname(file)]!);
    res.setHeader("Cache-Control", "max-age=3600");
    createReadStream(file).pipe(res);
  };
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
    configureServer(server) {
      server.middlewares.use(voiceAssetMiddleware());
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
