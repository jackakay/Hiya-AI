import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Event } from "@voice-bug/shared";
import { buildBundle, causalChain, compactStackLines, excerpt, framesFor, isErrorEvent, resolveFrameFile, searchTerms, sourceWindow, type BundleInput } from "./bundle";

const ROOT = path.resolve("/work/voice-bug");
const SERVER = path.join(ROOT, "demo-app", "server", "index.ts");
const APP_ROOT = path.join(ROOT, "demo-app");

const serverSource = Array.from({ length: 40 }, (_, i) => (i + 1 === 17 ? "  const name = req.body.name.trim();" : `// line ${i + 1}`)).join("\n");

const backend = (ts: number, line: string, type = "stderr"): Event => ({ ts, source: "backend", type, payload: { line } });

/** What pressing Save with an empty box produces (milestone 2a capture). */
function demoEvents(): Event[] {
  return [
    { ts: 1000, source: "backend", type: "stdout", payload: { line: "demo-app running at http://localhost:5173" } },
    { ts: 5000, source: "network", type: "request", payload: { api: "fetch", method: "GET", url: "/api/notes", status: 200, durationMs: 6 } },
    { ts: 9000, source: "action", type: "click", payload: { selector: "#save", tag: "button", text: "Save", x: 1, y: 2, url: "/" } },
    { ts: 9003, source: "network", type: "request", payload: { api: "fetch", method: "POST", url: "/api/save", status: 500, durationMs: 26 } },
    backend(9020, "TypeError: Cannot read properties of undefined (reading 'trim')"),
    backend(9020, `    at <anonymous> (${SERVER}:17:30)`),
    backend(9020, `    at Layer.handle [as handle_request] (${path.join(ROOT, "node_modules", "express", "lib", "router", "layer.js")}:95:5)`),
    backend(9021, `    at next (${path.join(ROOT, "node_modules", "express", "lib", "router", "route.js")}:149:13)`),
    backend(9021, "    at process.processTicksAndRejections (node:internal/process/task_queues:89:21)"),
  ];
}

function input(overrides: Partial<BundleInput> = {}): BundleInput {
  const files = new Map([[SERVER, serverSource]]);
  return {
    events: demoEvents(),
    now: 10_000,
    windowMs: 60_000,
    roots: [ROOT, APP_ROOT],
    readFile: (p) => files.get(path.normalize(p)),
    redact: { paths: { [ROOT]: "<root>" } },
    ...overrides,
  };
}

describe("isErrorEvent", () => {
  it.each([
    [{ source: "network", type: "request", payload: { status: 500 } }, true],
    [{ source: "network", type: "request", payload: { status: 404 } }, true],
    [{ source: "network", type: "request", payload: { status: 304 } }, false],
    [{ source: "network", type: "request", payload: { error: "network error" } }, true],
    [{ source: "network", type: "request", payload: { error: "aborted" } }, false],
    [{ source: "console", type: "error", payload: { level: "error", message: "x" } }, true],
    [{ source: "console", type: "warn", payload: { level: "warn", message: "x" } }, false],
    [{ source: "console", type: "unhandled-rejection", payload: { message: "x" } }, true],
    [{ source: "backend", type: "stderr", payload: { line: "TypeError: x" } }, true],
    [{ source: "backend", type: "stdout", payload: { line: "Error: listen EADDRINUSE" } }, true],
    [{ source: "backend", type: "stderr", payload: { line: "    at foo (/a.ts:1:1)" } }, false],
    [{ source: "backend", type: "stderr", payload: { line: "(node:1) Warning: something" } }, false],
    [{ source: "action", type: "click", payload: {} }, false],
  ])("%j -> %s", (partial, expected) => {
    expect(isErrorEvent({ ts: 0, ...partial } as Event)).toBe(expected);
  });
});

describe("searchTerms", () => {
  const req = (url: string, status = 200): Event => ({ ts: 1, source: "network", type: "request", payload: { api: "fetch", method: "GET", url, status, durationMs: 1 } });

  it("uses failing requests, cutting ids off the path", () => {
    expect(searchTerms([req("/api/notes"), req("/api/notes/0", 404), req("/api/users/3f2a9c1b7d/avatar", 500)])).toEqual(["/api/users/", "/api/notes/"]);
  });

  it("falls back to the latest requests, dropping query strings and other origins", () => {
    expect(searchTerms([req("/api/notes"), req("https://cdn.example.com/x.js"), req("/api/search?q=w"), req("/api/search?q=we")])).toEqual(["/api/search", "/api/notes"]);
  });
});

describe("compactStackLines", () => {
  it("collapses dependency frames but keeps the user's", () => {
    expect(
      compactStackLines(["TypeError: x", "    at a (/app/src/a.ts:1:1)", "    at b (/app/node_modules/x/y.js:2:2)", "    at c (node:internal/z:3:3)", "    at d (/app/src/d.ts:4:4)"]),
    ).toEqual(["TypeError: x", "    at a (/app/src/a.ts:1:1)", "    … 2 frames in dependencies/runtime", "    at d (/app/src/d.ts:4:4)"]);
  });
});

describe("excerpt", () => {
  it("numbers lines and marks the target, clamped to the file", () => {
    const ex = excerpt("a\nb\nc\nd\ne", 2, 1);
    expect(ex).toEqual({ from: 1, to: 3, text: "  1 | a\n> 2 | b\n  3 | c" });
  });
});

describe("sourceWindow", () => {
  it("sends small files whole and large files as a window around the line", () => {
    const small = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join("\n");
    expect(sourceWindow(small, 60, 12)).toMatchObject({ from: 1, to: 100 });
    const large = Array.from({ length: 400 }, (_, i) => `l${i + 1}`).join("\n");
    expect(sourceWindow(large, 200, 12)).toMatchObject({ from: 188, to: 212 });
  });
});

describe("resolveFrameFile", () => {
  const exists = (p: string) => p === SERVER || p === path.join(APP_ROOT, "src", "App.tsx");

  it("accepts absolute paths inside a root", () => {
    expect(resolveFrameFile(SERVER, [ROOT], exists)).toBe(SERVER);
  });

  it("maps dev-server URLs onto the app folder", () => {
    expect(resolveFrameFile("http://localhost:5173/src/App.tsx", [ROOT, APP_ROOT], exists)).toBe(path.join(APP_ROOT, "src", "App.tsx"));
  });

  it("never reads outside the roots", () => {
    const outside = path.resolve("/etc/passwd");
    expect(resolveFrameFile(outside, [ROOT], () => true)).toBeUndefined();
    expect(resolveFrameFile("../../etc/passwd", [ROOT], () => true)).toBeUndefined();
  });
});

describe("buildBundle", () => {
  it("centres the planted bug on the backend TypeError, with the click, the 500 and the source line", () => {
    const b = buildBundle(input());

    expect(b.eventCount).toBe(9);
    expect(b.errorCount).toBe(2); // POST 500 + TypeError
    expect(b.anchorRef).toBe("E5");
    expect(b.sourceFiles).toEqual(["demo-app/server/index.ts"]);

    expect(b.text).toContain("## Last error\n\nE5 backend/stderr TypeError: Cannot read properties of undefined (reading 'trim')");
    expect(b.text).toContain("E3    -0.020s  action/click #save \"Save\"");
    expect(b.text).toContain("E4    -0.017s  network/request POST /api/save → 500 (26ms, fetch)");
    // User frame kept, dependency/runtime frames collapsed.
    expect(b.text).toContain(`E6     0.000s  backend/stderr     at <anonymous> (<root>${path.sep}demo-app${path.sep}server${path.sep}index.ts:17:30)`);
    expect(b.text).toContain("… 3 frames in dependencies/runtime");
    expect(b.text).not.toContain("layer.js");
    // Stack + excerpt around line 17.
    expect(b.text).toContain("- <anonymous> — demo-app/server/index.ts:17:30");
    expect(b.text).toContain("### demo-app/server/index.ts (lines 1–40, frame at line 17)");
    expect(b.text).toContain("> 17 |   const name = req.body.name.trim();");
    // No absolute paths leak.
    expect(b.text).not.toContain(ROOT);
  });

  it("works without any error", () => {
    const b = buildBundle(input({ events: demoEvents().slice(0, 3) }));
    expect(b.anchorRef).toBeUndefined();
    expect(b.text).toContain("No error was captured in this window.");
    expect(b.text).not.toContain("## Source");
  });

  it("uses a frontend error's stack when the backend has none", () => {
    const appFile = path.join(APP_ROOT, "src", "App.tsx");
    const events: Event[] = [
      {
        ts: 1,
        source: "console",
        type: "uncaught-error",
        payload: { message: "TypeError: x is undefined", stack: "TypeError: x is undefined\n    at save (http://localhost:5173/src/App.tsx?t=1:3:7)\n    at http://localhost:5173/node_modules/.vite/deps/react-dom.js:10:1" },
      },
    ];
    const files = new Map([[appFile, "a\nb\nconst y = x.z;\nd"]]);
    const b = buildBundle(input({ events, readFile: (p) => files.get(path.normalize(p)) }));
    expect(b.sourceFiles).toEqual(["demo-app/src/App.tsx"]);
    expect(b.text).toContain("> 3 | const y = x.z;");
  });

  it("redacts secrets in captured output and the diff", () => {
    const events: Event[] = [backend(1, "Error: auth failed for jack@example.com with key AIzaSyA1234567890abcdefghijklmnopqrstuv")];
    const b = buildBundle(input({ events, gitDiff: "+const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz'\n", redact: { secrets: ["hub-session-token-123"] } }));
    expect(b.text).not.toContain("jack@example.com");
    expect(b.text).not.toContain("AIzaSy");
    expect(b.text).not.toContain("sk-abc");
    expect(b.redactions).toBeGreaterThanOrEqual(3);
    expect(b.text).toContain("## Uncommitted changes (git diff)");
  });

  it("links click → request → server stack by X-Debug-Id, even with another request's output interleaved", () => {
    const id = "vb-aaaa";
    const other = "vb-bbbb";
    const tag = (e: Event, debugId: string): Event => ({ ...e, debugId });
    const events: Event[] = [
      { ts: 9000, source: "action", type: "click", payload: { selector: "#save", tag: "button", text: "Save", x: 1, y: 2, url: "/", actionId: "act-1" } },
      tag({ ts: 9003, source: "network", type: "request", payload: { api: "fetch", method: "POST", url: "/api/save", status: 500, durationMs: 26, actionId: "act-1" } }, id),
      tag({ ts: 9004, source: "network", type: "request", payload: { api: "fetch", method: "GET", url: "/api/other", status: 200, durationMs: 30 } }, other),
      tag(backend(9020, "TypeError: Cannot read properties of undefined (reading 'trim')"), id),
      tag(backend(9020, "trace from the other request"), other),
      tag(backend(9020, `    at <anonymous> (${SERVER}:17:30)`), id),
      tag(backend(9021, `    at elsewhere (${path.join(ROOT, "demo-app", "server", "other.ts")}:5:1)`), other),
      tag(backend(9021, `    at next (${path.join(ROOT, "node_modules", "express", "lib", "router", "route.js")}:149:13)`), id),
    ];

    const chain = causalChain(events);
    expect(chain?.debugId).toBe(id);
    expect(chain?.click?.ts).toBe(9000);
    expect(chain?.request?.debugId).toBe(id);
    expect(chain?.backend.map((e) => (e.payload as { line: string }).line)).toEqual([
      "TypeError: Cannot read properties of undefined (reading 'trim')",
      `    at <anonymous> (${SERVER}:17:30)`,
      `    at next (${path.join(ROOT, "node_modules", "express", "lib", "router", "route.js")}:149:13)`,
    ]);

    // The other request's frame is not mixed into this stack.
    expect(framesFor(events[3]!, events).map((f) => f.line)).toEqual([17, 149]);

    const b = buildBundle(input({ events }));
    expect(b.text).toContain(`## What happened (linked by X-Debug-Id ${id})`);
    expect(b.text).toContain('1. E1 action/click #save "Save"');
    expect(b.text).toContain(`2. E2 network/request [${id}] POST /api/save → 500 (26ms, fetch) (started 0.003s after the click)`);
    expect(b.text).toContain("3. E4–E8 server output for this request:");
    expect(b.sourceFiles).toEqual(["demo-app/server/index.ts"]);
  });

  it("says so when no click started the request", () => {
    const events: Event[] = [
      { ts: 1, source: "network", type: "request", debugId: "vb-x", payload: { api: "fetch", method: "GET", url: "/a", status: 500, durationMs: 1 } },
    ];
    expect(buildBundle(input({ events })).text).toContain("No click within 1.5s before the request");
  });

  it("adds related code found by request URL when there's no stack (e.g. a 404 the UI ignored)", () => {
    const app = path.join(APP_ROOT, "src", "App.tsx");
    const appText = Array.from({ length: 30 }, (_, i) => (i + 1 === 12 ? "    await fetch(`/api/notes/${index}`, { method: \"DELETE\" });" : `// ${i + 1}`)).join("\n");
    const files = new Map([[app, appText]]);
    const events: Event[] = [
      { ts: 1, source: "network", type: "request", payload: { api: "fetch", method: "DELETE", url: "/api/notes/0", status: 404, durationMs: 3 } },
    ];
    const b = buildBundle(input({ events, readFile: (p) => files.get(path.normalize(p)), related: [{ absPath: app, line: 12, term: "/api/notes/" }] }));
    expect(b.sourceFiles).toEqual(["demo-app/src/App.tsx"]);
    expect(b.sources[0]).toMatchObject({ from: 1, to: 30, line: 12 });
    expect(b.text).toContain("### demo-app/src/App.tsx (lines 1–30, mentions /api/notes/ at line 12)");
  });

  it("never includes related files outside the roots", () => {
    const outside = path.resolve("/elsewhere/secret.ts");
    const b = buildBundle(input({ events: [], readFile: () => "x", related: [{ absPath: outside, line: 1, term: "/api" }] }));
    expect(b.sourceFiles).toEqual([]);
  });

  it("mentions screenshots", () => {
    const b = buildBundle(input({ screenshots: [{ ts: 9010, reason: "click" }] }));
    expect(b.text).toContain("## Screenshots (attached as images, in this order)");
    expect(b.text).toContain("- S1 -0.010s after a click");
  });

  it("truncates a long diff", () => {
    const b = buildBundle(input({ gitDiff: "+x\n".repeat(5000) }));
    expect(b.text).toMatch(/diff truncated \(\d+ more chars\)/);
  });
});
