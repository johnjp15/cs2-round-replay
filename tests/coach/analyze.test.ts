/** K2: the analysis framework (Contract 3): context memoization, lobby ranks, the first prioritizer, determinism. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyze, createContext, family, lobbyRanks, prioritize, reportJson } from '../../src/coach/analyze/index';
import type { TableDef } from '../../src/coach/analyze/context';
import { makeFinding, pickClearest } from '../../src/coach/detect/common';
import type { Detector } from '../../src/coach/detect/types';
import { ingestMatch } from '../../src/coach/ingest/index';
import type { MetricDef } from '../../src/coach/metrics/types';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';
import type { Evidence, Finding } from '../../src/coach/model/report';
import { deg, grouped, ms, pct, playerLabel, rankOf, roundClock, times } from '../../src/coach/report/format';
import { fourPlayers, roundsFrom, synthDemo } from './synth';

const ev: Evidence = { kind: 'replay', round: 1, tick0: 0, tick1: 10, focus: 5, players: [0], annotations: [], caption: 'x' };

function finding(id: string, polarity: Finding['polarity'], impact: number, confidence: number, evidence: Evidence[] = [ev]): Finding {
  return makeFinding({
    id, area: 'aim', scope: 'mechanics', polarity, title: id, summary: id, why: '', advice: [], metrics: [], evidence,
    instances: 1, opportunities: 1, rounds: [1], confidence, impact,
  });
}

describe('analysis framework', () => {
  const raw = synthDemo({ ...fourPlayers(), matchStart: 100, rounds: roundsFrom(100, 2) });
  const match = ingestMatch(raw);

  it('memoizes tables and maps item names to weapons', () => {
    const ctx = createContext(raw, match);
    let builds = 0;
    const def: TableDef<number> = { id: 'test.t', build: () => ++builds };
    expect(ctx.table(def)).toBe(1);
    expect(ctx.table(def)).toBe(1);
    expect(ctx.weapon('ak47')?.id).toBe('ak47');
    expect(ctx.weapon('m4a1')?.id).toBe('m4a4');
    expect(ctx.weapon('m4a1_silencer')?.id).toBe('m4a1s');
    expect(ctx.weapon('galilar')?.id).toBe('galil');
    expect(ctx.weapon('')).toBeNull();
    const loop: TableDef<number> = { id: 'test.loop', build: (c) => c.table(loop) };
    expect(() => ctx.table(loop)).toThrow(/depends on itself/);
  });

  it('ranks with ties sharing a rank, in the direction of `better`', () => {
    expect(lobbyRanks([0.5, 0.2, 0.5, NaN, 0.1], 'higher')).toEqual([1, 3, 1, 0, 4]);
    expect(lobbyRanks([0.5, 0.2, 0.5, NaN, 0.1], 'lower')).toEqual([3, 2, 3, 0, 1]);
  });

  it('computes metrics for every slot and runs detectors for the user', () => {
    const m: MetricDef = { id: 'aim.test.slot', label: 'slot', unit: 'count', better: 'lower', area: 'aim', compute: (_c, p) => (p === 3 ? null : { value: p, n: 10 }) };
    let ranFor = -1;
    const d: Detector = {
      id: 'aim.test', area: 'aim', scope: 'mechanics',
      run: (_c, slot, metric) => {
        ranFor = slot;
        const v = metric('aim.test.slot');
        return v ? [finding('aim.test.fix', 'fix', 2, 0.5)] : [];
      },
    };
    const needsLos: Detector = { id: 'aim.los', area: 'aim', scope: 'mechanics', needs: ['los'], run: () => [finding('aim.los.x', 'fix', 9, 1)] };
    const rep = analyze(raw, match, { user: 2, metrics: [m], detectors: [d, needsLos] });
    expect(ranFor).toBe(2);
    expect(rep.metrics[0]).toMatchObject({ id: 'aim.test.slot', value: 2, lobbyRank: 3, n: 10 });
    expect(rep.metrics[0]?.lobby.map((x) => (Number.isNaN(x) ? null : x))).toEqual([0, 1, 2, null]);
    expect(rep.findings.map((f) => f.id)).toEqual(['aim.test.fix']);
    expect(rep.topFixes).toEqual(['aim.test.fix']);
    expect(rep.findings[0]?.priority).toBe(1);
    expect(rep.rounds.map((r) => r.number)).toEqual([1, 2]);
    expect(JSON.parse(reportJson(rep)).metrics[0].lobby).toEqual([0, 1, 2, null]);
  });

  it('prioritizer: impact × confidence, top three, one per family, evidence required, two strengths', () => {
    expect(family('aim.spray.vertical')).toBe('aim.spray');
    const fs = [
      finding('aim.spray.vertical', 'fix', 5, 0.9),
      finding('aim.spray.horizontal', 'fix', 4, 0.9),
      finding('aim.counter_strafe.early', 'fix', 3, 0.5),
      finding('move.reload.exposed', 'fix', 2, 0.9),
      finding('move.caught_out.knife', 'fix', 1.6, 0.9),
      finding('aim.first_bullet.noev', 'fix', 50, 1, []),
      finding('aim.range_discipline.s', 'strength', 1, 0.9),
      finding('aim.first_bullet.s', 'strength', 2, 0.9),
      finding('aim.spray.s', 'strength', 0.5, 0.9),
    ];
    const { topFixes, strengths } = prioritize(fs);
    expect(topFixes).toEqual(['aim.spray.vertical', 'move.reload.exposed', 'aim.counter_strafe.early']);
    expect(strengths).toEqual(['aim.first_bullet.s', 'aim.range_discipline.s']);
  });

  it('picks the clearest evidence, one per round first, in time order', () => {
    const items = [{ t: 1, r: 1, s: 5 }, { t: 2, r: 1, s: 9 }, { t: 3, r: 2, s: 1 }, { t: 4, r: 3, s: 7 }];
    expect(pickClearest(items, (x) => x.s, (x) => x.t, (x) => x.r, 2).map((x) => x.t)).toEqual([2, 4]);
    expect(pickClearest(items, (x) => x.s, (x) => x.t, (x) => x.r, 4).map((x) => x.t)).toEqual([1, 2, 3, 4]);
  });

  it('formats numbers and clocks', () => {
    expect(pct(0.412)).toBe('41 %');
    expect(deg(1.83)).toBe('1.8°');
    expect(ms(46.9)).toBe('47 ms');
    expect(times(3.08)).toBe('3.1×');
    expect(grouped(1234567.25, 1)).toBe('1,234,567.3');
    expect(rankOf(2, 10)).toBe('2nd of 10');
    // Round 1 freeze end at 200: 1:55 left; 10.5 s later 1:44.
    expect(roundClock(match, 150)).toBe('round 1, freeze time');
    expect(roundClock(match, 200)).toBe('round 1, 1:55');
    expect(roundClock(match, 200 + 10 * 64 + 32)).toBe('round 1, 1:44');
    expect(playerLabel(match, 0)).toBe('A1');
    expect(playerLabel(match, 3)).toBe('B2');
  });
});

describe('analysis on the committed fixture', () => {
  const raw = decodeRawDemo(gunzipSync(readFileSync(new URL('./fixtures/test-demo-r4.craw.gz', import.meta.url))));
  const match = ingestMatch(raw);

  it('gives a valid, byte-identical report for the same input', () => {
    const a = reportJson(analyze(raw, match, { user: 0 }));
    const b = reportJson(analyze(raw, match, { user: 0 }));
    expect(a).toBe(b);
    const rep = JSON.parse(a);
    expect(rep.format).toBe('coach-report@1');
    expect(rep.rounds.length).toBe(10);
    expect(rep.topFixes.length).toBeLessThanOrEqual(3);
  });
});
