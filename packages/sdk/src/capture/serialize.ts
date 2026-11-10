/**
 * Safe, bounded serialization of arbitrary values (console arguments,
 * rejection reasons). Never throws, never follows cycles, never calls
 * user getters more than a bounded number of times, always truncates.
 */

export type SerializeLimits = {
  /** Max characters for a single serialized argument. */
  maxArgLength: number;
  /** Max characters for the joined message. */
  maxMessageLength: number;
  /** How deep to descend into objects/arrays. */
  maxDepth: number;
  /** Max object keys / array items shown per level. */
  maxItems: number;
};

export const DEFAULT_LIMITS: SerializeLimits = {
  maxArgLength: 1000,
  maxMessageLength: 4000,
  maxDepth: 3,
  maxItems: 30,
};

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

function isElement(v: object): v is Element {
  return typeof Element !== "undefined" && v instanceof Element;
}

function describeElement(el: Element): string {
  let s = `<${el.tagName.toLowerCase()}`;
  if (el.id) s += `#${el.id}`;
  const cls = [...el.classList].slice(0, 3);
  if (cls.length) s += `.${cls.join(".")}`;
  return `${s}>`;
}

/** "Name: message" plus the stack (which in V8 already starts with that line). */
export function describeError(err: Error): string {
  let head: string;
  try {
    head = `${err.name}: ${err.message}`;
  } catch {
    head = "Error";
  }
  const stack = typeof err.stack === "string" ? err.stack : "";
  if (!stack) return head;
  return stack.startsWith(head) ? stack : `${head}\n${stack}`;
}

function serialize(value: unknown, depth: number, seen: WeakSet<object>, limits: SerializeLimits): string {
  switch (typeof value) {
    case "string":
      return depth === 0 ? value : JSON.stringify(value);
    case "number":
    case "boolean":
    case "undefined":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${value.name || "(anonymous)"}]`;
  }
  if (value === null) return "null";
  const obj = value as object;

  if (obj instanceof Error) return describeError(obj);
  if (isElement(obj)) return describeElement(obj);
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof RegExp) return String(obj);
  if (seen.has(obj)) return "[Circular]";

  const isArray = Array.isArray(obj);
  if (depth >= limits.maxDepth) return isArray ? `[Array(${(obj as unknown[]).length})]` : "[Object]";
  seen.add(obj);
  try {
    if (isArray) {
      const arr = obj as unknown[];
      const items = arr.slice(0, limits.maxItems).map((v) => serialize(v, depth + 1, seen, limits));
      if (arr.length > limits.maxItems) items.push(`… ${arr.length - limits.maxItems} more`);
      return `[${items.join(", ")}]`;
    }
    if (obj instanceof Map) {
      const entries = [...obj.entries()].slice(0, limits.maxItems);
      const parts = entries.map(([k, v]) => `${serialize(k, depth + 1, seen, limits)} => ${serialize(v, depth + 1, seen, limits)}`);
      if (obj.size > limits.maxItems) parts.push(`… ${obj.size - limits.maxItems} more`);
      return `Map(${obj.size}) {${parts.join(", ")}}`;
    }
    if (obj instanceof Set) {
      const parts = [...obj.values()].slice(0, limits.maxItems).map((v) => serialize(v, depth + 1, seen, limits));
      if (obj.size > limits.maxItems) parts.push(`… ${obj.size - limits.maxItems} more`);
      return `Set(${obj.size}) {${parts.join(", ")}}`;
    }

    const keys = Object.keys(obj);
    const parts: string[] = [];
    for (const key of keys.slice(0, limits.maxItems)) {
      let v: unknown;
      try {
        v = (obj as Record<string, unknown>)[key];
      } catch {
        v = "[Getter threw]";
      }
      const k = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      parts.push(`${k}: ${serialize(v, depth + 1, seen, limits)}`);
    }
    if (keys.length > limits.maxItems) parts.push(`… ${keys.length - limits.maxItems} more`);
    const ctor = Object.getPrototypeOf(obj)?.constructor?.name;
    const prefix = ctor && ctor !== "Object" ? `${ctor} ` : "";
    return `${prefix}{${parts.join(", ")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Serializes one value. Strings at the top level are kept unquoted, like the console does. */
export function serializeValue(value: unknown, limits: SerializeLimits = DEFAULT_LIMITS): string {
  try {
    return truncate(serialize(value, 0, new WeakSet(), limits), limits.maxArgLength);
  } catch {
    return "[Unserializable]";
  }
}

/**
 * Applies console format specifiers (%s %d %i %f %o %O %j) the way browsers
 * do, and drops %c styling and its CSS argument. Returns the formatted head
 * and the arguments that were not consumed.
 */
function applyFormat(format: string, args: readonly unknown[], limits: SerializeLimits): { head: string; rest: readonly unknown[] } {
  let i = 0;
  const head = format.replace(/%([sdifoOjc%])/g, (match, spec: string) => {
    if (spec === "%") return "%";
    if (i >= args.length) return match;
    const arg = args[i++];
    switch (spec) {
      case "c":
        return "";
      case "d":
      case "i":
        return typeof arg === "number" ? String(Math.trunc(arg)) : String(parseInt(String(arg), 10));
      case "f":
        return String(typeof arg === "number" ? arg : parseFloat(String(arg)));
      default:
        return serializeValue(arg, limits);
    }
  });
  return { head, rest: args.slice(i) };
}

/** Joins console arguments into one bounded message string. */
export function formatConsoleArgs(args: readonly unknown[], limits: SerializeLimits = DEFAULT_LIMITS): string {
  let parts = args;
  let head: string | undefined;
  if (typeof args[0] === "string" && args[0].includes("%")) {
    const formatted = applyFormat(args[0], args.slice(1), limits);
    head = truncate(formatted.head, limits.maxArgLength);
    parts = formatted.rest;
  }
  const serialized = parts.map((a) => serializeValue(a, limits));
  if (head !== undefined) serialized.unshift(head);
  return truncate(serialized.join(" "), limits.maxMessageLength);
}
