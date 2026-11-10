import { describe, expect, it } from "vitest";
import { decodeMappings, decodeVlq, inlineSourceMap, originalPosition, remapStack, type RawSourceMap } from "./sourcemap";

describe("decodeVlq", () => {
  it.each([
    ["A", [0]],
    ["C", [1]],
    ["D", [-1]],
    ["gB", [16]],
    ["AAgBC", [0, 0, 16, 1]],
    ["UAAI", [10, 0, 0, 4]],
  ])("%s", (vlq, expected) => expect(decodeVlq(vlq)).toEqual(expected));
});

// Generated line 1 maps nothing; line 2 col 0 → source 0 line 5 col 0; col 10 → line 5 col 4.
const map: RawSourceMap = { version: 3, sources: ["E:/repo/demo-app/src/App.tsx"], mappings: ";AAIA,UAAI" };

describe("originalPosition", () => {
  it("maps generated positions back to the source", () => {
    expect(decodeMappings(map.mappings)).toEqual([[], [[0, 0, 4, 0], [10, 0, 4, 4]]]);
    expect(originalPosition(map, 2, 1)).toEqual({ source: "E:/repo/demo-app/src/App.tsx", line: 5, column: 1 });
    expect(originalPosition(map, 2, 15)).toEqual({ source: "E:/repo/demo-app/src/App.tsx", line: 5, column: 5 });
    expect(originalPosition(map, 1, 1)).toBeUndefined();
  });
});

describe("inlineSourceMap", () => {
  it("reads Vite's inline base64 map", () => {
    const code = `const x = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
    expect(inlineSourceMap(code)?.sources).toEqual(["E:/repo/demo-app/src/App.tsx"]);
    expect(inlineSourceMap("const x = 1;")).toBeUndefined();
  });
});

describe("remapStack", () => {
  const served = `x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  const fetchText = async (url: string) => (url.startsWith("http://localhost:5173/src/App.tsx") ? served : undefined);

  it("rewrites app frames to original files and lines, leaving dependencies alone", async () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'join')",
      "    at App (http://localhost:5173/src/App.tsx?t=1731171234:2:15)",
      "    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=abc:11596:26)",
    ].join("\n");
    expect(await remapStack(stack, fetchText)).toBe(
      [
        "TypeError: Cannot read properties of undefined (reading 'join')",
        "    at App (E:/repo/demo-app/src/App.tsx:5:5)",
        "    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=abc:11596:26)",
      ].join("\n"),
    );
  });

  it("leaves frames alone when no map is available", async () => {
    const stack = "Error: x\n    at f (http://localhost:5173/src/other.ts:3:1)";
    expect(await remapStack(stack, fetchText)).toBe(stack);
  });
});
