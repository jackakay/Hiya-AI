import type { ClientMessage } from "@voice-bug/shared";

const MAX_QUEUE = 1000;
const MAX_BACKOFF_MS = 5000;

/** WebSocket to the extension hub with an offline queue and reconnect backoff. */
export class Transport {
  private ws: WebSocket | undefined;
  private queue: string[] = [];
  private backoff = 250;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: string,
    private readonly onOpen: () => void = () => {},
  ) {
    this.connect();
  }

  send(msg: ClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return;
    }
    this.queue.push(data);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoff = 250;
      this.onOpen();
      for (const data of this.queue.splice(0)) ws.send(data);
    });
    ws.addEventListener("close", () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }
}
