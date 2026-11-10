/**
 * Redaction applied to the whole bundle before anything leaves the machine.
 * Errs on the side of hiding literals while keeping code readable: identifiers
 * like `token` or `createToken()` are left alone, values are replaced.
 */

export type RedactResult = { text: string; count: number };

export type RedactOptions = {
  /** Exact strings to hide wherever they appear (.env values, the session token, ...). */
  secrets?: readonly string[];
  /** Absolute paths to replace with a label, e.g. { "E:\\work\\app": "<root>" }. */
  paths?: Readonly<Record<string, string>>;
};

const SECRET_KEY = String.raw`(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth(?:orization)?|session(?:id)?|cookie|credentials?)`;

type Rule = { pattern: RegExp; replace: string | ((...m: string[]) => string) };

const RULES: Rule[] = [
  // Well-known credential formats.
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replace: "[redacted-jwt]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: "[redacted-key]" },
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g, replace: "[redacted-key]" },
  { pattern: /\bgsk_[A-Za-z0-9]{20,}/g, replace: "[redacted-key]" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "[redacted-key]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[redacted-key]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "[redacted-key]" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[redacted-private-key]" },
  // Authorization header values.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: "$1 [redacted]" },
  // URLs with credentials: scheme://user:pass@host
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: "$1[redacted]@" },
  // Secret-looking query parameters.
  { pattern: new RegExp(String.raw`([?&]${SECRET_KEY}=)[^&\s#"']+`, "gi"), replace: "$1[redacted]" },
  // ENV-style assignments: GEMINI_API_KEY=abc
  { pattern: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*\s*=\s*)(?!\[redacted)[^\s"'`]+/g, replace: "$1[redacted]" },
  // Quoted literals assigned to secret-named keys: password: "hunter2", "token": "abc"
  {
    pattern: new RegExp(String.raw`(["']?\w*${SECRET_KEY}\w*["']?\s*[:=]\s*)(["'\`])((?:(?!\2).){3,}?)\2`, "gi"),
    replace: (_m, prefix, quote) => `${prefix}${quote}[redacted]${quote}`,
  },
  // Email addresses.
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, replace: "[email]" },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countingReplace(text: string, pattern: RegExp, replace: Rule["replace"]): RedactResult {
  let count = 0;
  const out = text.replace(pattern, (...args: unknown[]) => {
    count++;
    if (typeof replace === "function") return replace(...(args as string[]));
    // Expand $1..$9 the way String.replace would.
    return replace.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)] ?? ""));
  });
  return { text: out, count };
}

export function redact(text: string, options: RedactOptions = {}): RedactResult {
  let count = 0;
  let out = text;

  // Exact secrets first, longest first so a value containing another is fully hidden.
  const secrets = [...new Set(options.secrets ?? [])].filter((s) => s.trim().length >= 6).sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    const r = countingReplace(out, new RegExp(escapeRegExp(secret), "g"), "[redacted]");
    out = r.text;
    count += r.count;
  }

  for (const rule of RULES) {
    const r = countingReplace(out, rule.pattern, rule.replace);
    out = r.text;
    count += r.count;
  }

  // Local paths reveal user names and folder layout; they aren't counted as redactions.
  for (const [p, label] of Object.entries(options.paths ?? {}).sort((a, b) => b[0].length - a[0].length)) {
    if (!p) continue;
    const variants = new Set([p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")]);
    for (const v of variants) out = out.replace(new RegExp(escapeRegExp(v), "gi"), label);
  }

  return { text: out, count };
}

/** One variable's value from .env content, or undefined. */
export function readEnvVar(content: string, name: string): string | undefined {
  for (const raw of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || m[1] !== name) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value || undefined;
  }
  return undefined;
}

/** Values from a .env file, for use as `secrets`. Comments and blank lines are ignored. */
export function parseEnvValues(content: string): string[] {
  const values: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) values.push(value);
  }
  return values;
}
