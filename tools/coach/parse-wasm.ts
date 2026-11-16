/**
 * The browser parser's WebAssembly, run in Node: a demo file → `RawDemo`, through exactly the code the worker runs
 * (`src/coach-parser/session.ts`, `convert.ts` and `pkg/coach_parser_bg.wasm`). Used by the conformance test and
 * for quick checks:
 *   npx tsx tools/coach/parse-wasm.ts <demo> [--json]
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawDemo } from '../../src/coach/model/raw';
import { initSync } from '../../src/coach-parser/pkg/coach_parser.js';
import * as wasm from '../../src/coach-parser/pkg/coach_parser.js';
import type { ParseStats } from '../../src/coach-parser/protocol';
import { runSession } from '../../src/coach-parser/session';

let ready = false;
function load(): void {
  if (ready) return;
  initSync({ module: readFileSync(fileURLToPath(new URL('../../src/coach-parser/pkg/coach_parser_bg.wasm', import.meta.url))) });
  ready = true;
}

function* fileChunks(path: string, chunkBytes = 8 << 20): Generator<Uint8Array> {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = new Uint8Array(chunkBytes);
    for (let off = 0; off < size;) {
      const n = readSync(fd, buf, 0, Math.min(chunkBytes, size - off), off);
      if (n <= 0) break;
      yield buf.subarray(0, n);
      off += n;
    }
  } finally {
    closeSync(fd);
  }
}

/** Parse a demo file with the WebAssembly parser. A fresh module instance per call is not needed: the Session frees its memory (the wasm memory itself stays at its high-water mark). */
export async function parseDemoWasm(path: string, onProgress?: (stage: string, f: number) => void): Promise<{ raw: RawDemo; stats: ParseStats }> {
  load();
  const size = fstatSync(openSync(path, 'r')).size;
  return runSession(wasm, size, fileChunks(path), basename(path), () => performance.now(), onProgress);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: tsx tools/coach/parse-wasm.ts <demo> [--json]');
    process.exit(2);
  }
  const { raw, stats } = await parseDemoWasm(path);
  const ev = Object.fromEntries(Object.entries(raw.events).map(([k, v]) => [k, (v as unknown[]).length]));
  const out = {
    header: { ...raw.header, server: raw.header.server === '' ? '' : '(set)' },
    players: raw.players.length, ticks: raw.ticks.count, weapons: raw.names.weapons, places: raw.names.places.length,
    events: ev, projectiles: raw.projectiles.length, inventories: raw.inventories.length, scoreboard: raw.scoreboard.rows.length,
    stats: { ...stats, rssMb: Math.round(process.memoryUsage().rss / 1048576), wasmMb: Math.round(stats.wasmMemoryBytes / 1048576) },
  };
  console.log(process.argv.includes('--json') ? JSON.stringify(out) : out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
