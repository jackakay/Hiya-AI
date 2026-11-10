import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findReferences } from "./collect";

const root = mkdtempSync(path.join(tmpdir(), "voice-bug-refs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};

const app = write("demo-app/src/App.tsx", 'a\nb\n  await fetch(`/api/notes/${index}`, { method: "DELETE" });\n');
const server = write("demo-app/server/index.ts", 'x\napp.delete("/api/notes/:id", (req, res) => {\n');
write("node_modules/lib/index.js", 'fetch("/api/notes/1")');
write("demo-app/dist/bundle.js", 'fetch("/api/notes/1")');
write("demo-app/src/App.test.tsx", 'fetch("/api/notes/1")');
write("demo-app/README.md", "/api/notes/");

describe("findReferences", () => {
  it("finds the client and server code for a request path, skipping deps, builds, tests and docs", () => {
    const refs = findReferences(root, ["/api/notes/"]).sort((a, b) => a.absPath.localeCompare(b.absPath));
    expect(refs).toEqual(
      [
        { absPath: server, line: 2, term: "/api/notes/" },
        { absPath: app, line: 3, term: "/api/notes/" },
      ].sort((a, b) => a.absPath.localeCompare(b.absPath)),
    );
  });

  it("returns nothing for no terms or no matches", () => {
    expect(findReferences(root, [])).toEqual([]);
    expect(findReferences(root, ["/api/nope"])).toEqual([]);
  });
});
