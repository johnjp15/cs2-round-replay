/**
 * Conformance of the browser parser: the WebAssembly parser (tools/coach/parse-wasm.ts, the worker's code) against
 * the native Node adapter (tools/coach/parse-node.ts) on one demo, column by column and event by event.
 *   npx tsx tools/coach/parser-conformance.ts [demo] [--fresh]
 * The native result is cached in local/coach-cache/<sha256>.craw (as `npm run coach -- parse` writes it); --fresh
 * re-parses. With --containers, the same demo as .bz2/.zst/.gz next to it (when present) is parsed too and must
 * give the same RawDemo (header sha256/bytes aside). Exit code 1 on any difference.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRawDemo, encodeRawDemo } from '../../src/coach/model/raw-codec';
import type { RawDemo } from '../../src/coach/model/raw';
import { parseDemoNode } from './parse-node';
import { parseDemoWasm } from './parse-wasm';
import { compareRawDemos } from './raw-compare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The test demo: COACH_TEST_DEMO, else local/demos/test_demo.dem. */
export const TEST_DEMO = process.env['COACH_TEST_DEMO'] ?? resolve(ROOT, 'local/demos/test_demo.dem');

export function nativeRaw(demo: string, fresh = false): RawDemo {
  const sha = createHash('sha256').update(readFileSync(demo)).digest('hex');
  const cache = resolve(ROOT, 'local/coach-cache', `${sha}.craw`);
  if (!fresh && existsSync(cache)) return decodeRawDemo(readFileSync(cache));
  const { raw } = parseDemoNode(demo);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, encodeRawDemo(raw));
  return raw;
}

async function main(): Promise<void> {
  const demo = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? TEST_DEMO;
  const fresh = process.argv.includes('--fresh');
  const t0 = performance.now();
  const native = nativeRaw(demo, fresh);
  const t1 = performance.now();
  const { raw, stats } = await parseDemoWasm(demo);
  const t2 = performance.now();
  const r = compareRawDemos(raw, native);
  console.log(`native ${((t1 - t0) / 1000).toFixed(1)} s${fresh ? '' : ' (cache if present)'} · wasm ${((t2 - t1) / 1000).toFixed(1)} s, wasm memory ${(stats.wasmMemoryBytes / 1048576).toFixed(0)} MB`);
  console.log(`checked ${r.checked.cells} cells in ${raw.ticks.count} ticks × ${raw.players.length} players, ${r.checked.events} events`);
  console.log('max float diff per column:', JSON.stringify(r.maxFloatDiff));
  console.log('NaN on one side only (accepted, velocity):', JSON.stringify(r.nanAccepted));
  if (r.diffs.length === 0) {
    console.log('IDENTICAL within tolerance');
    if (process.argv.includes('--containers')) await containers(demo, native);
    return;
  }
  console.log('column mismatches:', JSON.stringify(r.columnMismatches));
  for (const d of r.diffs) console.log('  ' + d);
  process.exitCode = 1;
}

async function containers(demo: string, native: RawDemo): Promise<void> {
  for (const ext of ['bz2', 'zst', 'gz']) {
    const path = `${demo}.${ext}`;
    if (!existsSync(path)) { console.log(`${ext}: (no ${path})`); continue; }
    const { raw, stats } = await parseDemoWasm(path);
    raw.header.demoSha256 = native.header.demoSha256;
    raw.header.bytes = native.header.bytes;
    raw.header.source = native.header.source; // guessed from the file name (.zst → faceit)
    const r = compareRawDemos(raw, native);
    const st = Object.entries(stats.stages).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', ');
    console.log(`${ext}: ${stats.fileBytes} bytes → ${stats.demoBytes}; ${(stats.totalMs / 1000).toFixed(1)} s (${st}); wasm memory ${(stats.wasmMemoryBytes / 1048576).toFixed(0)} MB; ${r.diffs.length === 0 ? 'IDENTICAL' : r.diffs.slice(0, 5).join(' | ')}`);
    if (r.diffs.length > 0) process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
