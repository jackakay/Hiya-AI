/** V8 stack-trace parsing (Node and Chromium share the format). */

export type StackFrame = {
  fn?: string;
  /** File path or URL as printed (query string removed). */
  file: string;
  line: number;
  column?: number;
};

const FRAME = /^\s*at (?:(?<fn>.*?) \()?(?<loc>[^()]+?):(?<line>\d+)(?::(?<col>\d+))?\)?\s*$/;

export function isStackLine(line: string): boolean {
  return /^\s+at /.test(line);
}

export function parseStackLine(line: string): StackFrame | undefined {
  const m = FRAME.exec(line);
  if (!m?.groups) return undefined;
  let file = m.groups.loc!.trim();
  // file:///E:/x → E:/x, file:///home/x → /home/x
  if (file.startsWith("file:///")) {
    const rest = file.slice("file:///".length);
    file = /^[A-Za-z]:/.test(rest) ? rest : `/${rest}`;
  }
  // Vite adds ?t=… / ?v=… cache busters.
  file = file.replace(/\?[^/\\]*$/, "");
  const frame: StackFrame = { file, line: Number(m.groups.line) };
  const fn = m.groups.fn?.trim();
  if (fn) frame.fn = fn;
  if (m.groups.col) frame.column = Number(m.groups.col);
  return frame;
}

export function parseStack(stack: string): StackFrame[] {
  return stack
    .split(/\r?\n/)
    .filter(isStackLine)
    .map(parseStackLine)
    .filter((f): f is StackFrame => f !== undefined);
}

/** Frames from dependencies or the runtime, which say little about the bug. */
export function isInternalFrame(frame: StackFrame | string): boolean {
  const file = typeof frame === "string" ? frame : frame.file;
  return (
    /[\\/]node_modules[\\/]/.test(file) ||
    /^node:/.test(file) ||
    /^internal[\\/]/.test(file) ||
    /\/@vite\/|\/@fs\/.*node_modules|\/\.vite\/deps\//.test(file) ||
    file === "native" ||
    file === "<anonymous>"
  );
}
