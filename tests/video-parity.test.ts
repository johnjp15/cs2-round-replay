// V0: the parity comparisons (tools/parity/metrics.ts) on synthetic ground truth: no video needed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTimes, checkKeys, compareEvents, compareFrame, regressions, summarize, watchedAt, type RoundLite, type SimFrame, type Truth, type TruthTime } from '../tools/parity/metrics';

const round = JSON.parse(readFileSync(resolve(__dirname, '../data/round.json'), 'utf8')) as RoundLite;

function pawns(over: Record<string, Partial<SimFrame['pawns'][number]>> = {}): SimFrame['pawns'] {
  return round.players.map((p) => {
    const s = round.tracks[p.id]?.samples[0] as { x: number; y: number };
    return { id: p.id, x: s.x, y: s.y, yaw: 0, hp: 100, armor: 100, alive: true, weapon: 'ak47', clip: 30, reserve: 90, ...over[p.id] };
  });
}

function truthAt(t: number, dots: TruthTime['radar']['dots'], hud: Partial<TruthTime['hud']> = {}): TruthTime {
  const read = (value: string | null) => ({ value, score: 0.95 });
  return {
    t, frame: Math.round(t * 60), frameT: Math.round(t * 60) / 60, layout: t < 12.75 ? 'pov' : 'spectator', radar: { kind: 'spectator', dots },
    hud: { hp: read('100'), armor: read('100'), clip: read('30'), reserve: read('90'), clock: { ...read('1:38'), bombIcon: false }, ...hud },
  };
}

describe('video parity metrics', () => {
  it('builds the timestamps: the grid plus every kill, the plant, the defuse and the timed shots', () => {
    const t = buildTimes('every 0.5', round, true);
    expect(t[0]).toBe(0);
    expect(t).toContain(70);
    for (const k of round.kills) expect(t).toContain(k.t);
    expect(t).toContain(round.bomb.plantT);
    expect(t).toContain(18.517);
    expect(new Set(t).size).toBe(t.length);
    expect(buildTimes('1, 2.5', round, false)).toEqual([1, 2.5]);
  });

  it('follows the camera schedule', () => {
    expect(watchedAt(round, 5)).toBe('eradicate');
    expect(watchedAt(round, 13.0)).toBeNull(); // death cam
    expect(watchedAt(round, 20)).toBe('cart');
    expect(watchedAt(round, 50.2)).toBe('donk');
    expect(watchedAt(round, 75)).toBeNull(); // next round
  });

  it('passes a dot within 40 u and fails one beyond, and compares the HUD exactly (within a frame)', () => {
    const t = 0.5;
    const sim: SimFrame = { tick: 33, pawns: pawns(), clockText: '1:38', bombState: 'carried' };
    const b = sim.pawns.find((p) => p.id === 'barely') as SimFrame['pawns'][number];
    const c = sim.pawns.find((p) => p.id === 'cart') as SimFrame['pawns'][number];
    const dots = [
      { colour: 'yellow', x: b.x + 30, y: b.y, area: 90, px: [0, 0], id: 'barely', role: 'dot' as const },
      { colour: 'orange', x: c.x, y: c.y + 55, area: 90, px: [0, 0], id: 'cart', role: 'dot' as const },
    ];
    const f = compareFrame(round, truthAt(t, dots, { armor: { value: '89', score: 0.97 } }), sim);
    expect(f.players.find((p) => p.id === 'barely')?.verdict).toBe('pass');
    expect(f.players.find((p) => p.id === 'cart')?.verdict).toBe('fail');
    expect(f.hud.find((h) => h.field === 'armor')).toMatchObject({ video: '89', sim: '100', verdict: 'fail' });
    expect(f.hud.find((h) => h.field === 'clock')?.verdict).toBe('pass');
    // The same armor one frame later passes.
    const later: SimFrame = { ...sim, pawns: sim.pawns.map((p) => (p.id === 'eradicate' ? { ...p, armor: 89 } : p)) };
    const g = compareFrame(round, truthAt(t, dots, { armor: { value: '89', score: 0.97 } }), sim, [later]);
    expect(g.hud.find((h) => h.field === 'armor')).toMatchObject({ verdict: 'pass', note: 'within one video frame' });
    expect(f.verdict).toBe('fail');
  });

  it('flags a player alive in the sim after his death on the tape', () => {
    const sim: SimFrame = { tick: 1300, pawns: pawns(), clockText: '1:18', bombState: 'carried' };
    const f = compareFrame(round, truthAt(20.3, []), sim);
    expect(f.players.find((p) => p.id === 'eradicate')).toMatchObject({ verdict: 'fail', note: 'dead on the tape, alive in the sim' });
  });

  it('times the events and diffs against a baseline', () => {
    const truth: Truth = {
      specCc: 0.94, povZoom: 12, povRotOffsetDeg: 0, povCalDots: 10,
      events: { killFeed: round.kills.map((k) => ({ frame: Math.round(k.t * 60), t: k.t, victim: k.victim })), bombIconT: round.bomb.plantT, scoreChangeT: round.bomb.defuseT },
      times: [],
    };
    const exact = compareEvents(round, truth, { deaths: round.kills.map((k) => ({ tick: k.tick, victim: k.victim, attacker: k.killer })), plantTick: round.bomb.plantTick, roundEndTick: round.bomb.defuseTick, roundEndText: 'CT bomb_defused' });
    expect(exact.every((e) => e.verdict === 'pass')).toBe(true);
    const late = compareEvents(round, truth, { deaths: round.kills.map((k) => ({ tick: k.tick + 5, victim: k.victim, attacker: k.killer })), plantTick: null, roundEndTick: round.bomb.defuseTick, roundEndText: 'CT bomb_defused' });
    expect(late.filter((e) => e.verdict === 'fail').length).toBe(round.kills.length + 1);
    const good = { app: '2d', run: 'watch', frames: [], events: exact };
    const bad = { app: '2d', run: 'watch', frames: [], events: late };
    const base = { app: '2d', runs: { watch: { summary: summarize(good), checks: checkKeys(good) } } };
    const r = regressions(base, [bad]);
    expect(r.regressed.length).toBe(round.kills.length + 1);
    expect(regressions(base, [good]).regressed).toEqual([]);
  });
});
