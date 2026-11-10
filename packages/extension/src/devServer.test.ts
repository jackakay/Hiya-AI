import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findWorkspaceRoot, startDevServer, taskkillArgs, type OutputStream } from "./devServer";

const dir = mkdtempSync(path.join(tmpdir(), "voice-bug-dev-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake dev server that logs to both streams, then starts a grandchild and stays alive. */
const script = path.join(dir, "server.cjs");
writeFileSync(
  script,
  `
const { spawn } = require("node:child_process");
process.stdout.write("\\u001b[32mready\\u001b[39m on port 1234\\n");
process.stderr.write("TypeError: boom\\n    at handler (server.ts:1:1)\\n");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write("grandchild " + child.pid + "\\n");
setInterval(() => {}, 1000);
`,
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("findWorkspaceRoot", () => {
  it("walks up from a package folder to the monorepo root", () => {
    const root = path.join(dir, "mono");
    const pkg = path.join(root, "demo-app", "src");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    expect(findWorkspaceRoot(pkg)).toBe(root);
    expect(findWorkspaceRoot(root)).toBe(root);
  });

  it("falls back to the folder itself outside a monorepo", () => {
    const plain = path.join(dir, "plain");
    mkdirSync(plain, { recursive: true });
    expect(findWorkspaceRoot(plain)).toBe(plain);
  });
});

describe("taskkillArgs", () => {
  it("kills the whole tree, forcefully", () => {
    expect(taskkillArgs(42)).toEqual(["/pid", "42", "/T", "/F"]);
  });
});

describe("startDevServer", () => {
  it("emits clean lines per stream and stop() kills the process tree", async () => {
    const lines: Array<[OutputStream, string]> = [];
    let raw = "";
    let exited = false;
    let grandchild = 0;
    let gotAll!: () => void;
    const allLines = new Promise<void>((r) => (gotAll = r));

    const server = startDevServer({
      command: `"${process.execPath}" "${script}"`,
      cwd: dir,
      onOutput: (_s, text) => (raw += text),
      onLine: (stream, line) => {
        lines.push([stream, line]);
        const m = /^grandchild (\d+)$/.exec(line);
        if (m) grandchild = Number(m[1]);
        if (lines.length >= 4 && grandchild) gotAll();
      },
      onExit: () => (exited = true),
    });

    await allLines;
    expect(lines).toContainEqual(["stdout", "ready on port 1234"]);
    expect(lines).toContainEqual(["stderr", "TypeError: boom"]);
    expect(lines).toContainEqual(["stderr", "    at handler (server.ts:1:1)"]);
    expect(raw).toContain("\u001b[32m"); // colours kept for the terminal
    expect(isAlive(grandchild)).toBe(true);

    await server.stop();
    expect(exited).toBe(true);
    expect(server.running()).toBe(false);
    // The grandchild (think: the node process holding port 5173) must be gone too.
    for (let i = 0; i < 50 && isAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(grandchild)).toBe(false);
  }, 20000);

  it("reports a bad working directory", async () => {
    let error: Error | undefined;
    const server = startDevServer({
      command: "node -v",
      cwd: path.join(dir, "does-not-exist"),
      onError: (e) => (error = e),
    });
    for (let i = 0; i < 50 && !error; i++) await new Promise((r) => setTimeout(r, 20));
    expect(error).toBeDefined();
    await server.stop();
  });
});
