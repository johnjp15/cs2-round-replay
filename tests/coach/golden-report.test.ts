/**
 * K5: golden report. The report JSON of the committed, anonymized fixture (the public test demo: every event, round 4's
 * ticks) for one user slot, with the Mirage sight mesh, must equal tests/coach/golden/report-fixture-B2.json byte for
 * byte, and two runs must be identical (determinism). A change to the analysis that moves it must be intended:
 *
 *   npm run golden:coach        # rewrites the snapshot (UPDATE_GOLDEN=1)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyze, reportJson } from '../../src/coach/analyze/index';
import { LosWorld } from '../../src/coach/derive/los';
import { ingestMatch } from '../../src/coach/ingest/index';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';

const SLOT = 6; // B2: a fix of every scope and both a duel and a spray evidence on the full demo
const GOLDEN = new URL('./golden/report-fixture-B2.json', import.meta.url);

function run(): string {
  const raw = decodeRawDemo(gunzipSync(readFileSync(new URL('./fixtures/test-demo-r4.craw.gz', import.meta.url))));
  const match = ingestMatch(raw);
  const los = LosWorld.fromBytes(new Uint8Array(gunzipSync(readFileSync(new URL(`../../data/coach/maps/${match.meta.map}/los.bin.gz`, import.meta.url)))));
  return `${reportJson(analyze(raw, match, { user: SLOT, los }), 1)}\n`;
}

describe('golden report (fixture, B2)', () => {
  const a = run();
  it('is deterministic', () => {
    expect(run()).toBe(a);
  });
  it('equals the snapshot', () => {
    if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, a);
    const want = readFileSync(GOLDEN, 'utf8');
    if (want !== a) {
      // Point at the first difference rather than dumping two large strings.
      let i = 0;
      while (i < a.length && a[i] === want[i]) i++;
      expect(a.slice(Math.max(0, i - 200), i + 200)).toBe(want.slice(Math.max(0, i - 200), i + 200));
    }
    expect(a.length).toBe(want.length);
  });
  it('has no real names', () => {
    const rep = JSON.parse(a) as { match: { players: { name: string }[] } };
    for (const p of rep.match.players) expect(p.name).toMatch(/^(T|CT)\d$/);
  });
});
