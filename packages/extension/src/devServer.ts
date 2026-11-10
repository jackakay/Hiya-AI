import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { LineSplitter, stripAnsi } from "./lines";

/**
 * Runs the user's dev server as a child process so the extension owns its
 * stdout/stderr. Kept free of `vscode` imports so it can be unit-tested.
 */

export type OutputStream = "stdout" | "stderr";

export type DevServerOptions = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Raw text as written by the process (ANSI intact), for a terminal. */
  onOutput?: (stream: OutputStream, text: string) => void;
  /** One call per complete line, ANSI codes stripped. */
  onLine?: (stream: OutputStream, line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** The process could not be started (bad cwd, no shell, ...). onExit still follows if it ran. */
  onError?: (err: Error) => void;
};

export type DevServer = {
  readonly pid: number | undefined;
  running(): boolean;
  /** Kills the whole process tree and resolves once the process has exited. */
  stop(): Promise<void>;
};

/** Files that mark the root of a monorepo, where workspace-level scripts like `dev:demo` live. */
const WORKSPACE_ROOT_MARKERS = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"];

/**
 * Default dev-server directory: the nearest monorepo root at or above `start`
 * (so opening a package subfolder still runs root scripts), else `start` itself.
 */
export function findWorkspaceRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (WORKSPACE_ROOT_MARKERS.some((m) => existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

const STOP_TIMEOUT_MS = 5000;
const isWindows = process.platform === "win32";

/** Arguments for `taskkill` that end the process and all its children (frees their ports). */
export function taskkillArgs(pid: number): string[] {
  return ["/pid", String(pid), "/T", "/F"];
}

function killTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    // child.kill() would only end cmd.exe and leave node (and port 5173) behind.
    execFile("taskkill", taskkillArgs(pid), { windowsHide: true }, () => {});
    return;
  }
  try {
    // Negative pid = the process group created by `detached: true`.
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

export function startDevServer(options: DevServerOptions): DevServer {
  const child = spawn(options.command, {
    cwd: options.cwd,
    shell: true,
    // Own process group on POSIX so the whole tree can be signalled.
    detached: !isWindows,
    windowsHide: true,
    // stdin must not be a pipe: `tsx watch` silently never starts the app when it is.
    stdio: ["ignore", "pipe", "pipe"],
    // Keep colours for the terminal view (they are stripped for events), unless
    // the user opted out: NO_COLOR + FORCE_COLOR makes Node print a warning.
    env: { ...(process.env.NO_COLOR ? {} : { FORCE_COLOR: "1" }), ...process.env, ...options.env },
  });

  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      if (child.pid === undefined) {
        exited = true;
        resolve();
      }
    });
  });

  const pipe = (stream: OutputStream, readable: NodeJS.ReadableStream | null) => {
    if (!readable) return;
    const splitter = new LineSplitter();
    const emitLines = (lines: string[]) => {
      for (const line of lines) options.onLine?.(stream, stripAnsi(line));
    };
    readable.setEncoding("utf8");
    readable.on("data", (text: string) => {
      options.onOutput?.(stream, text);
      emitLines(splitter.push(text));
    });
    readable.on("end", () => emitLines(splitter.flush()));
  };
  pipe("stdout", child.stdout);
  pipe("stderr", child.stderr);

  child.on("error", (err) => options.onError?.(err));
  child.on("exit", (code, signal) => options.onExit?.(code, signal));

  return {
    pid: child.pid,
    running: () => !exited,
    async stop() {
      if (exited) return;
      const waitForExit = () =>
        Promise.race([exitPromise, new Promise<void>((r) => setTimeout(r, STOP_TIMEOUT_MS).unref())]);
      killTree(child, isWindows);
      await waitForExit();
      if (!exited) {
        killTree(child, true);
        await waitForExit();
      }
    },
  };
}
