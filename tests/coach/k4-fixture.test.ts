/**
 * K4 on the committed fixture (the public test demo, anonymized; every event, round 4's ticks in full): utility damage
 * reconciles with the demo's scoreboard exactly, enemies flashed approximately; the tables and detectors run through
 * `analyze()` for every player and are deterministic.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyze, createContext, reportJson } from '../../src/coach/analyze/index';
import { DEATHS } from '../../src/coach/derive/positioning/deaths';
import { TRADES } from '../../src/coach/derive/positioning/trades';
import { THROWS } from '../../src/coach/derive/utility/throws';
import { ingestMatch } from '../../src/coach/ingest/index';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';

const raw = decodeRawDemo(gunzipSync(readFileSync(new URL('./fixtures/test-demo-r4.craw.gz', import.meta.url))));
const match = ingestMatch(raw);
const K4 = /^(util|pos(?!\.death_context)|trade|eco)\./; // pos.death_context is K6

describe('K4 on the test demo fixture', () => {
  const ctx = createContext(raw, match);
  const throws = ctx.table(THROWS);

  it('joins every live grenade and reconciles utility damage exactly', () => {
    expect(throws.length).toBe(150);
    expect(throws.filter((t) => t.detTick === null).map((t) => t.type)).toEqual(['fire', 'fire', 'fire']);
    expect(throws.filter((t) => t.throwTick === null).length).toBe(0);
    for (const row of raw.scoreboard.rows) {
      const ours = throws.filter((t) => t.thrower === row.p).reduce((s, t) => s + t.enemyDamage, 0);
      expect(ours, `slot ${row.p}`).toBe(row.utilityDamage);
    }
  });

  it('approximates enemies flashed within one per player, on three players', () => {
    let differ = 0;
    for (const row of raw.scoreboard.rows) {
      const ours = throws.filter((t) => t.thrower === row.p).reduce((s, t) => s + t.enemiesBlinded, 0);
      expect(Math.abs(ours - row.enemiesFlashed)).toBeLessThanOrEqual(1);
      if (ours !== row.enemiesFlashed) differ++;
    }
    expect(differ).toBe(3);
  });

  it('finds the trades of round 4', () => {
    const r4 = ctx.table(TRADES).filter((t) => t.round === 4);
    const deaths = ctx.table(DEATHS).filter((d) => d.round === 4);
    expect(r4.length).toBe(deaths.length);
    expect(deaths.filter((d) => d.firstDeath).length).toBe(1);
    for (const t of r4.filter((x) => x.isTrade)) {
      for (const k of t.trades) {
        const d = raw.events.kills[k];
        expect(d?.attacker).toBe(t.victim);
        expect(t.tick - (d?.tick ?? 0)).toBeLessThanOrEqual(320);
      }
    }
  });

  it('runs every K4 detector through analyze() for each player, deterministically', () => {
    for (const user of [0, 4, 6]) {
      const rep = analyze(raw, match, { user });
      const mine = rep.findings.filter((f) => K4.test(f.id));
      for (const f of mine) {
        expect(f.evidence.length).toBeGreaterThan(0);
        for (const e of f.evidence) {
          const r = match.rounds.find((x) => x.number === e.round);
          expect(r).toBeDefined();
          expect(e.focus).toBeGreaterThanOrEqual((r?.startTick ?? 0) - 1);
          expect(e.focus).toBeLessThanOrEqual(r?.endTick ?? 0);
        }
      }
      expect(rep.metrics.filter((m) => K4.test(m.id)).length).toBe(19);
      expect(reportJson(analyze(raw, match, { user }))).toBe(reportJson(rep));
    }
  });
});
