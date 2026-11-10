import { describe, expect, it } from "vitest";
import { parseDebugPrefix } from "@voice-bug/shared";
import { LineSplitter, stripAnsi, stripDebugPrefixes } from "./lines";

describe("debug prefixes", () => {
  it("parseDebugPrefix splits the id off a line", () => {
    expect(parseDebugPrefix("[debug:vb-1a2b] TypeError: x")).toEqual({ debugId: "vb-1a2b", line: "TypeError: x" });
    expect(parseDebugPrefix("[debug:vb-1a2b]     at a (/a.ts:1:1)")).toEqual({ debugId: "vb-1a2b", line: "    at a (/a.ts:1:1)" });
    expect(parseDebugPrefix("plain line")).toEqual({ line: "plain line" });
    expect(parseDebugPrefix("text [debug:vb-1] later")).toEqual({ line: "text [debug:vb-1] later" });
  });

  it("stripDebugPrefixes cleans raw multi-line output for the terminal", () => {
    expect(stripDebugPrefixes("[debug:a] one\n[debug:a]     at x\nplain\n")).toBe("one\n    at x\nplain\n");
  });
});

describe("stripAnsi", () => {
  it.each([
    ["\u001b[31mred\u001b[39m", "red"],
    ["\u001b[1m\u001b[32m  VITE\u001b[39m\u001b[22m v6", "  VITE v6"],
    ["\u001b[38;5;214morange\u001b[0m", "orange"],
    ["\u001b[38;2;255;0;0mtruecolor\u001b[0m", "truecolor"],
    ["\u001b[2K\u001b[1Gcleared", "cleared"],
    ["\u001b]0;window title\u0007text", "text"],
    ["\u001b]8;;http://localhost:5173\u001b\\link\u001b]8;;\u001b\\", "link"],
    ["\u009b31mc1\u009b0m", "c1"],
    ["TypeError: Cannot read properties of undefined (reading 'trim')", "TypeError: Cannot read properties of undefined (reading 'trim')"],
  ])("%j -> %j", (input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });
});

describe("LineSplitter", () => {
  it("splits on \\n and \\r\\n and keeps the incomplete tail", () => {
    const s = new LineSplitter();
    expect(s.push("a\nb\r\nc")).toEqual(["a", "b"]);
    expect(s.push("d\n")).toEqual(["cd"]);
    expect(s.flush()).toEqual([]);
  });

  it("joins a line split across many chunks", () => {
    const s = new LineSplitter();
    expect(s.push("Type")).toEqual([]);
    expect(s.push("Error: x")).toEqual([]);
    expect(s.push("\n    at foo")).toEqual(["TypeError: x"]);
    expect(s.flush()).toEqual(["    at foo"]);
  });

  it("does not produce a blank line when \\r\\n is split across chunks", () => {
    const s = new LineSplitter();
    expect(s.push("one\r")).toEqual(["one"]);
    expect(s.push("\ntwo\r\n")).toEqual(["two"]);
  });

  it("treats a bare \\r as a line break", () => {
    const s = new LineSplitter();
    expect(s.push("10%\r50%\r100%\n")).toEqual(["10%", "50%", "100%"]);
  });

  it("keeps genuinely empty lines", () => {
    expect(new LineSplitter().push("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("caps runaway lines", () => {
    const s = new LineSplitter(4);
    expect(s.push("abcdefghij")).toEqual(["abcd", "efgh"]);
    expect(s.flush()).toEqual(["ij"]);
  });
});
