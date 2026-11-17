/** K6: the sight-based detectors on synthetic demos (box map), with stubbed lobby metrics; and analyze() end to end. */
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/coach/analyze/index';
import { HABITS_DETECTOR } from '../../src/coach/detect/aim/habits';
import { PLACEMENT, placementChart } from '../../src/coach/detect/aim/placement';
import { TIME_TO_DAMAGE } from '../../src/coach/detect/aim/time-to-damage';
import { DEATH_CONTEXT_DETECTOR } from '../../src/coach/detect/positioning/death-context';
import type { MetricValue } from '../../src/coach/model/report';
import { FLAG, type RawDemo } from '../../src/coach/model/raw';
import { addBullet } from './combat-synth';
import { blind, kill, setColumn, setFlag, setPos } from './k4-helpers';
import { A1, A_PEEK, B1, B_COVER, B_PEEK, boxWorld, look, row, setView, sightCtx, sightDemo } from './sight-synth';

/** A stub `metric()`: the given values for the user (slot 0) against a lobby of `others`. */
function stub(values: Record<string, { value: number; others: number; n?: number; better?: 'higher' | 'lower' }>): (id: string) => MetricValue | null {
  return (id) => {
    const v = values[id];
    if (v === undefined) return null;
    const lobby = [v.value, ...Array.from({ length: 9 }, () => v.others)];
    const better = v.better ?? 'lower';
    const ahead = lobby.filter((x) => (better === 'lower' ? x < v.value : x > v.value)).length;
    return { id, value: v.value, unit: 'x', n: v.n ?? 10, lobbyRank: ahead + 1, lobby };
  };
}

/** b1 peeks the same spot 8 times (25 ticks each, 75-tick gaps); a1 holds the crosshair (up, right) off his head. */
function repeatedPeeks(up: number, right: number, damage = false): RawDemo {
  const world = boxWorld();
  const raw = sightDemo();
  for (let k = 0; k < 8; k++) setPos(raw, B1, 210 + 100 * k, 235 + 100 * k, B_PEEK[0], B_PEEK[1]);
  setPos(raw, B1, 0, 209, B_PEEK[0], B_PEEK[1]);
  look(raw, world, A1, 200, 1000, B1, up, right);
  setPos(raw, B1, 0, 209, B_COVER[0], B_COVER[1]);
  if (damage) {
    const P = raw.players.length;
    for (let k = 0; k < 8; k++) {
      const t = 210 + 100 * k + 20;
      look(raw, world, A1, t - 1, t, B1);
      const r = row(raw, t) - 1;
      addBullet(raw, { tick: t, p: A1, pitch: raw.ticks.pitch[r * P + A1] ?? 0, yaw: raw.ticks.yaw[r * P + A1] ?? 0, hurt: { victim: B1, healthAfter: 90 - 10 * k } });
      look(raw, world, A1, t + 1, t + 80, B1, up, right);
    }
  }
  return raw;
}

describe('aim.placement', () => {
  it('flags a crosshair held low and to the side, names the direction, and fills the scatter', () => {
    const { ctx } = sightCtx(repeatedPeeks(8, 6));
    const f = PLACEMENT.run(ctx, A1, stub({ 'aim.placement.angle_deg': { value: 10, others: 2, n: 8 } }));
    expect(f).toHaveLength(1);
    const x = f[0];
    expect(x?.id).toBe('aim.placement.off');
    expect(x?.polarity).toBe('fix');
    expect(x?.title).toBe('Raise your crosshair to head height');
    expect(x?.summary).toContain('8.0° low');
    expect(x?.summary).toContain('left of where they appear');
    expect(x?.stats.opportunities).toBe(8);
    expect(x?.evidence.length).toBeGreaterThanOrEqual(2);
    expect(x?.evidence.length).toBeLessThanOrEqual(4);
    const kinds = x?.evidence[0]?.annotations.map((a) => a.kind);
    expect(kinds).toEqual(['cone', 'line', 'label']);
    const chart = PLACEMENT.charts?.(ctx, A1, () => null, f) ?? {};
    const c = chart['aim.placement'];
    expect(c?.kind).toBe('scatter');
    if (c?.kind !== 'scatter') return;
    expect(c.points).toHaveLength(8);
    expect(c.points[0]?.x).toBeCloseTo(6, 1);
    expect(c.points[0]?.y).toBeCloseTo(8, 1);
    expect(c.points.filter((p) => p.link !== undefined)).toHaveLength(x?.evidence.length ?? 0);
  });

  it('reports a strength for a crosshair already on the head, and nothing without first sights', () => {
    const { ctx } = sightCtx(repeatedPeeks(0.3, -0.2));
    const f = PLACEMENT.run(ctx, A1, stub({ 'aim.placement.angle_deg': { value: 0.4, others: 5, n: 8 } }));
    expect(f.map((x) => [x.id, x.polarity])).toEqual([['aim.placement.sharp', 'strength']]);
    expect(f[0]?.evidence.length).toBeGreaterThan(0);
    const empty = sightCtx(sightDemo()).ctx;
    expect(PLACEMENT.run(empty, A1, stub({}))).toEqual([]);
    expect(placementChart(empty, A1)).toBeNull();
  });
});

describe('aim.time_to_damage', () => {
  it('flags slow damage after first sight', () => {
    const { ctx } = sightCtx(repeatedPeeks(4, 0, true));
    const f = TIME_TO_DAMAGE.run(ctx, A1, stub({ 'aim.time_to_damage.median_ms': { value: 313, others: 150 } }));
    expect(f.map((x) => x.id)).toEqual(['aim.time_to_damage.slow']);
    expect(f[0]?.summary).toContain('313 ms');
    expect(f[0]?.stats.opportunities).toBe(8);
    expect(f[0]?.evidence[0]?.caption).toContain('313 ms from seeing B1');
  });

  it('flags duels seen first and lost', () => {
    const world = boxWorld();
    const raw = sightDemo(2);
    for (const base of [0, 1000]) {
      setPos(raw, B1, 300 + base, 1000 + base, B_PEEK[0], B_PEEK[1]);
      look(raw, world, A1, 300 + base, 1000 + base, B1);
      look(raw, world, B1, 340 + base, 1000 + base, A1);
      kill(raw, 350 + base, B1, A1);
    }
    const { ctx } = sightCtx(raw, world);
    const f = TIME_TO_DAMAGE.run(ctx, A1, stub({}));
    expect(f.map((x) => x.id)).toEqual(['aim.time_to_damage.saw_first_lost']);
    expect(f[0]?.summary).toContain('in 2 of them you never shot at him');
    expect(f[0]?.stats.roundsLost).toBe(0);
  });
});

describe('aim.habits', () => {
  it('a recurring habit is a fix, a one-off an observation', () => {
    const world = boxWorld();
    const raw = sightDemo();
    setPos(raw, B1, 201, 1000, B_PEEK[0], B_PEEK[1]);
    look(raw, world, A1, 201, 1000, B1);
    const P = raw.players.length;
    const aim = (t: number) => ({ pitch: raw.ticks.pitch[(row(raw, t) - 1) * P + A1] ?? 0, yaw: raw.ticks.yaw[(row(raw, t) - 1) * P + A1] ?? 0 });
    for (const t of [300, 330, 360, 390]) {
      setFlag(raw, A1, t - 2, t + 2, FLAG.airborne);
      addBullet(raw, { tick: t, p: A1, ...aim(t) });
    }
    setColumn(raw, 'flash', A1, 420, 1000, 3);
    blind(raw, 420, B1, A1, 3, 51);
    addBullet(raw, { tick: 430, p: A1, ...aim(430) });
    const { ctx } = sightCtx(raw, world);
    const f = HABITS_DETECTOR.run(ctx, A1, stub({}));
    expect(f.map((x) => [x.id, x.polarity, x.stats.instances])).toEqual([['aim.habits.airborne', 'fix', 4], ['aim.habits.flashed', 'observation', 1]]);
    expect(f[0]?.impact).toBeGreaterThan(0);
    expect(f[1]?.impact).toBe(0);
    expect(f.every((x) => x.evidence.length > 0)).toBe(true);
  });
});

describe('pos.death_context', () => {
  function behindDeaths(n: number) {
    const world = boxWorld();
    const raw = sightDemo(n);
    for (let k = 0; k < n; k++) {
      const base = k * 1000;
      setPos(raw, A1, base, base + 1000, A_PEEK[0], A_PEEK[1]);
      setView(raw, A1, base, base + 1000, 0, 90);
      look(raw, world, B1, base + 200, base + 1000, A1);
      kill(raw, base + 600, B1, A1);
    }
    return sightCtx(raw, world).ctx;
  }

  it('a dominant avoidable label is a fix with its share and rounds lost', () => {
    const ctx = behindDeaths(4);
    const f = DEATH_CONTEXT_DETECTOR.run(ctx, A1, stub({}));
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe('pos.death_context.unseen');
    expect(f[0]?.polarity).toBe('fix');
    expect(f[0]?.summary).toContain('by a killer you had not seen 4 (100 %)');
    expect(f[0]?.evidence[0]?.annotations[0]?.kind).toBe('cone');
    expect(f[0]?.evidence[0]?.caption).toContain('from behind');
  });

  it('a single death is an observation', () => {
    const ctx = behindDeaths(1);
    const f = DEATH_CONTEXT_DETECTOR.run(ctx, A1, stub({}));
    expect(f.map((x) => [x.id, x.polarity])).toEqual([['pos.death_context.labels', 'observation']]);
  });
});

describe('analyze() with sight', () => {
  it('computes the sight metrics for every slot, runs the detectors and fills the placement chart only with a mesh', () => {
    const raw = repeatedPeeks(8, 6, true);
    const { match } = sightCtx(raw);
    const rep = analyze(raw, match, { user: A1, los: boxWorld() });
    const m = rep.metrics.find((x) => x.id === 'aim.placement.angle_deg');
    expect(m?.value).toBeCloseTo(10, 0);
    expect(m?.n).toBe(8);
    expect(rep.charts?.['aim.placement']?.kind).toBe('scatter');
    const bare = analyze(raw, match, { user: A1 });
    expect(bare.charts?.['aim.placement']).toBeUndefined();
    expect(bare.findings.some((f) => f.id.startsWith('aim.placement') || f.id.startsWith('pos.death_context'))).toBe(false);
    expect(Number.isNaN(bare.metrics.find((x) => x.id === 'aim.placement.angle_deg')?.value)).toBe(true);
  });
});
