import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { DEBUG_HEADER, DEBUG_ID_PATTERN, debugPrefix } from "@voice-bug/shared";

/**
 * Dev-only Express/Connect middleware: reads the X-Debug-Id header the
 * capture SDK adds and prefixes every console line written while handling
 * that request (including Express's own error stack traces) with
 * "[debug:<id>] ", so the VS Code extension can link the request to its logs.
 */

type Req = { headers: Record<string, string | string[] | undefined> };
type Res = { setHeader(name: string, value: string): unknown };
type Next = (err?: unknown) => void;

const storage = new AsyncLocalStorage<string>();
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
let patched = false;

/** The debug id of the request being handled, if any (for custom loggers). */
export function getDebugId(): string | undefined {
  return storage.getStore();
}

/** Runs `fn` with `id` as the current debug id (exposed for tests and non-Express servers). */
export function runWithDebugId<T>(id: string, fn: () => T): T {
  return storage.run(id, fn);
}

/** Prefixes every line, so a multi-line stack trace stays linked line by line. */
export function prefixLines(text: string, id: string): string {
  const prefix = debugPrefix(id);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : prefix + line))
    .join("\n");
}

/** Wraps console methods once; outside a request they behave exactly as before. */
export function patchConsole(target: Console = console): void {
  if (patched && target === console) return;
  if (target === console) patched = true;
  for (const level of LEVELS) {
    const original = target[level] as (...args: unknown[]) => void;
    if (typeof original !== "function") continue;
    target[level] = function (this: unknown, ...args: unknown[]) {
      const id = storage.getStore();
      if (!id) return original.apply(this ?? target, args);
      return original.call(this ?? target, prefixLines(format(...args), id));
    };
  }
}

export function readDebugId(req: Req): string | undefined {
  const raw = req.headers[DEBUG_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && DEBUG_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * `app.use(voiceBug())` before your routes. Requests without a valid
 * X-Debug-Id header pass through untouched.
 */
export function voiceBug(): (req: Req, res: Res, next: Next) => void {
  patchConsole();
  return (req, res, next) => {
    const id = readDebugId(req);
    if (!id) return next();
    res.setHeader(DEBUG_HEADER, id);
    storage.run(id, () => next());
  };
}
