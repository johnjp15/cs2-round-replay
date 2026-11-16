/**
 * The whole public test demo through the native parser. Skips when the demo is absent (CI): fetch it with
 * `npm run coach:fetch-test-demo`. Takes ~10 s and ~550 MB.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ingestMatch, reconcile } from '../../src/coach/ingest/index';
import { TEST_DEMO_PATH } from '../../tools/coach/fetch-test-demo';

const have = existsSync(TEST_DEMO_PATH);

describe.skipIf(!have)('coach full demo (local/demos/test_demo.dem)', () => {
  it('parses, ingests and reconciles', async () => {
    const { parseDemoNode } = await import('../../tools/coach/parse-node');
    const { raw, stats } = parseDemoNode(TEST_DEMO_PATH);
    expect(raw.players.length).toBe(10);
    expect(raw.ticks.count).toBe(56625);
    expect(raw.ticks.tick[0]).toBe(67);
    expect(raw.ticks.tick[raw.ticks.count - 1]).toBe(56705);
    expect(stats.peakRssMb).toBeLessThan(2048);
    const m = ingestMatch(raw);
    expect(m.meta.score).toEqual({ A: 8, B: 2 });
    expect(reconcile(raw, m).ok).toBe(true);
  }, 120_000);
});
