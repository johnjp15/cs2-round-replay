/** Messages between `index.ts` (page) and `worker.ts`. */
import type { RawDemo } from '../coach/model/raw';

export interface ParseRequest {
  type: 'parse';
  /** A File/Blob is read in chunks inside the worker; a Uint8Array is transferred. */
  input: Blob | Uint8Array;
  fileName: string;
  /** URL of coach_parser_bg.wasm; omitted = next to the worker (the bundler resolves it). */
  wasmUrl?: string;
}

/** Where the time and memory went, for the bench and the progress UI. */
export interface ParseStats {
  /** Milliseconds per stage (read, decompress, events, ticks, columns, inventories, projectiles, convert). */
  stages: Record<string, number>;
  totalMs: number;
  /** WebAssembly memory at the end (= its high-water mark: wasm memory never shrinks), bytes. */
  wasmMemoryBytes: number;
  container: string;
  fileBytes: number;
  demoBytes: number;
}

export type WorkerMessage =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'done'; raw: RawDemo; stats: ParseStats }
  | { type: 'error'; message: string };
