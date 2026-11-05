import type { BugEvent, ClickPayload } from "@voice-bug/shared";

const INTERACTIVE = "button, a, input, select, textarea, label, summary, [role], [data-testid], [onclick]";
const FORM_FIELDS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const MAX_TEXT = 60;

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&");
}

/** Short, readable CSS path (stops at the nearest id). */
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const testId = node.getAttribute("data-testid");
    if (testId) part += `[data-testid="${testId}"]`;
    else {
      const cls = [...node.classList].slice(0, 2).map(cssEscape);
      if (cls.length) part += `.${cls.join(".")}`;
    }
    parts.unshift(part);
    if (node === document.body) break;
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/** Describes the clicked element. Form field values are never read (privacy). */
export function describeClick(target: Element, x: number, y: number): ClickPayload {
  const el = target.closest(INTERACTIVE) ?? target;
  const payload: ClickPayload = {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    x: Math.round(x),
    y: Math.round(y),
    url: location.pathname + location.search,
  };
  if (el.id) payload.id = el.id;
  const role = el.getAttribute("role");
  if (role) payload.role = role;
  const name = el.getAttribute("name") ?? el.getAttribute("aria-label");
  if (name) payload.name = name;

  if (FORM_FIELDS.has(el.tagName)) {
    const type = el.getAttribute("type");
    if (type) payload.inputType = type;
    // Buttons rendered as <input type=submit> have a label, not user data.
    if (type === "submit" || type === "button") payload.text = (el as HTMLInputElement).value.slice(0, MAX_TEXT);
  } else {
    const text = (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim();
    if (text) payload.text = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  }
  return payload;
}

export function captureClicks(emit: (event: BugEvent) => void): () => void {
  const handler = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("[data-voice-bug-ignore]")) return;
    emit({ ts: Date.now(), source: "action", type: "click", payload: describeClick(e.target, e.clientX, e.clientY) });
  };
  document.addEventListener("click", handler, { capture: true });
  return () => document.removeEventListener("click", handler, { capture: true });
}
