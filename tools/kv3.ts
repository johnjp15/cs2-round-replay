/**
 * A1: a reader for Valve's KeyValues3 text format (the decompiled `.vsndevts` sound event files in
 * SteamDatabase/GameTracking-CS2, `game/csgo/pak01_dir/soundevents/*.vsndevts`). Enough of the format for those
 * files: the `<!-- kv3 ... -->` header, `{ key = value }` objects, `[ a, b, ]` arrays, quoted strings, numbers,
 * true / false / null, `//` and `/* *\/` comments, resource prefixes (`soundevent:"Name"` → the string) and
 * multi-line `"""` strings.
 */
export type Kv3 = string | number | boolean | null | Kv3[] | { [key: string]: Kv3 };

export class Kv3Error extends Error {
  constructor(message: string, at: number) {
    super(`kv3: ${message} at offset ${at}`);
    this.name = 'Kv3Error';
  }
}

export function parseKv3(text: string): Kv3 {
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    for (;;) {
      while (i < n && /\s/.test(text[i] as string)) i++;
      if (text.startsWith('//', i)) {
        while (i < n && text[i] !== '\n') i++;
      } else if (text.startsWith('/*', i)) {
        const e = text.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else if (text.startsWith('<!--', i)) {
        const e = text.indexOf('-->', i + 4);
        i = e < 0 ? n : e + 3;
      } else return;
    }
  };
  const str = (): string => {
    if (text.startsWith('"""', i)) {
      const e = text.indexOf('"""', i + 3);
      if (e < 0) throw new Kv3Error('unterminated """ string', i);
      const s = text.slice(i + 3, e);
      i = e + 3;
      return s;
    }
    i++;
    let s = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) {
        const c = text[i + 1] as string;
        s += c === 'n' ? '\n' : c === 't' ? '\t' : c;
        i += 2;
      } else s += text[i++];
    }
    if (i >= n) throw new Kv3Error('unterminated string', i);
    i++;
    return s;
  };
  const bare = (): string => {
    const s = i;
    while (i < n && /[A-Za-z0-9_.+\-:$#@|]/.test(text[i] as string)) i++;
    if (i === s) throw new Kv3Error(`unexpected '${text[i] ?? 'end'}'`, i);
    return text.slice(s, i);
  };
  const value = (): Kv3 => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o: { [key: string]: Kv3 } = {};
      for (;;) {
        ws();
        if (text[i] === '}') {
          i++;
          return o;
        }
        const k = text[i] === '"' ? str() : bare();
        ws();
        if (text[i] !== '=') throw new Kv3Error(`expected = after ${k}`, i);
        i++;
        o[k] = value();
        ws();
        if (text[i] === ',') i++;
      }
    }
    if (c === '[') {
      i++;
      const a: Kv3[] = [];
      for (;;) {
        ws();
        if (text[i] === ']') {
          i++;
          return a;
        }
        a.push(value());
        ws();
        if (text[i] === ',') i++;
      }
    }
    if (c === '"') return str();
    const word = bare();
    // A resource reference: prefix:"value".
    if (word.endsWith(':') && text[i] === '"') return str();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    const num = Number(word);
    if (word.length > 0 && Number.isFinite(num) && /^[-+]?[0-9.]/.test(word)) return num;
    return word;
  };
  const v = value();
  ws();
  if (i < n) throw new Kv3Error('trailing data', i);
  return v;
}
