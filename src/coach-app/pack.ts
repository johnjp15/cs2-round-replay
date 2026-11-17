/**
 * Storage codec for the library: an object with typed arrays anywhere inside → JSON + the arrays' bytes, gzipped
 * with CompressionStream. A full match's report and replay (about 4 MB in memory) store in about 1 MB and unpack in
 * a few tens of milliseconds.
 */
type Typed = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
const CTORS = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array } as const;
type CtorName = keyof typeof CTORS;
interface Ref { $t: CtorName; o: number; n: number }

const pad8 = (n: number): number => (n + 7) & ~7;

export function packBytes(value: unknown): Uint8Array {
  const bufs: Typed[] = [];
  let area = 0;
  const json = JSON.stringify(value, (_k, v: unknown) => {
    if (!ArrayBuffer.isView(v) || v instanceof DataView) return v;
    const name = v.constructor.name as CtorName;
    if (!(name in CTORS)) return v;
    const a = v as Typed;
    const ref: Ref = { $t: name, o: area, n: a.length };
    bufs.push(a);
    area += pad8(a.byteLength);
    return ref;
  });
  const head = new TextEncoder().encode(json);
  const start = pad8(4 + head.length);
  const out = new Uint8Array(start + area);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let off = start;
  for (const b of bufs) {
    out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
    off += pad8(b.byteLength);
  }
  return out;
}

export function unpackBytes<T>(bytes: Uint8Array): T {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const json = new TextDecoder().decode(bytes.subarray(4, 4 + len));
  const start = pad8(4 + len);
  const area = bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return JSON.parse(json, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && '$t' in v && 'o' in v && 'n' in v) {
      const r = v as Ref;
      return new CTORS[r.$t](area, r.o, r.n);
    }
    return v;
  }) as T;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

export async function packGzip(value: unknown): Promise<Uint8Array> {
  return through(packBytes(value), new CompressionStream('gzip'));
}

export async function unpackGzip<T>(bytes: Uint8Array): Promise<T> {
  return unpackBytes<T>(await through(bytes, new DecompressionStream('gzip')));
}

/** gunzip a Blob (a .craw.gz or any gzip). */
export async function gunzipBlob(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
