import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ErrorPayload, Event } from "@voice-bug/shared";
import { buildBundle, searchTerms, type Bundle } from "./bundle";
import type { EventStore } from "./buffer";
import { parseEnvValues } from "./redact";
import { remapStack } from "./sourcemap";

/**
 * The I/O half of "Diagnose Last Error": freezes the store, source-maps
 * browser stacks, searches the code for the requests involved, reads source
 * files, `git diff` and .env values, then hands everything to the pure buildBundle.
 * Kept free of `vscode` imports.
 */

export const BUNDLE_WINDOW_MS = 60_000;
const MAX_FILE_BYTES = 512 * 1024;
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];
const DIFF_EXCLUDES = ["**/pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock", "**/*.md", "**/*.map", "**/dist/**"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".git", ".voice-bug", ".vite", "coverage", ".next"]);
const MAX_SEARCHED_FILES = 2000;

export type CollectOptions = {
  store: EventStore;
  /** Repo root first, then any other folders source files may come from. */
  roots: string[];
  pages?: string[];
  /** Extra exact strings to hide, e.g. the hub session token. */
  secrets?: string[];
  /**
   * Folders to search for code mentioning the request paths: the app being
   * debugged (the open workspace folders), not the whole monorepo, which may
   * contain unrelated packages. Defaults to the repo root.
   */
  searchRoots?: string[];
  /** Screenshot metadata to mention in the text (the images go to the model separately). */
  screenshots?: Array<{ ts: number; reason: string }>;
  /** Fetches a module from the dev server (for source maps). Defaults to fetch with a 2s timeout. */
  fetchText?: (url: string) => Promise<string | undefined>;
  now?: number;
};

function readSmallFile(p: string): string | undefined {
  try {
    if (statSync(p).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

export function gitDiff(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      // Lockfiles and docs would eat the diff budget without saying anything about a bug.
      ["diff", "--no-color", "--no-ext-diff", "-U3", "HEAD", "--", ".", ...DIFF_EXCLUDES.map((p) => `:(exclude,glob)${p}`)],
      { cwd, timeout: 3000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

async function defaultFetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/** Browser stacks point into Vite-transformed code; map them back to the real files and lines. */
async function remapBrowserStacks(events: Event[], fetchText: (url: string) => Promise<string | undefined>): Promise<Event[]> {
  return Promise.all(
    events.map(async (e) => {
      const p = e.payload as Partial<ErrorPayload> & { message?: string };
      if (e.source !== "console") return e;
      if (p.stack?.includes("http")) return { ...e, payload: { ...p, stack: await remapStack(p.stack, fetchText) } };
      // console.error(err) puts the stack in the message.
      if (e.type === "error" && p.message?.includes("    at http")) return { ...e, payload: { ...p, message: await remapStack(p.message, fetchText) } };
      return e;
    }),
  );
}

/** Code files under `root`, skipping dependencies and build output. */
function* codeFiles(root: string): Generator<string> {
  const stack = [root];
  let count = 0;
  while (stack.length && count < MAX_SEARCHED_FILES) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(path.join(dir, e.name));
      } else if (e.isFile() && CODE_EXTENSIONS.has(path.extname(e.name)) && !/\.(test|spec)\.[jt]sx?$/.test(e.name)) {
        count++;
        yield path.join(dir, e.name);
      }
    }
  }
}

/** First line in each file that mentions a term; at most two files per term. */
export function findReferences(root: string, terms: string[]): Array<{ absPath: string; line: number; term: string }> {
  const found: Array<{ absPath: string; line: number; term: string }> = [];
  if (!terms.length) return found;
  const perTerm = new Map<string, number>();
  for (const file of codeFiles(root)) {
    const text = readSmallFile(file);
    if (!text) continue;
    for (const term of terms) {
      if ((perTerm.get(term) ?? 0) >= 2 || !text.includes(term)) continue;
      const line = text.split(/\r?\n/).findIndex((l) => l.includes(term)) + 1;
      found.push({ absPath: file, line, term });
      perTerm.set(term, (perTerm.get(term) ?? 0) + 1);
    }
  }
  return found;
}

function relatedCode(searchRoots: string[], terms: string[]): Array<{ absPath: string; line: number; term: string }> {
  const seen = new Set<string>();
  const out: Array<{ absPath: string; line: number; term: string }> = [];
  for (const root of [...new Set(searchRoots.map((r) => path.resolve(r)))]) {
    for (const ref of findReferences(root, terms)) {
      if (seen.has(ref.absPath)) continue;
      seen.add(ref.absPath);
      out.push(ref);
    }
  }
  return out;
}

export async function collectBundle(options: CollectOptions): Promise<Bundle> {
  const now = options.now ?? Date.now();
  // Freeze first: events arriving while we read files don't change the bundle.
  const snapshot = options.store.snapshot(BUNDLE_WINDOW_MS);
  const roots = [...new Set(options.roots.map((r) => path.resolve(r)))];
  const repoRoot = roots[0];
  const events = await remapBrowserStacks(snapshot, options.fetchText ?? defaultFetchText);

  const secrets = [...(options.secrets ?? [])];
  for (const root of roots) {
    for (const name of ENV_FILES) {
      const content = readSmallFile(path.join(root, name));
      if (content) secrets.push(...parseEnvValues(content));
    }
  }

  const paths: Record<string, string> = {};
  if (repoRoot) paths[repoRoot] = "<root>";
  paths[os.homedir()] = "~";

  return buildBundle({
    events,
    now,
    windowMs: BUNDLE_WINDOW_MS,
    pages: options.pages,
    roots,
    readFile: readSmallFile,
    gitDiff: repoRoot ? await gitDiff(repoRoot) : undefined,
    related: relatedCode(options.searchRoots?.length ? options.searchRoots : repoRoot ? [repoRoot] : [], searchTerms(events)),
    screenshots: options.screenshots,
    redact: { secrets, paths },
  });
}
