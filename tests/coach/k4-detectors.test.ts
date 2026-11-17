/** K4: every utility, positioning and economy detector on a synthetic demo built to trigger it (and one that does not). */
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/coach/analyze/index';
import { ECONOMY_DETECTORS } from '../../src/coach/detect/economy/index';
import { POSITIONING_DETECTORS } from '../../src/coach/detect/positioning/index';
import type { Detector } from '../../src/coach/detect/types';
import { UTILITY_DETECTORS } from '../../src/coach/detect/utility/index';
import { ECONOMY_METRICS } from '../../src/coach/metrics/economy/index';
import { POSITIONING_METRICS } from '../../src/coach/metrics/positioning/index';
import { UTILITY_METRICS } from '../../src/coach/metrics/utility/index';
import type { RawDemo } from '../../src/coach/model/raw';
import type { Finding } from '../../src/coach/model/report';
import { armAll, blind, det, finish, hurt, kill, projectile, setColumn, setPos, tenPlayers } from './k4-helpers';

const METRICS = [...UTILITY_METRICS, ...POSITIONING_METRICS, ...ECONOMY_METRICS];
const ALL = [...UTILITY_DETECTORS, ...POSITIONING_DETECTORS, ...ECONOMY_DETECTORS];
const byId = (id: string): Detector => ALL.find((d) => d.id === id) as Detector;

function run(raw: RawDemo, user: number, detector: string): Finding[] {
  const { match } = finish(raw);
  return analyze(raw, match, { user, metrics: METRICS, detectors: [byId(detector)] }).findings;
}

/** Round k (0-based) of `tenPlayers`: start, freeze end, end. */
const R = (k: number): { start: number; fe: number; end: number } => ({ start: 100 + k * 1000, fe: 200 + k * 1000, end: 1000 + k * 1000 });

function flashAt(raw: RawDemo, thrower: number, entity: number, t0: number, at: [number, number, number]): number {
  projectile(raw, 'flashbang', thrower, entity, t0, t0 + 100, [0, 0, 0], at);
  const tick = t0 + 101;
  det(raw, tick, 'flash', thrower, entity, at[0], at[1], at[2]);
  return tick;
}

function checkEvidence(f: Finding | undefined): void {
  expect(f).toBeDefined();
  expect(f?.evidence.length).toBeGreaterThanOrEqual(1);
  expect(f?.evidence.length).toBeLessThanOrEqual(4);
  for (const e of f?.evidence ?? []) {
    expect(e.kind).toBe('replay');
    expect(e.tick0).toBeLessThanOrEqual(e.focus);
    expect(e.tick1).toBeGreaterThanOrEqual(e.focus);
    expect(e.annotations.length).toBeGreaterThan(0);
  }
  expect(f?.confidence).toBeGreaterThan(0);
  expect(f?.confidence).toBeLessThanOrEqual(1);
}

describe('util.flash', () => {
  it('flags flashes that blind no enemy, and teammates flashed into a fight', () => {
    const raw = tenPlayers(2);
    for (let k = 0; k < 4; k++) flashAt(raw, 0, 10 + k, 300 + k * 150, [500, 500, 0]);
    // Two of them blind teammate 1, who is hit half a second later.
    blind(raw, 401, 0, 1, 2, 10);
    hurt(raw, 433, 6, 1, 60);
    blind(raw, 551, 0, 1, 1.8, 11);
    hurt(raw, 600, 6, 1, 20);
    const f = run(raw, 0, 'util.flash');
    expect(f.map((x) => x.id)).toEqual(['util.flash.no_enemy', 'util.flash.team']);
    expect(f[0]?.stats).toMatchObject({ instances: 4, opportunities: 4 });
    expect(f[1]?.stats).toMatchObject({ instances: 2, opportunities: 4 });
    checkEvidence(f[0]);
    checkEvidence(f[1]);
    expect(f[0]?.summary).toContain('4 of your 4 flashes');
    expect(f[1]?.evidence[0]?.annotations.some((a) => a.kind === 'label' && a.role === 'bad')).toBe(true);
  });

  it('calls flashes that blind enemies a strength when they lead the lobby', () => {
    const raw = tenPlayers(2);
    let e = 100;
    for (let k = 0; k < 4; k++) {
      const t = flashAt(raw, 0, e, 300 + k * 100, [500, 500, 0]);
      blind(raw, t, 0, 5, 2.5, e);
      blind(raw, t, 0, 6, 2.5, e);
      e++;
    }
    for (let p = 1; p < 10; p++) if (p !== 0) flashAt(raw, p, e++, 1300 + p * 40, [500, 500, 0]);
    const f = run(raw, 0, 'util.flash');
    expect(f.map((x) => x.id)).toEqual(['util.flash.strength']);
    expect(f[0]?.polarity).toBe('strength');
    checkEvidence(f[0]);
  });

  it('stays quiet with too few flashes', () => {
    const raw = tenPlayers(1);
    flashAt(raw, 0, 10, 300, [500, 500, 0]);
    expect(run(raw, 0, 'util.flash')).toEqual([]);
  });
});

describe('util.unused', () => {
  it('counts deaths with two or more grenades in lost rounds', () => {
    const raw = tenPlayers(3, { winner: 3 });
    for (let k = 0; k < 3; k++) {
      const t = R(k).fe + 300;
      raw.inventories.push({ tick: t - 1, p: 0, at: 'death', items: k < 2 ? ['flashbang', 'knife', 'smokegrenade'] : ['flashbang', 'knife'] });
      kill(raw, t, 5, 0);
    }
    const f = run(raw, 0, 'util.unused');
    expect(f.map((x) => x.id)).toEqual(['util.unused.death']);
    expect(f[0]?.stats).toMatchObject({ instances: 2, opportunities: 3, roundsLost: 2 });
    expect(f[0]?.summary).toContain('$1,000 unused');
    checkEvidence(f[0]);
  });

  it('ignores rounds the team won', () => {
    const raw = tenPlayers(3, { winner: 2 });
    for (let k = 0; k < 3; k++) {
      const t = R(k).fe + 300;
      raw.inventories.push({ tick: t - 1, p: 0, at: 'death', items: ['flashbang', 'knife', 'smokegrenade'] });
      kill(raw, t, 5, 0);
    }
    expect(run(raw, 0, 'util.unused')).toEqual([]);
  });
});

describe('util.buy', () => {
  it('flags rifle rounds with money left and no grenades', () => {
    const raw = tenPlayers(3);
    const f = run(raw, 0, 'util.buy');
    expect(f.map((x) => x.id)).toEqual(['util.buy.no_util']);
    expect(f[0]?.stats).toMatchObject({ instances: 3, opportunities: 3 });
    checkEvidence(f[0]);
  });

  it('is quiet when the money is not there', () => {
    const raw = tenPlayers(3);
    setColumn(raw, 'money', 0, 0, Infinity, 100);
    expect(run(raw, 0, 'util.buy')).toEqual([]);
  });
});

describe('util.damage', () => {
  it('flags fires that no enemy touched or came near', () => {
    const raw = tenPlayers(2);
    for (let k = 0; k < 2; k++) {
      projectile(raw, 'molotov', 0, 70 + k, 300 + k * 1000, 360 + k * 1000, [0, 0, 0], [-3000, -3000, 0]);
      det(raw, 361 + k * 1000, 'fire', 0, 90 + k, -3000, -3000);
      det(raw, 361 + 448 + k * 1000, 'fire_end', 0, 90 + k, -3000, -3000);
    }
    const f = run(raw, 0, 'util.damage');
    expect(f.map((x) => x.id)).toEqual(['util.damage.wasted_fire']);
    expect(f[0]?.stats).toMatchObject({ instances: 2, opportunities: 2 });
    checkEvidence(f[0]);
  });

  it('does not flag a fire an enemy walked near', () => {
    const raw = tenPlayers(2);
    for (let k = 0; k < 2; k++) {
      projectile(raw, 'molotov', 0, 70 + k, 300 + k * 1000, 360 + k * 1000, [0, 0, 0], [-3000, -3000, 0]);
      det(raw, 361 + k * 1000, 'fire', 0, 90 + k, -3000, -3000);
      det(raw, 361 + 448 + k * 1000, 'fire_end', 0, 90 + k, -3000, -3000);
    }
    setPos(raw, 5, 0, Infinity, -3300, -3000);
    expect(run(raw, 0, 'util.damage')).toEqual([]);
  });
});

describe('pos.untradeable', () => {
  it('flags deaths with nobody in trade range that went untraded', () => {
    const raw = tenPlayers(3);
    for (let k = 0; k < 3; k++) kill(raw, R(k).fe + 300, 0, 5);
    const f = run(raw, 5, 'pos.untradeable');
    expect(f.map((x) => x.id)).toEqual(['pos.untradeable.isolated']);
    expect(f[0]?.stats).toMatchObject({ instances: 3, opportunities: 3 });
    const e = f[0]?.evidence[0];
    expect(e?.annotations.some((a) => a.kind === 'circle' && a.radius === 900)).toBe(true);
    expect(e?.annotations.some((a) => a.kind === 'line' && a.role === 'enemy')).toBe(true);
    checkEvidence(f[0]);
  });

  it('does not count a death next to a teammate', () => {
    const raw = tenPlayers(3);
    setPos(raw, 6, 0, Infinity, 5200, 5000);
    for (let k = 0; k < 3; k++) kill(raw, R(k).fe + 300, 0, 5);
    expect(run(raw, 5, 'pos.untradeable')).toEqual([]);
  });
});

describe('trade.missed', () => {
  it('flags teammates who died near the player while he did no damage to the killer', () => {
    const raw = tenPlayers(2);
    armAll(raw);
    setPos(raw, 1, 0, Infinity, 300, 0); // 300 units from slot 0
    for (let k = 0; k < 2; k++) kill(raw, R(k).fe + 300, 5, 0);
    const f = run(raw, 1, 'trade.missed');
    expect(f.map((x) => x.id)).toEqual(['trade.missed.no_damage']);
    expect(f[0]?.stats).toMatchObject({ instances: 2, opportunities: 2 });
    expect(f[0]?.summary).toContain('2 chances, 0 attempts, 0 trades');
    checkEvidence(f[0]);
  });

  it('counts damage to the killer as an attempt, not a miss', () => {
    const raw = tenPlayers(2);
    armAll(raw);
    setPos(raw, 1, 0, Infinity, 300, 0);
    for (let k = 0; k < 2; k++) {
      kill(raw, R(k).fe + 300, 5, 0);
      hurt(raw, R(k).fe + 350, 1, 5, 40);
    }
    expect(run(raw, 1, 'trade.missed')).toEqual([]);
  });

  it('needs a gun in hand', () => {
    const raw = tenPlayers(2);
    setPos(raw, 1, 0, Infinity, 300, 0);
    for (let k = 0; k < 2; k++) kill(raw, R(k).fe + 300, 5, 0);
    expect(run(raw, 1, 'trade.missed')).toEqual([]);
  });
});

describe('pos.opening', () => {
  it('flags a player who takes opening duels and loses them', () => {
    const raw = tenPlayers(4);
    for (let k = 0; k < 4; k++) kill(raw, R(k).fe + 300, 5, 0);
    const f = run(raw, 0, 'pos.opening');
    expect(f.map((x) => x.id)).toEqual(['pos.opening.losing']);
    expect(f[0]?.stats).toMatchObject({ instances: 4, opportunities: 4 });
    expect(f[0]?.summary).toContain('won 0');
    checkEvidence(f[0]);
  });

  it('flags first deaths as CT pushing toward the T spawn early', () => {
    const raw = tenPlayers(2);
    for (let k = 0; k < 2; k++) {
      setPos(raw, 5, R(k).fe + 1, R(k).end, 2000, 500);
      kill(raw, R(k).fe + 300, 0, 5);
    }
    const f = run(raw, 5, 'pos.opening');
    expect(f.map((x) => x.id)).toEqual(['pos.opening.ct_push']);
    checkEvidence(f[0]);
  });
});

describe('eco.sync', () => {
  it('flags a buy against four saving teammates', () => {
    const raw = tenPlayers(3);
    for (let p = 1; p < 5; p++) setColumn(raw, 'equip', p, 0, Infinity, 500);
    const f = run(raw, 0, 'eco.sync');
    expect(f.map((x) => x.id)).toEqual(['eco.sync.off']);
    expect(f[0]?.stats).toMatchObject({ instances: 2, opportunities: 2 });
    expect(f[0]?.summary).toContain('2 times you bought while they saved');
    checkEvidence(f[0]);
  });

  it('is quiet when the team buys together', () => {
    expect(run(tenPlayers(3), 0, 'eco.sync')).toEqual([]);
  });
});

describe('eco.kit_armor', () => {
  it('flags CT rifle rounds without kit or armor', () => {
    const raw = tenPlayers(3);
    const f = run(raw, 5, 'eco.kit_armor');
    expect(f.map((x) => x.id)).toEqual(['eco.kit_armor.holes']);
    expect(f[0]?.stats).toMatchObject({ instances: 2, opportunities: 2 });
    expect(f[0]?.summary).toContain('2 as CT without a kit');
    expect(f[0]?.summary).toContain('2 with a rifle and no armor');
    checkEvidence(f[0]);
  });

  it('is quiet with armor and no money for a kit', () => {
    const raw = tenPlayers(3);
    setColumn(raw, 'armor', 5, 0, Infinity, 100);
    setColumn(raw, 'money', 5, 0, Infinity, 300);
    expect(run(raw, 5, 'eco.kit_armor')).toEqual([]);
  });
});
