import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage } from "@voice-bug/shared";

/**
 * The capture hub: a WebSocket server bound to 127.0.0.1 that accepts
 * connections only from localhost pages presenting the session token.
 * Kept free of `vscode` imports so it can be unit-tested.
 */

export type ClientInfo = { id: number; origin: string };

export type HubOptions = {
  /** 0 (default) picks a free port. */
  port?: number;
  /** Defaults to a fresh random token. */
  token?: string;
  onMessage: (msg: ClientMessage, client: ClientInfo) => void;
  onConnect?: (client: ClientInfo) => void;
  onDisconnect?: (client: ClientInfo) => void;
  onWarning?: (message: string) => void;
};

export type Hub = {
  port: number;
  token: string;
  clientCount(): number;
  close(): Promise<void>;
};

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function createToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Only pages served from this machine may connect (privacy principle). */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function tokensMatch(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validates the shape of an incoming message; returns null if malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;

  if (msg.kind === "hello") {
    return typeof msg.protocol === "number" && typeof msg.url === "string" && typeof msg.userAgent === "string"
      ? (msg as ClientMessage)
      : null;
  }
  if (msg.kind === "event") {
    const ev = msg.event as Record<string, unknown> | undefined;
    const sources = ["action", "network", "console", "backend", "voice"];
    if (
      ev &&
      typeof ev === "object" &&
      typeof ev.ts === "number" &&
      typeof ev.type === "string" &&
      typeof ev.source === "string" &&
      sources.includes(ev.source) &&
      (ev.debugId === undefined || typeof ev.debugId === "string")
    ) {
      return msg as ClientMessage;
    }
  }
  return null;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function startHub(options: HubOptions): Promise<Hub> {
  const token = options.token ?? createToken();
  const warn = options.onWarning ?? (() => {});
  const server = http.createServer((_req, res) => {
    res.writeHead(426).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  let nextId = 1;

  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!isLocalOrigin(origin)) {
      warn(`Rejected connection from non-local origin: ${origin ?? "(none)"}`);
      return reject(socket, 403, "Forbidden");
    }
    if (!tokensMatch(token, url.searchParams.get("token"))) {
      warn(`Rejected connection with bad token from ${origin}`);
      return reject(socket, 401, "Unauthorized");
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const client: ClientInfo = { id: nextId++, origin: origin! };
      options.onConnect?.(client);
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = parseClientMessage(data.toString());
        if (msg) options.onMessage(msg, client);
        else warn(`Dropped malformed message from client ${client.id}`);
      });
      ws.on("close", () => options.onDisconnect?.(client));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        token,
        clientCount: () => wss.clients.size,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}
