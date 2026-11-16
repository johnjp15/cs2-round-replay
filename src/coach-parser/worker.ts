/**
 * The parser worker: loads the WebAssembly module, reads the dropped file in chunks into it, parses, converts to
 * `RawDemo` and posts it back with every typed array transferred (no copy). One worker per demo: the page terminates
 * it afterwards, which is what returns the WebAssembly memory to the system (wasm memory never shrinks).
 */
import init, * as wasm from './pkg/coach_parser.js';
import { transferables } from './convert';
import type { ParseRequest, WorkerMessage } from './protocol';
import { blobChunks, runSession } from './session';

interface WorkerScope {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<ParseRequest>) => void): void;
}
const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (e) => {
  const req = e.data;
  if (req.type !== 'parse') return;
  void (async (): Promise<void> => {
    try {
      await (req.wasmUrl !== undefined ? init({ module_or_path: req.wasmUrl }) : init());
      const input = req.input;
      const chunks = input instanceof Uint8Array ? [input] : blobChunks(input);
      const size = input instanceof Uint8Array ? input.length : input.size;
      const { raw, stats } = await runSession(wasm, size, chunks, req.fileName, () => performance.now(),
        (stage, fraction) => scope.postMessage({ type: 'progress', stage, fraction }));
      scope.postMessage({ type: 'done', raw, stats }, transferables(raw));
    } catch (err) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();
});
