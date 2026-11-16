/**
 * One binary container for a `RawDemo`: the on-disk cache (`local/coach-cache/`), committed fixtures (gzipped) and,
 * later, the worker → page transfer.
 *
 * Layout (little-endian):
 *   0  "CRAW" magic (4 bytes)
 *   4  Uint32 container version (1)
 *   8  Uint32 byte length J of the JSON header
 *  12  J bytes of UTF-8 JSON: the RawDemo with every typed array replaced by { "$buf": k }, plus a "$bufs" list of
 *      { type, offset, length } (offset from the start of the buffer area, length in elements)
 *      zero padding to a multiple of 8
 *      the buffer area: each typed array's bytes, each starting on a multiple of 8
 *
 * Deterministic: the same RawDemo gives the same bytes.
 */
import type { RawDemo } from './raw';

const MAGIC = 0x57415243; // "CRAW" read as little-endian Uint32
const VERSION = 1;

type Typed = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
const CTORS = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array } as const;
type CtorName = keyof typeof CTORS;

interface BufRef { type: CtorName; offset: number; length: number }

function typedName(v: unknown): CtorName | null {
  if (!ArrayBuffer.isView(v) || v instanceof DataView) return null;
  const n = v.constructor.name;
  return n in CTORS ? (n as CtorName) : null;
}

const pad8 = (n: number): number => (n + 7) & ~7;

export function encodeRawDemo(raw: RawDemo): Uint8Array {
  const bufs: Typed[] = [];
  const refs: BufRef[] = [];
  let area = 0;
  const json = JSON.stringify(raw, (_k, v: unknown) => {
    const type = typedName(v);
    if (type === null) return v;
    const arr = v as Typed;
    refs.push({ type, offset: area, length: arr.length });
    bufs.push(arr);
    area += pad8(arr.byteLength);
    return { $buf: refs.length - 1 };
  });
  // Append the buffer table as a last key (the header object is a copy, so no mutation of raw).
  const header = new TextEncoder().encode(`${json.slice(0, -1)},"$bufs":${JSON.stringify(refs)}}`);
  const start = pad8(12 + header.length);
  const out = new Uint8Array(start + area);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, header.length, true);
  out.set(header, 12);
  bufs.forEach((b, k) => {
    const ref = refs[k];
    if (ref) out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), start + ref.offset);
  });
  return out;
}

export function decodeRawDemo(bytes: Uint8Array): RawDemo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a coach RawDemo container');
  const version = dv.getUint32(4, true);
  if (version !== VERSION) throw new Error(`unsupported RawDemo container version ${version}`);
  const len = dv.getUint32(8, true);
  const text = new TextDecoder().decode(bytes.subarray(12, 12 + len));
  const start = pad8(12 + len);
  const parsed = JSON.parse(text) as { $bufs: BufRef[] };
  const refs = parsed.$bufs;
  // Copy the buffer area once into an aligned ArrayBuffer so typed views need no per-array copy.
  const area = new ArrayBuffer(bytes.byteLength - start);
  new Uint8Array(area).set(bytes.subarray(start));
  const revive = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(revive);
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const k = o['$buf'];
      if (typeof k === 'number' && Object.keys(o).length === 1) {
        const ref = refs[k];
        if (!ref) throw new Error(`bad buffer ref ${k}`);
        return new CTORS[ref.type](area, ref.offset, ref.length);
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(o)) if (key !== '$bufs') out[key] = revive(o[key]);
      return out;
    }
    return v;
  };
  return revive(parsed) as RawDemo;
}
