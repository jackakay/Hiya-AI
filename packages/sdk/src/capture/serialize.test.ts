// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { formatConsoleArgs, serializeValue, type SerializeLimits } from "./serialize";

describe("serializeValue", () => {
  it.each([
    ["hello", "hello"],
    [42, "42"],
    [true, "true"],
    [undefined, "undefined"],
    [null, "null"],
    [10n, "10n"],
    [Symbol("s"), "Symbol(s)"],
    [function named() {}, "[Function named]"],
    [[1, "a", null], '[1, "a", null]'],
    [{ a: 1, "b-c": "x" }, '{a: 1, "b-c": "x"}'],
    [new Map([["k", 1]]), 'Map(1) {"k" => 1}'],
    [new Set([1, 2]), "Set(2) {1, 2}"],
    [new Date(Date.UTC(2026, 0, 1)), "2026-01-01T00:00:00.000Z"],
    [/ab+c/i, "/ab+c/i"],
  ])("%s", (value, expected) => {
    expect(serializeValue(value)).toBe(expected);
  });

  it("marks cycles instead of recursing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(serializeValue(a)).toBe('{name: "a", self: [Circular]}');
  });

  it("prints shared (non-circular) references in full", () => {
    const shared = { x: 1 };
    expect(serializeValue([shared, shared])).toBe("[{x: 1}, {x: 1}]");
  });

  it("limits depth", () => {
    expect(serializeValue({ a: { b: { c: { d: 1 } } } })).toBe("{a: {b: {c: [Object]}}}");
  });

  it("limits items", () => {
    const limits: SerializeLimits = { maxArgLength: 1000, maxMessageLength: 1000, maxDepth: 3, maxItems: 2 };
    expect(serializeValue([1, 2, 3, 4], limits)).toBe("[1, 2, … 2 more]");
    expect(serializeValue({ a: 1, b: 2, c: 3 }, limits)).toBe("{a: 1, b: 2, … 1 more}");
  });

  it("truncates long values", () => {
    const out = serializeValue("x".repeat(1500));
    expect(out.startsWith("x".repeat(1000))).toBe(true);
    expect(out).toContain("[+500 chars]");
  });

  it("includes the stack for errors", () => {
    const err = new TypeError("bad thing");
    const out = serializeValue(err);
    expect(out.startsWith("TypeError: bad thing")).toBe(true);
    expect(out).toContain("\n");
  });

  it("describes DOM elements without reading their content", () => {
    const el = document.createElement("input");
    el.id = "email";
    el.className = "field big";
    el.value = "secret@example.com";
    expect(serializeValue(el)).toBe("<input#email.field.big>");
  });

  it("survives getters that throw", () => {
    const obj = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(serializeValue(obj)).toBe('{boom: "[Getter threw]"}');
  });

  it("names class instances", () => {
    class Point {
      x = 1;
    }
    expect(serializeValue(new Point())).toBe("Point {x: 1}");
  });
});

describe("formatConsoleArgs", () => {
  it("joins arguments like the console does", () => {
    expect(formatConsoleArgs(["saved", 3, { ok: true }])).toBe("saved 3 {ok: true}");
  });

  it("applies format specifiers and drops %c styling", () => {
    expect(formatConsoleArgs(["%cDownload the React DevTools", "font-weight:bold"])).toBe("Download the React DevTools");
    expect(formatConsoleArgs(["%s has %d items (%i%%)", "cart", 3.7, "42", "extra"])).toBe("cart has 3 items (42%) extra");
    expect(formatConsoleArgs(["obj %o", { a: 1 }])).toBe("obj {a: 1}");
    expect(formatConsoleArgs(["missing %s"])).toBe("missing %s");
  });

  it("caps the total message length", () => {
    const limits: SerializeLimits = { maxArgLength: 100, maxMessageLength: 10, maxDepth: 3, maxItems: 10 };
    expect(formatConsoleArgs(["abcdef", "ghijkl"], limits)).toBe("abcdef ghi… [+3 chars]");
  });
});
