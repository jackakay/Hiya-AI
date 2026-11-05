import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION, SESSION_DIR, SESSION_FILE, type SessionInfo } from "@voice-bug/shared";
import { startHub, type Hub } from "./hub";
import { formatEvent } from "./format";

let hub: Hub | undefined;
let sessionFilePath: string | undefined;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Voice Bug");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "voiceBug.showOutput";
  context.subscriptions.push(
    output,
    status,
    vscode.commands.registerCommand("voiceBug.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("voiceBug.restartHub", async () => {
      await stop();
      await start();
    }),
  );
  await start();
}

export async function deactivate(): Promise<void> {
  await stop();
}

async function start(): Promise<void> {
  try {
    hub = await startHub({
      onConnect: (c) => {
        output.appendLine(`Client ${c.id} connected (${c.origin})`);
        updateStatus();
      },
      onDisconnect: (c) => {
        output.appendLine(`Client ${c.id} disconnected`);
        updateStatus();
      },
      onWarning: (m) => output.appendLine(`WARN ${m}`),
      onMessage: (msg, c) => {
        if (msg.kind === "hello") {
          const mismatch = msg.protocol !== PROTOCOL_VERSION ? ` (protocol ${msg.protocol}, expected ${PROTOCOL_VERSION})` : "";
          output.appendLine(`Client ${c.id} hello from ${msg.url}${mismatch}`);
        } else {
          output.appendLine(formatEvent(msg.event));
        }
      },
    });
  } catch (err) {
    output.appendLine(`Failed to start capture hub: ${String(err)}`);
    void vscode.window.showErrorMessage("Voice Bug: failed to start capture hub. See the Voice Bug output.");
    return;
  }

  output.appendLine(`Capture hub listening on ws://127.0.0.1:${hub.port}`);
  await writeSessionFile(hub);
  updateStatus();
}

async function stop(): Promise<void> {
  if (sessionFilePath) {
    await fs.rm(sessionFilePath, { force: true }).catch(() => {});
    sessionFilePath = undefined;
  }
  await hub?.close();
  hub = undefined;
  updateStatus();
}

/** Lets the dev-server plugin discover the port + token. */
async function writeSessionFile(h: Hub): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    output.appendLine("No workspace folder open — the SDK must be initialised with the port/token manually.");
    output.appendLine(`  port=${h.port}`);
    return;
  }
  const dir = path.join(folder.uri.fsPath, SESSION_DIR);
  await fs.mkdir(dir, { recursive: true });
  sessionFilePath = path.join(dir, SESSION_FILE);
  const info: SessionInfo = { port: h.port, token: h.token, pid: process.pid };
  await fs.writeFile(sessionFilePath, JSON.stringify(info, null, 2), { mode: 0o600 });
  output.appendLine(`Session file written to ${sessionFilePath}`);
}

function updateStatus(): void {
  if (!status) return;
  if (!hub) {
    status.text = "$(circle-slash) Voice Bug: off";
    status.tooltip = "Capture hub is not running";
  } else {
    const n = hub.clientCount();
    status.text = n > 0 ? `$(record) Voice Bug: capturing (${n})` : "$(circle-outline) Voice Bug: waiting";
    status.tooltip = n > 0 ? `${n} page(s) connected — capture stays in memory locally` : "No app connected yet";
  }
  status.show();
}
