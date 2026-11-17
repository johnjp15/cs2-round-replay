/**
 * The browser parser: `parseDemo(file, onProgress) → RawDemo`, in a Web Worker running demoparser2's Rust core as
 * WebAssembly (`crates/coach-parser`). Reads `.dem`, `.dem.bz2`, `.dem.zst` and `.dem.gz` (detected by magic bytes).
 * Nothing leaves the machine. See docs/coach/parser.md.
 */
import type { RawDemo } from '../coach/model/raw';
import type { ParseRequest, ParseStats, WorkerMessage } from './protocol';

export type { ParseStats } from './protocol';
export type ProgressFn = (stage: string, fraction: number) => void;

/**
 * Parse a demo in a fresh worker; resolves with the RawDemo (typed arrays transferred, not copied). A Uint8Array input
 * is transferred to the worker too, so it is detached (unusable) afterwards.
 */
export function parseDemoWithStats(input: File | Blob | Uint8Array, onProgress?: ProgressFn): Promise<{ raw: RawDemo; stats: ParseStats }> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerMessage>): void => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.stage, m.fraction);
      else {
        worker.terminate();
        if (m.type === 'done') resolve({ raw: m.raw, stats: m.stats });
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e): void => { worker.terminate(); reject(new Error(e.message || 'parser worker failed')); };
    const fileName = typeof File !== 'undefined' && input instanceof File ? input.name : '';
    const req: ParseRequest = { type: 'parse', input, fileName };
    worker.postMessage(req, input instanceof Uint8Array ? [input.buffer as ArrayBuffer] : []);
  });
}

/** Parse a demo file (or its bytes) into a `RawDemo` in a Web Worker. */
export async function parseDemo(input: File | Blob | Uint8Array, onProgress?: ProgressFn): Promise<RawDemo> {
  return (await parseDemoWithStats(input, onProgress)).raw;
}
