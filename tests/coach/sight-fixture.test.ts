/** K6 on the committed fixture (round 4's full tick grid) with the Mirage pack: the sight tables and analyze(). */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createContext } from '../../src/coach/analyze/context';
import { analyze, reportJson } from '../../src/coach/analyze/index';
import { LosWorld } from '../../src/coach/derive/los';
import { DEATH_CONTEXT, DUELS, FIRSTS, SIGHTINGS } from '../../src/coach/derive/sight/index';
import { ingestMatch } from '../../src/coach/ingest/index';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';

describe('K6 on the test demo fixture with the Mirage pack', () => {
  const raw = decodeRawDemo(gunzipSync(readFileSync(new URL('./fixtures/test-demo-r4.craw.gz', import.meta.url))));
  const match = ingestMatch(raw);
  const los = LosWorld.fromBytes(new Uint8Array(gunzipSync(readFileSync(new URL('../../data/coach/maps/de_mirage/los.bin.gz', import.meta.url)))));
  const r4 = match.rounds.find((r) => r.number === 4);

  it('every clean gun kill of round 4 ends a duel the killer won, after he saw the victim', () => {
    const ctx = createContext(raw, match, { los });
    const tab = ctx.table(SIGHTINGS);
    expect(tab.available).toBe(true);
    expect(tab.sightings.filter((s) => s.round === 4).length).toBeGreaterThan(10);
    const duels = ctx.table(DUELS).duels.filter((d) => d.round === 4);
    const kills = raw.events.kills.filter((k) => r4 && k.tick > (r4.freezeEndTick ?? 0) && k.tick <= r4.endTick && k.attacker >= 0 && !k.thruSmoke && k.penetrated === 0 && !['hegrenade', 'inferno', 'molotov', 'world'].includes(k.weapon) && match.players[k.attacker]?.team !== match.players[k.victim]?.team);
    expect(kills.length).toBeGreaterThan(3);
    for (const k of kills) {
      const d = duels.find((x) => x.killTick === k.tick && x.winner === k.attacker);
      expect(d, `kill at ${k.tick}`).toBeDefined();
      const me = d?.a.p === k.attacker ? d.a : d?.b;
      expect(me?.sightTick ?? Infinity).toBeLessThanOrEqual(k.tick);
    }
    const firsts = ctx.table(FIRSTS).bySlot.flat().filter((f) => f.round === 4);
    expect(firsts.length).toBeGreaterThan(5);
    for (const f of firsts) {
      expect(f.angle).toBeGreaterThanOrEqual(0);
      expect(f.angle).toBeLessThan(80);
    }
    expect(ctx.table(DEATH_CONTEXT).rows.filter((d) => d.death.round === 4).length).toBeGreaterThan(0);
  });

  it('analyze() with the pack is deterministic and carries the placement chart', () => {
    const user = match.players.find((p) => p.name === 'T4')?.slot ?? 3;
    const a = analyze(raw, match, { user, los });
    expect(reportJson(analyze(raw, match, { user, los }))).toBe(reportJson(a));
    expect(a.metrics.find((m) => m.id === 'aim.placement.angle_deg')).toBeDefined();
    expect(a.charts?.['aim.placement']?.kind).toBe('scatter');
  });
});
