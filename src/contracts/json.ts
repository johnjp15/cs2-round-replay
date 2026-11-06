/**
 * Deterministic JSON. Every session-log line goes through stableStringify, so the
 * same value always yields the same bytes in Node, the browser and the C# port.
 *
 * Rules (mirrored in docs/port-notes.md):
 * - object keys sorted ordinally (UTF-16 code units); `undefined` values are an error
 * - no whitespace
 * - numbers: rounded to 6 decimals, half away from zero on the exact binary value
 *   (Number.prototype.toFixed), trailing zeros and a trailing "." removed, `-0` -> `0`,
 *   never exponent notation (|x| >= 1e21 is written as its exact integer digits);
 *   NaN / Infinity are an error
 * - strings: JSON.stringify escaping (ES2019 well-formed: lone surrogates as \udxxx)
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export class JsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonError';
  }
}

/** Canonical number text: 6 decimals max, no exponent, no `-0`. */
export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) throw new JsonError(`stableStringify: non-finite number ${String(x)}`);
  if (Math.abs(x) >= 1e21) {
    // Doubles this large are integers; toFixed would switch to exponent form.
    return BigInt(x).toString();
  }
  let s = x.toFixed(6);
  if (s.indexOf('.') >= 0) {
    let end = s.length;
    while (s.charCodeAt(end - 1) === 48 /* '0' */) end--;
    if (s.charCodeAt(end - 1) === 46 /* '.' */) end--;
    s = s.slice(0, end);
  }
  return s === '-0' ? '0' : s;
}

/** Round a number exactly as stableStringify writes it. */
export function roundNumber(x: number): number {
  return Number(formatNumber(x));
}

/**
 * Deterministic JSON text. Accepts any plain data (interfaces from types.ts are
 * accepted without casting); throws JsonError on undefined, functions, symbols,
 * bigint and non-finite numbers.
 */
export function stableStringify(value: unknown): string {
  const out: string[] = [];
  write(value, out, '$');
  return out.join('');
}

function write(value: unknown, out: string[], path: string): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(formatNumber(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new JsonError(`stableStringify: unsupported ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      write(value[i], out, `${path}[${i}]`);
    }
    out.push(']');
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  out.push('{');
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (i > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    const v = obj[key];
    if (v === undefined) throw new JsonError(`stableStringify: undefined at ${path}.${key}`);
    write(v, out, `${path}.${key}`);
  }
  out.push('}');
}

/** Parse one JSON line (a trailing "\r" is tolerated). Throws JsonError on bad input. */
export function parseJsonLine(line: string): JsonValue {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text.trim() === '') throw new JsonError('parseJsonLine: empty line');
  try {
    return JSON.parse(text) as JsonValue;
  } catch (e) {
    throw new JsonError(`parseJsonLine: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Value as it reads back from a log line: parse(stableStringify(value)). */
export function canonicalize<T>(value: T): T {
  return JSON.parse(stableStringify(value)) as T;
}

/**
 * Plain data (e.g. a state interface without an index signature) as a JsonValue,
 * canonicalized; for building HostSnapshot / CoreSnapshot data.
 */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(stableStringify(value)) as JsonValue;
}

/** FNV-1a 32-bit over the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
export function fnv1a32Hex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    // Combine a valid surrogate pair; a lone surrogate encodes as U+FFFD (like TextEncoder).
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      h = byte(h, cp);
    } else if (cp < 0x800) {
      h = byte(h, 0xc0 | (cp >> 6));
      h = byte(h, 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      h = byte(h, 0xe0 | (cp >> 12));
      h = byte(h, 0x80 | ((cp >> 6) & 0x3f));
      h = byte(h, 0x80 | (cp & 0x3f));
    } else {
      h = byte(h, 0xf0 | (cp >> 18));
      h = byte(h, 0x80 | ((cp >> 12) & 0x3f));
      h = byte(h, 0x80 | ((cp >> 6) & 0x3f));
      h = byte(h, 0x80 | (cp & 0x3f));
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function byte(h: number, b: number): number {
  return Math.imul(h ^ b, 0x01000193) >>> 0;
}
