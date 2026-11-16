/**
 * The committed fixture (tests/coach/fixtures/test-demo-r4.craw.gz, made by tools/coach/make-fixture.ts from the
 * public test demo, names and Steam IDs replaced): every event plus the tick rows ingest reads, round 4 in full.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';
import { ingestMatch, reconcile } from '../../src/coach/ingest/index';

const raw = decodeRawDemo(gunzipSync(readFileSync(new URL('./fixtures/test-demo-r4.craw.gz', import.meta.url))));

describe('coach fixture: the public test demo', () => {
  const m = ingestMatch(raw);

  it('is anonymized', () => {
    expect(raw.players.map((p) => p.name).sort()).toEqual(['CT1', 'CT2', 'CT3', 'CT4', 'CT5', 'T1', 'T2', 'T3', 'T4', 'T5']);
    expect(raw.players.every((p) => p.steamId.startsWith('765611990000'))).toBe(true);
  });

  it('has ten rounds ending 8–2 with the last one surrendered in freeze time', () => {
    expect(m.meta.map).toBe('de_mirage');
    expect(m.rounds.length).toBe(10);
    expect(m.meta.score).toEqual({ A: 8, B: 2 });
    expect(m.meta.gameScore).toEqual({ A: 8, B: 2 });
    expect(m.meta.surrendered).toBe('B');
    const last = m.rounds[9]!;
    expect(last).toMatchObject({ number: 10, played: false, freezeEndTick: null, officialEndTick: null, reasonName: 'ct_surrender', winner: 'A' });
    expect(m.rounds.filter((r) => r.played).length).toBe(9);
    expect(m.rounds.map((r) => r.winnerSide).join(' ')).toBe('T CT T T CT T T T T T');
    expect(m.rounds.map((r) => r.reasonName)).toEqual([
      'ct_killed', 'bomb_defused', 'ct_killed', 'ct_killed', 't_killed', 'bomb_exploded', 'ct_killed', 'bomb_exploded', 'ct_killed', 'ct_surrender',
    ]);
    expect(m.rounds.map((r) => r.startTick)).toEqual([67, 9419, 15680, 21905, 26512, 31645, 39268, 45540, 52166, 56407]);
    expect(m.rounds[1]?.bomb.defuseTick).toBe(15232);
  });

  it('keeps the rank updates and the player who left', () => {
    expect(raw.events.ranks.length).toBe(10);
    expect(raw.events.ranks.every((r) => r.tick === 56766 && r.rankType === 11 && r.p >= 0)).toBe(true);
    expect(m.meta.notes.some((n) => /slot \d left after round 9/.test(n))).toBe(true);
  });

  it('reconciles the scoreboard for all ten players (enemies flashed is approximate)', () => {
    const rec = reconcile(raw, m);
    expect(rec.rows.length).toBe(10);
    expect(rec.ok).toBe(true);
    expect(rec.flashMismatches).toBeLessThanOrEqual(3);
  });

  it('is deterministic: the same RawDemo gives identical Match JSON', () => {
    expect(JSON.stringify(ingestMatch(raw))).toBe(JSON.stringify(m));
  });
});
