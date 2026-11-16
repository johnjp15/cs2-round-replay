/**
 * Helpers for the per-area tuning files (`data/coach/tuning/<area>.json`). Each area's folder has a small typed
 * loader that imports its JSON and checks it with these, so a missing or mistyped field fails at load, not later.
 * Keys starting with `_` are notes and are ignored.
 */

/** The object at `path` (dot-separated) of `json`, or an error naming the file. */
export function section(json: unknown, path: string, file: string): Record<string, unknown> {
  let o: unknown = json;
  for (const k of path.split('.')) {
    if (o === null || typeof o !== 'object') throw new Error(`${file}: no section ${path}`);
    o = (o as Record<string, unknown>)[k];
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${file}: no section ${path}`);
  return o as Record<string, unknown>;
}

/** Copy the named finite numbers out of `o` (throws on a missing or non-numeric one). */
export function numbers<K extends string>(o: Record<string, unknown>, keys: readonly K[], where: string): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: ${k} must be a number`);
    out[k] = v;
  }
  return out;
}

/** A list of finite numbers (ascending is checked when `ascending`). */
export function numberList(o: Record<string, unknown>, key: string, where: string, ascending = false): number[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`${where}: ${key} must be a list of numbers`);
  const list = v as number[];
  if (ascending) for (let i = 1; i < list.length; i++) if ((list[i] as number) <= (list[i - 1] as number)) throw new Error(`${where}: ${key} must be ascending`);
  return [...list];
}

/** A list of strings. */
export function stringList(o: Record<string, unknown>, key: string, where: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${where}: ${key} must be a list of strings`);
  return [...(v as string[])];
}
