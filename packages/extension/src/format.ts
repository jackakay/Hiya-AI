import type { ClickPayload, Event } from "@voice-bug/shared";

function time(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** One human-readable Output Channel line per event. */
export function formatEvent(event: Event): string {
  const prefix = `[${time(event.ts)}] ${event.source}/${event.type}`;
  if (event.source === "action" && event.type === "click") {
    const p = event.payload as ClickPayload;
    const text = p.text ? ` "${p.text}"` : "";
    return `${prefix} ${p.selector}${text}  @ ${p.url}`;
  }
  return `${prefix} ${JSON.stringify(event.payload)}`;
}
