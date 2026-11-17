/**
 * The browser parser (WebAssembly, the worker's code path) against the native Node adapter on the public test demo,
 * column by column and event by event (tools/coach/raw-compare.ts states the tolerance). Skipped when the demo is
 * absent (`npm run coach:fetch-test-demo` puts it in local/demos/, or set COACH_TEST_DEMO). The native result is
 * cached in local/coach-cache/ after the first run.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectContainer } from '../../src/coach-parser/container';
import { nativeRaw, TEST_DEMO } from '../../tools/coach/parser-conformance';
import { parseDemoWasm } from '../../tools/coach/parse-wasm';
import { compareRawDemos } from '../../tools/coach/raw-compare';

describe('coach parser containers', () => {
  it('detects demos and compressed containers by magic bytes', () => {
    const b = (...x: number[]): Uint8Array => new Uint8Array(x);
    expect(detectContainer(new TextEncoder().encode('PBDEMS2\0xyz'))).toBe('dem');
    expect(detectContainer(b(0x42, 0x5a, 0x68, 0x39))).toBe('bz2');
    expect(detectContainer(b(0x28, 0xb5, 0x2f, 0xfd, 0))).toBe('zst');
    expect(detectContainer(b(0x1f, 0x8b, 8, 0))).toBe('gz');
    expect(detectContainer(b(1, 2, 3, 4))).toBe('unknown');
  });
});

describe.skipIf(!existsSync(TEST_DEMO))('coach parser conformance (test demo)', () => {
  it('the WebAssembly parser equals the native adapter', async () => {
    const native = nativeRaw(TEST_DEMO);
    const { raw } = await parseDemoWasm(TEST_DEMO);
    const r = compareRawDemos(raw, native);
    expect(r.diffs).toEqual([]);
    expect(raw.ticks.count).toBeGreaterThan(50000);
    expect(raw.events.bullets.length).toBeGreaterThan(1000);
    // the accepted velocity NaN cells stay rare (659 of 566,250 per column on this demo)
    for (const v of Object.values(r.nanAccepted)) expect(v).toBeLessThan(raw.ticks.count * raw.players.length * 0.005);
  }, 180_000);
});
