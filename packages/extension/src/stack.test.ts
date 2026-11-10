import { describe, expect, it } from "vitest";
import { isInternalFrame, parseStack, parseStackLine } from "./stack";

describe("parseStackLine", () => {
  it.each([
    ["    at <anonymous> (E:\\repo\\demo-app\\server\\index.ts:17:30)", { fn: "<anonymous>", file: "E:\\repo\\demo-app\\server\\index.ts", line: 17, column: 30 }],
    ["    at E:\\repo\\node_modules\\express\\lib\\router\\index.js:284:15", { file: "E:\\repo\\node_modules\\express\\lib\\router\\index.js", line: 284, column: 15 }],
    ["    at save (http://localhost:5173/src/App.tsx?t=1731171234:12:5)", { fn: "save", file: "http://localhost:5173/src/App.tsx", line: 12, column: 5 }],
    ["    at async Promise.all (index 0)", undefined],
    ["    at new Promise (<anonymous>)", undefined],
    ["    at process.processTicksAndRejections (node:internal/process/task_queues:89:21)", { fn: "process.processTicksAndRejections", file: "node:internal/process/task_queues", line: 89, column: 21 }],
    ["    at handler (file:///home/me/app/server.mjs:3:9)", { fn: "handler", file: "/home/me/app/server.mjs", line: 3, column: 9 }],
    ["    at handler (file:///E:/app/server.mjs:3:9)", { fn: "handler", file: "E:/app/server.mjs", line: 3, column: 9 }],
    ["TypeError: nope", undefined],
  ])("%s", (line, expected) => {
    expect(parseStackLine(line)).toEqual(expected);
  });
});

describe("parseStack", () => {
  it("skips the message line", () => {
    const frames = parseStack("TypeError: x\n    at a (/app/a.ts:1:2)\n    at b (/app/b.ts:3:4)");
    expect(frames.map((f) => f.fn)).toEqual(["a", "b"]);
  });
});

describe("isInternalFrame", () => {
  it.each([
    ["E:\\repo\\node_modules\\.pnpm\\express@4.22.3\\node_modules\\express\\lib\\router\\layer.js", true],
    ["/repo/node_modules/react-dom/cjs/react-dom.development.js", true],
    ["node:internal/process/task_queues", true],
    ["http://localhost:5173/node_modules/.vite/deps/react-dom.js", true],
    ["http://localhost:5173/@vite/client", true],
    ["E:\\repo\\demo-app\\server\\index.ts", false],
    ["http://localhost:5173/src/App.tsx", false],
  ])("%s -> %s", (file, expected) => {
    expect(isInternalFrame(file)).toBe(expected);
  });
});
