/**
 * Drives one WebAssembly parse: streams the file into the module chunk by chunk, parses, converts to `RawDemo`.
 * Shared by the worker (browser) and `tools/coach/parse-wasm.ts` (Node). No DOM, no clock of its own: the caller
 * passes `now` for the stage timings.
 */
import type { RawDemo } from '../coach/model/raw';
import { toRawDemo } from './convert';
import type { ParseStats } from './protocol';
import type { WasmRaw } from './wasm-types';

/** The parts of the wasm-bindgen module this file uses. */
export interface CoachParserModule {
  Session: new (size: number) => { push(chunk: Uint8Array): void; parse(progress: (stage: string, f: number) => void): unknown; free(): void };
  wasmMemoryBytes(): number;
}

/** Overall progress: reading 0–8 %, parsing 8–96 % (by the module's own stage fractions), converting the rest. */
const READ_SHARE = 0.08;
const CONVERT_AT = 0.96;

export async function runSession(
  mod: CoachParserModule,
  size: number,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  fileName: string,
  now: () => number,
  onProgress?: (stage: string, fraction: number) => void,
): Promise<{ raw: RawDemo; stats: ParseStats }> {
  const stages: Record<string, number> = {};
  const t0 = now();
  let stage = 'read';
  let stageT = t0;
  const mark = (next: string): void => {
    const t = now();
    stages[stage] = (stages[stage] ?? 0) + (t - stageT);
    stage = next;
    stageT = t;
  };
  const s = new mod.Session(size);
  try {
    let read = 0;
    for await (const c of chunks) {
      s.push(c);
      read += c.length;
      onProgress?.('read', (READ_SHARE * read) / Math.max(1, size));
    }
    const w = s.parse((st, f) => {
      mark(st === 'done' ? 'convert' : st);
      onProgress?.(st === 'done' ? 'convert' : st, READ_SHARE + (CONVERT_AT - READ_SHARE) * f);
    }) as WasmRaw;
    const raw = toRawDemo(w, { fileName });
    mark('end');
    onProgress?.('done', 1);
    return {
      raw,
      stats: {
        stages, totalMs: now() - t0, wasmMemoryBytes: mod.wasmMemoryBytes(), container: w.container,
        fileBytes: w.fileBytes, demoBytes: w.demoBytes,
      },
    };
  } finally {
    s.free();
  }
}

/** Chunks of a Blob/File, read one at a time (the whole file is never in JS memory). */
export async function* blobChunks(b: Blob, chunkBytes = 8 << 20): AsyncGenerator<Uint8Array> {
  for (let off = 0; off < b.size; off += chunkBytes) {
    yield new Uint8Array(await b.slice(off, Math.min(b.size, off + chunkBytes)).arrayBuffer());
  }
}
