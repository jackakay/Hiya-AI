import { describe, expect, it } from "vitest";
import { parseEnvValues, readEnvVar, redact } from "./redact";

describe("redact", () => {
  it.each([
    ["contact jack@example.com now", "contact [email] now"],
    ["Authorization: Bearer abc.def-ghi_123456", "Authorization: Bearer [redacted]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlXzEyMw done", "jwt [redacted-jwt] done"],
    ["key AIzaSyA1234567890abcdefghijklmnopqrstuv end", "key [redacted-key] end"],
    ["groq gsk_abcdefghijklmnopqrstuvwx", "groq [redacted-key]"],
    ["gh ghp_abcdefghijklmnopqrstuvwxyz0123", "gh [redacted-key]"],
    ["aws AKIAABCDEFGHIJKLMNOP", "aws [redacted-key]"],
    ["GET /api/x?user=1&token=s3cr3t&page=2", "GET /api/x?user=1&token=[redacted]&page=2"],
    ["GEMINI_API_KEY=abc123xyz", "GEMINI_API_KEY=[redacted]"],
    ['const password = "hunter2"', 'const password = "[redacted]"'],
    ['{"apiKey": "abcdef"}', '{"apiKey": "[redacted]"}'],
    ["postgres://admin:pw123@localhost:5432/db", "postgres://[redacted]@localhost:5432/db"],
  ])("%s", (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it("leaves code identifiers alone", () => {
    const code = "const token = options.token ?? createToken();\nif (!tokensMatch(token, given)) return;";
    expect(redact(code)).toEqual({ text: code, count: 0 });
  });

  it("does not mistake package versions for emails", () => {
    const line = "at E:\\repo\\node_modules\\.pnpm\\express@4.22.3\\node_modules\\express\\lib\\router\\layer.js:95:5";
    expect(redact(line).text).toBe(line);
  });

  it("hides exact secrets wherever they appear and counts them", () => {
    const r = redact("token=xyz and the value supersecretvalue appears in supersecretvalue", { secrets: ["supersecretvalue", "abc"] });
    expect(r.text).toBe("token=xyz and the value [redacted] appears in [redacted]");
    expect(r.count).toBe(2); // "abc" is too short to redact safely
  });

  it("replaces local paths in either slash style, case-insensitively", () => {
    const r = redact("at E:\\Work\\App\\server\\index.ts:17 and e:/work/app/src/x.ts", { paths: { "E:\\Work\\App": "<root>" } });
    expect(r.text).toBe("at <root>\\server\\index.ts:17 and <root>/src/x.ts");
  });
});

describe("readEnvVar", () => {
  it("finds one variable, unquoted, and treats empty as missing", () => {
    const env = '# keys\nGROQ_API_KEY=\nexport GEMINI_API_KEY="abc123"\nOTHER=x';
    expect(readEnvVar(env, "GEMINI_API_KEY")).toBe("abc123");
    expect(readEnvVar(env, "GROQ_API_KEY")).toBeUndefined();
    expect(readEnvVar(env, "MISSING")).toBeUndefined();
  });
});

describe("parseEnvValues", () => {
  it("reads values, unquoting and skipping comments and empties", () => {
    expect(parseEnvValues('# comment\nGEMINI_API_KEY=abc123\nGROQ_API_KEY=\nNAME="quoted value"\n\nX=\'single\'')).toEqual([
      "abc123",
      "quoted value",
      "single",
    ]);
  });
});
