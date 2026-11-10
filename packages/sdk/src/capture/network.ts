import type { BugEvent, NetworkPayload } from "@voice-bug/shared";
import { truncate } from "./serialize";

const MAX_URL = 500;

export type RequestInfo = { method: string; url: string };

/**
 * Optional per-request hook. Whatever it returns is added to the outgoing
 * request: `headers` are set on it, `debugId` is recorded on the event and
 * `actionId` on its payload. index.ts uses it for X-Debug-Id (see correlation.ts).
 */
export type DecorateRequest = (req: RequestInfo) => { headers?: Record<string, string>; debugId?: string; actionId?: string } | void;

export type NetworkOptions = {
  /** Requests for which this returns true are not recorded or decorated. */
  ignoreUrl?: (absoluteUrl: string) => boolean;
  decorateRequest?: DecorateRequest;
  /** Base for relative URLs and same-origin detection. Defaults to location.href. */
  baseUrl?: () => string;
  now?: () => number;
};

/** Path + query for same-origin URLs (what a developer reads), absolute otherwise. Truncated. */
export function displayUrl(url: string, base: string): string {
  let shown = url;
  try {
    const u = new URL(url, base);
    const b = new URL(base);
    shown = u.origin === b.origin ? `${u.pathname}${u.search}` : u.href;
  } catch {
    // keep as given
  }
  return truncate(shown, MAX_URL);
}

function absoluteUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function safeDecorate(decorate: DecorateRequest | undefined, req: RequestInfo) {
  if (!decorate) return undefined;
  try {
    return decorate(req) ?? undefined;
  } catch {
    return undefined;
  }
}

function defaultBase(): string {
  return typeof location !== "undefined" ? location.href : "http://localhost/";
}

/** Returns a fetch that records each request (never bodies) and otherwise behaves like `original`. */
export function wrapFetch(original: typeof fetch, emit: (event: BugEvent) => void, options: NetworkOptions = {}): typeof fetch {
  const base = options.baseUrl ?? defaultBase;
  const now = options.now ?? (() => Date.now());

  const wrapped = async function (input: RequestInfoish, init?: RequestInit): Promise<Response> {
    let method = "GET";
    let rawUrl = "";
    try {
      const isRequest = typeof Request !== "undefined" && input instanceof Request;
      method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
      rawUrl = isRequest ? (input as Request).url : String(input);
    } catch {
      return original(input, init);
    }
    const abs = absoluteUrl(rawUrl, base());
    if (options.ignoreUrl?.(abs)) return original(input, init);

    const extra = safeDecorate(options.decorateRequest, { method, url: abs });
    if (extra?.headers && Object.keys(extra.headers).length > 0) {
      // A Request's own headers are replaced by init.headers, so start from them.
      const fromRequest = typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined;
      const headers = new Headers(init?.headers ?? fromRequest);
      for (const [k, v] of Object.entries(extra.headers)) headers.set(k, v);
      init = { ...init, headers };
    }

    const start = now();
    const record = (fields: Pick<NetworkPayload, "status" | "error">) => {
      try {
        const payload: NetworkPayload = { api: "fetch", method, url: displayUrl(abs, base()), durationMs: Math.round(now() - start), ...fields };
        if (extra?.actionId) payload.actionId = extra.actionId;
        const event: BugEvent = { ts: start, source: "network", type: "request", payload };
        if (extra?.debugId) event.debugId = extra.debugId;
        emit(event);
      } catch {
        // ignore
      }
    };

    let response: Response;
    try {
      response = await original(input, init);
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      record({ error: name === "AbortError" ? "aborted" : truncate(String((err as Error)?.message ?? err), 300) });
      throw err;
    }
    record({ status: response.status });
    return response;
  };
  return wrapped as typeof fetch;
}

type RequestInfoish = Parameters<typeof fetch>[0];

type XhrState = { method: string; url: string };

/**
 * Patches XMLHttpRequest.prototype.open/send on the given class. One event per
 * request, emitted on `loadend`. Returns a function that undoes the patch.
 */
export function wrapXhr(Xhr: typeof XMLHttpRequest, emit: (event: BugEvent) => void, options: NetworkOptions = {}): () => void {
  const base = options.baseUrl ?? defaultBase;
  const now = options.now ?? (() => Date.now());
  const proto = Xhr.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const state = new WeakMap<XMLHttpRequest, XhrState>();

  const open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      state.set(this, { method: String(method).toUpperCase(), url: absoluteUrl(String(url), base()) });
    } catch {
      state.delete(this);
    }
    return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  };

  const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = state.get(this);
    if (!info || options.ignoreUrl?.(info.url)) return originalSend.call(this, body);

    const extra = safeDecorate(options.decorateRequest, { method: info.method, url: info.url });
    if (extra?.headers) {
      for (const [k, v] of Object.entries(extra.headers)) {
        try {
          this.setRequestHeader(k, v);
        } catch {
          // ignore
        }
      }
    }

    const start = now();
    let failure: string | undefined;
    const onFail = (e: ProgressEvent) => {
      failure = e.type === "abort" ? "aborted" : e.type === "timeout" ? "timeout" : "network error";
    };
    const onEnd = () => {
      this.removeEventListener("error", onFail);
      this.removeEventListener("abort", onFail);
      this.removeEventListener("timeout", onFail);
      this.removeEventListener("loadend", onEnd);
      try {
        const payload: NetworkPayload = { api: "xhr", method: info.method, url: displayUrl(info.url, base()), durationMs: Math.round(now() - start) };
        if (failure || this.status === 0) payload.error = failure ?? "network error";
        else payload.status = this.status;
        if (extra?.actionId) payload.actionId = extra.actionId;
        const event: BugEvent = { ts: start, source: "network", type: "request", payload };
        if (extra?.debugId) event.debugId = extra.debugId;
        emit(event);
      } catch {
        // ignore
      }
    };
    this.addEventListener("error", onFail);
    this.addEventListener("abort", onFail);
    this.addEventListener("timeout", onFail);
    this.addEventListener("loadend", onEnd);
    return originalSend.call(this, body);
  };

  proto.open = open as typeof proto.open;
  proto.send = send;
  return () => {
    if (proto.open === open) proto.open = originalOpen;
    if (proto.send === send) proto.send = originalSend;
  };
}

/** Wraps window.fetch and XMLHttpRequest. WebSockets (e.g. the hub connection) are never touched. */
export function captureNetwork(emit: (event: BugEvent) => void, options: NetworkOptions = {}): () => void {
  const undo: Array<() => void> = [];
  if (typeof window.fetch === "function") {
    const original = window.fetch;
    const wrapped = wrapFetch(original, emit, options);
    window.fetch = wrapped;
    undo.push(() => {
      if (window.fetch === wrapped) window.fetch = original;
    });
  }
  if (typeof window.XMLHttpRequest === "function") undo.push(wrapXhr(window.XMLHttpRequest, emit, options));
  return () => undo.forEach((u) => u());
}
