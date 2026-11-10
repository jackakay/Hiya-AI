import type { ClientMessage } from "@voice-bug/shared";

/**
 * Small JPEG screenshots of the page shortly after clicks and errors, so the
 * diagnosis can see what the user saw. Form field values are masked in the
 * clone (privacy) and the Voice Bug overlay is left out. Throttled and
 * best-effort: a failed capture is simply skipped.
 */

export type ScreenshotOptions = {
  /** Renders `node` to a JPEG data URL (modern-screenshot's domToJpeg, injected for testability). */
  render?: (node: Element, opts: RenderOptions) => Promise<string>;
  /** Minimum time between screenshots. */
  minIntervalMs?: number;
  /** Wait after a click so the screenshot shows its result. */
  clickDelayMs?: number;
  now?: () => number;
};

export type RenderOptions = {
  scale: number;
  quality: number;
  height: number;
  filter: (node: Node) => boolean;
  onCloneEachNode: (node: Node) => void;
};

const MAX_WIDTH = 800;
const MAX_HEIGHT_CSS_PX = 1600;
const MAX_BYTES = 600 * 1024;
const MASK = "•••";

/** Leaves the overlay and anything marked ignore out of the screenshot. */
export function screenshotFilter(node: Node): boolean {
  return !(node instanceof Element && (node.tagName === "VOICE-BUG-OVERLAY" || node.hasAttribute("data-voice-bug-ignore")));
}

/** Replaces what the user typed with dots in the cloned DOM (the real page is untouched). */
export function maskClonedNode(node: Node): void {
  if (!(node instanceof Element)) return;
  if (node instanceof HTMLInputElement) {
    const type = (node.getAttribute("type") ?? "text").toLowerCase();
    if (["submit", "button", "reset", "checkbox", "radio", "range", "color"].includes(type)) return;
    const masked = node.value ? MASK : "";
    node.value = masked;
    node.setAttribute("value", masked);
  } else if (node instanceof HTMLTextAreaElement) {
    const masked = node.value ? MASK : "";
    node.value = masked;
    node.textContent = masked;
  } else if (node.getAttribute("contenteditable") === "true" && node.textContent) {
    node.textContent = MASK;
  }
}

export function captureScreenshots(send: (msg: ClientMessage) => void, options: ScreenshotOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? 1500;
  const clickDelay = options.clickDelayMs ?? 400;
  let last = -Infinity;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const render =
    options.render ??
    (async (node: Element, opts: RenderOptions) => {
      const { domToJpeg } = await import("modern-screenshot");
      return domToJpeg(node, opts);
    });

  const shoot = async (reason: "click" | "error") => {
    if (busy || now() - last < minInterval || document.visibilityState === "hidden") return;
    busy = true;
    last = now();
    const ts = now();
    try {
      const width = document.documentElement.clientWidth || window.innerWidth;
      const height = Math.min(document.documentElement.scrollHeight || window.innerHeight, MAX_HEIGHT_CSS_PX);
      const dataUrl = await render(document.body, {
        scale: Math.min(1, MAX_WIDTH / Math.max(width, 1)),
        quality: 0.6,
        height,
        filter: screenshotFilter,
        onCloneEachNode: maskClonedNode,
      });
      const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (data && data.length <= MAX_BYTES) send({ kind: "screenshot", ts, reason, mimeType: "image/jpeg", data });
    } catch {
      // best effort
    } finally {
      busy = false;
    }
  };

  const onClick = (e: MouseEvent) => {
    if (e.target instanceof Element && e.target.closest("[data-voice-bug-ignore]")) return;
    clearTimeout(timer);
    timer = setTimeout(() => void shoot("click"), clickDelay);
  };
  // Errors may blank the page (React unmounts), so shoot right away.
  const onError = () => void shoot("error");
  document.addEventListener("click", onClick, true);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onError);
  };
}
