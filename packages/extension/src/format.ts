import type {
  BackendExitPayload,
  BackendLinePayload,
  BackendStartPayload,
  ClickPayload,
  ConsolePayload,
  ErrorPayload,
  Event,
  NetworkPayload,
} from "@voice-bug/shared";

function time(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Indents continuation lines so multi-line messages stay readable under their prefix. */
function indent(text: string): string {
  return text.replace(/\r?\n/g, "\n    ");
}

/** The part of a formatted event after "source/type", or undefined for unknown events. */
export function describe(event: Event): string | undefined {
  const { source, type } = event;
  if (source === "action" && type === "click") {
    const p = event.payload as ClickPayload;
    const text = p.text ? ` "${p.text}"` : "";
    return `${p.selector}${text}  @ ${p.url}`;
  }
  if (source === "network" && type === "request") {
    const p = event.payload as NetworkPayload;
    const result = p.status !== undefined ? `→ ${p.status}` : `✕ ${p.error ?? "failed"}`;
    return `${p.method} ${p.url} ${result} (${p.durationMs}ms, ${p.api})`;
  }
  if (source === "console") {
    if (type === "uncaught-error" || type === "unhandled-rejection" || type === "resource-error") {
      const p = event.payload as ErrorPayload;
      const where = p.source ? `  @ ${p.source}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : ""}` : "";
      // The stack's first line repeats the message.
      const stack = p.stack?.split("\n").slice(1).join("\n");
      return indent(`${p.message}${where}${stack ? `\n${stack}` : ""}`);
    }
    return indent((event.payload as ConsolePayload).message);
  }
  if (source === "voice") {
    const p = event.payload as { text?: string; note?: string; via?: string };
    return p.via === "keyboard" ? "bug reported with the keyboard shortcut (no words)" : `“${p.text ?? ""}”`;
  }
  if (source === "backend") {
    if (type === "stdout" || type === "stderr") return (event.payload as BackendLinePayload).line;
    if (type === "start") {
      const p = event.payload as BackendStartPayload;
      return `$ ${p.command}  (cwd ${p.cwd}${p.pid ? `, pid ${p.pid}` : ""})`;
    }
    if (type === "exit") {
      const p = event.payload as BackendExitPayload;
      return `process exited (${p.signal ? `signal ${p.signal}` : `code ${p.code}`})`;
    }
  }
  return undefined;
}

/** One human-readable Output Channel entry per event. */
export function formatEvent(event: Event): string {
  const id = event.debugId ? ` [${event.debugId}]` : "";
  const prefix = `[${time(event.ts)}] ${event.source}/${event.type}${id}`;
  let body: string | undefined;
  try {
    body = describe(event);
  } catch {
    body = undefined;
  }
  return `${prefix} ${body ?? JSON.stringify(event.payload)}`;
}
