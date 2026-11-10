import { describe, expect, it, vi } from "vitest";
import { getDebugId, patchConsole, prefixLines, readDebugId, runWithDebugId, voiceBug } from "./index";

function fakeConsole() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  const target = { log: write, info: write, warn: write, error: write, debug: write } as unknown as Console;
  return { target, lines };
}

describe("prefixLines", () => {
  it("prefixes every non-empty line", () => {
    expect(prefixLines("TypeError: x\n    at a (/a.ts:1:1)\n", "abc")).toBe("[debug:abc] TypeError: x\n[debug:abc]     at a (/a.ts:1:1)\n");
  });
});

describe("readDebugId", () => {
  it.each([
    [{ "x-debug-id": "vb-1a2b3c" }, "vb-1a2b3c"],
    [{ "x-debug-id": ["first", "second"] }, "first"],
    [{ "x-debug-id": "has spaces" }, undefined],
    [{ "x-debug-id": "a".repeat(65) }, undefined],
    [{ "x-debug-id": "] [debug:spoof" }, undefined],
    [{}, undefined],
  ])("%j -> %s", (headers, expected) => {
    expect(readDebugId({ headers })).toBe(expected);
  });
});

describe("patchConsole", () => {
  it("prefixes only inside a request, formatting arguments like console does", async () => {
    const { target, lines } = fakeConsole();
    patchConsole(target);

    target.log("before");
    runWithDebugId("abc", () => target.log("saved note %d", 3, { ok: true }));
    await runWithDebugId("def", async () => {
      await new Promise((r) => setTimeout(r, 1));
      target.error(new TypeError("boom"));
    });
    target.log("after");

    expect(lines[0]).toBe("before");
    expect(lines[1]).toBe("[debug:abc] saved note 3 { ok: true }");
    // Every line of the stack carries the id, even after an await.
    const errorLines = lines[2]!.split("\n");
    expect(errorLines[0]).toBe("[debug:def] TypeError: boom");
    expect(errorLines.length).toBeGreaterThan(1);
    expect(errorLines.every((l) => l.startsWith("[debug:def] "))).toBe(true);
    expect(lines[3]).toBe("after");
  });
});

describe("voiceBug middleware", () => {
  it("runs the rest of the chain with the id and echoes it back", () => {
    const setHeader = vi.fn();
    let seen: string | undefined;
    voiceBug()({ headers: { "x-debug-id": "vb-42" } }, { setHeader }, () => {
      seen = getDebugId();
    });
    expect(seen).toBe("vb-42");
    expect(setHeader).toHaveBeenCalledWith("X-Debug-Id", "vb-42");
    expect(getDebugId()).toBeUndefined();
  });

  it("passes requests without the header straight through", () => {
    const setHeader = vi.fn();
    const next = vi.fn(() => expect(getDebugId()).toBeUndefined());
    voiceBug()({ headers: {} }, { setHeader }, next);
    expect(next).toHaveBeenCalledOnce();
    expect(setHeader).not.toHaveBeenCalled();
  });
});
