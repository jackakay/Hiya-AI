/** Pure helpers for turning raw dev-server output into clean log lines. */

// CSI (colours, cursor moves), OSC (titles, hyperlinks; BEL or ST terminated),
// other two-byte ESC sequences, and the 8-bit CSI introducer.
const ANSI_PATTERN =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/**
 * Removes the middleware's "[debug:<id>] " prefixes from raw terminal output,
 * so the developer's own logs look exactly as they would without Voice Bug.
 * (Events keep the id; see parseDebugPrefix in @voice-bug/shared.)
 */
export function stripDebugPrefixes(text: string): string {
  return text.replace(/^\[debug:[A-Za-z0-9_-]{1,64}\] ?/gm, "");
}

/** Lines longer than this are emitted in pieces so one runaway write can't grow the buffer forever. */
export const MAX_LINE_LENGTH = 8192;

/**
 * Splits a stream of text chunks into lines. Handles \n, \r\n and a bare \r
 * (progress output), including a \r\n split across two chunks.
 */
export class LineSplitter {
  private rest = "";
  /** The previous chunk ended in \r, so a leading \n belongs to it. */
  private afterCr = false;

  constructor(private readonly maxLength = MAX_LINE_LENGTH) {}

  /** Feeds a chunk; returns the lines it completed (without terminators). */
  push(chunk: string): string[] {
    if (this.afterCr && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.afterCr = chunk.endsWith("\r");

    const parts = (this.rest + chunk).split(/\r\n|\n|\r/);
    this.rest = parts.pop() ?? "";
    while (this.rest.length > this.maxLength) {
      parts.push(this.rest.slice(0, this.maxLength));
      this.rest = this.rest.slice(this.maxLength);
    }
    return parts;
  }

  /** Returns whatever is left without a terminator (call when the stream ends). */
  flush(): string[] {
    const rest = this.rest;
    this.rest = "";
    this.afterCr = false;
    return rest ? [rest] : [];
  }
}
