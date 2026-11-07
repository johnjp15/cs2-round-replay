/**
 * W3, headless in the 3D host (Sim3DHost):
 * - moving inaccuracy: 500 first shots standing vs 500 at a full run (215 u/s) land with the CS cones' mean radii
 *   (I standing 0.00641, running 0.00641 + 0.17506); counter-strafing (the opposite key from a full run) gets under
 *   34 % of the max speed in fewer ticks than the AK's recovery time, and the next shot has the standing cone;
 * - friendly fire: the human's AK on a teammate does ff_damage_reduction_bullets (0.33) of the damage; a puppet's
 *   bullets pass through teammates; the team-damage ratios; the HUD's team-damage notices.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlayerId, Vec3 } from '../src/contracts/index';
import { parseWeaponTable, weaponDef } from '../src/engine/weapons/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { TeamDamageNotes } from '../src/app3d/team-damage';
import { Sim3DHost, type Shot3 } from '../src/sim3d/index';
import { act, openNav, setupActions, tuning } from './combat-fixtures';

const table = parseWeaponTable(JSON.parse(readFileSync(new URL('../data/weapons.json', import.meta.url), 'utf8')) as unknown);
const ak = weaponDef(table, 'ak47');
const DEG = 180 / Math.PI;
const WALL = 1024;
const E = 3000;

function meshOf(tris: number[][]): MapGeometry {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      idx.push(verts.length / 3);
      verts.push(Math.round((t[k * 3] as number) * 8), Math.round((t[k * 3 + 1] as number) * 8), Math.round((t[k * 3 + 2] as number) * 8));
    }
  }
  return new MapGeometry({ quant: 8, verts: Int32Array.from(verts), tris: Int32Array.from(idx) });
}

const floor = [
  [-E, -E, 0, E, -E, 0, E, E, 0],
  [-E, -E, 0, E, E, 0, -E, E, 0],
];
const wallAt = (x: number): number[][] => [
  [x, -E, -E, x, E, -E, x, E, E],
  [x, -E, -E, x, E, E, x, -E, E],
];
const range = meshOf([...floor, ...wallAt(WALL)]);
const roster = [
  { id: 'cart' as PlayerId, team: 'T' as const },
  { id: 'barely' as PlayerId, team: 'T' as const },
  { id: 'sp4rtan' as PlayerId, team: 'CT' as const },
];

function host(seed: number, g: MapGeometry, weapon = 'ak47', others: { barely?: Vec3; sp4rtan?: Vec3; armor?: number } = {}): Sim3DHost {
  const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed }, { movement: g, world: g });
  const o = { hp: 100, armor: others.armor ?? 0, helmet: false };
  h.apply(
    act([
      ...setupActions('cart', { x: 0, y: 0 }, 0, weapon),
      ...setupActions('barely', others.barely ?? { x: -2000, y: -2000 }, 0, 'ak47', o),
      ...setupActions('sp4rtan', others.sp4rtan ?? { x: -2000, y: 2000 }, 180, 'ak47', o),
    ]),
  );
  h.tick();
  h.setHuman('cart');
  return h;
}

const speedOf = (h: Sim3DHost): number => {
  const v = h.pawnState('cart')?.move.vel ?? { x: 0, y: 0, z: 0 };
  return Math.hypot(v.x, v.y);
};

/** Radius (units, at the 1,024 u wall) of a shot's impact from the aim point (view 0, 0): its angle off +x × 1,024. */
function radiusAtWall(s: Shot3): number {
  const dx = s.to.x - s.from.x;
  const off = Math.hypot(s.to.y - s.from.y, s.to.z - s.from.z);
  return (off / dx) * WALL;
}

type Plan = 'stand' | 'run' | 'counter';

/** First shot after `plan`: standing still, at a full sideways run, or right after counter-strafing out of a run. */
function firstShot(seed: number, plan: Plan): { r: number; speed: number; counterTicks: number } {
  const h = host(seed, range);
  const step = (side: number, attack: boolean): readonly Shot3[] => {
    h.setHumanInput({ id: 'cart', forward: 0, side, yaw: 0, pitch: 0, buttons: attack ? ['ATTACK'] : [] });
    h.tick();
    return h.shots().filter((s) => s.shooter === 'cart');
  };
  // Deploy and, for 'run' / 'counter', reach full speed (sideways: the bullet's line doesn't change).
  for (let i = 0; i < 80; i++) step(plan === 'stand' ? 0 : 1, false);
  let counterTicks = 0;
  if (plan === 'counter') {
    while (speedOf(h) >= 215 * 0.34 && counterTicks < 64) {
      step(-1, false);
      counterTicks++;
    }
  }
  const speed = speedOf(h);
  for (let i = 0; i < 4; i++) {
    const s = step(plan === 'run' ? 1 : 0, true);
    if (s.length > 0) return { r: radiusAtWall(s[0] as Shot3), speed, counterTicks };
  }
  throw new Error('no shot');
}

/** E|r1·I·e^{iθ1} + r2·S·e^{iθ2}|, r and θ uniform (midpoint rule, as tests/weapons-spray.test.ts). */
function meanCone(I: number, S: number): number {
  const n = 40;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * I;
    for (let j = 0; j < n; j++) {
      const b = ((j + 0.5) / n) * S;
      for (let k = 0; k < n; k++) sum += Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(((k + 0.5) / n) * 2 * Math.PI));
    }
  }
  return sum / (n * n * n);
}

describe('W3: moving inaccuracy in the 3D host (500 first shots each)', () => {
  const N = 500;
  const stand = Array.from({ length: N }, (_, k) => firstShot(9000 + k, 'stand'));
  const run = Array.from({ length: N }, (_, k) => firstShot(9000 + k, 'run'));
  const counter = Array.from({ length: N }, (_, k) => firstShot(9000 + k, 'counter'));
  const mean = (xs: { r: number }[]): number => xs.reduce((a, x) => a + x.r, 0) / xs.length;
  const S = ak.spread[0];
  const Istand = ak.inaccuracy.stand[0];
  const Irun = Istand + ak.inaccuracy.move[0];
  /** Mean radii within 9 %: ~3.5 standard errors of 500 uniform-radius samples (coefficient of variation ≈ 0.58). */
  const TOL = 0.09;

  it('a full run (215 u/s) spreads like the CS cone: I = stand + move, ~28× the standing mean radius', () => {
    expect(Math.min(...run.map((x) => x.speed))).toBeGreaterThan(215 * 0.95);
    const mStand = mean(stand);
    const mRun = mean(run);
    expect(Math.abs(mStand / (WALL * meanCone(Istand, S)) - 1)).toBeLessThan(TOL);
    expect(Math.abs(mRun / (WALL * meanCone(Irun, S)) - 1)).toBeLessThan(TOL);
    const ratio = mRun / mStand;
    const want = meanCone(Irun, S) / meanCone(Istand, S);
    expect(Math.abs(ratio / want - 1)).toBeLessThan(0.08);
    expect(Math.max(...run.map((x) => x.r))).toBeLessThanOrEqual(WALL * (Irun + S) + 0.01);
    expect(Math.max(...stand.map((x) => x.r))).toBeLessThanOrEqual(WALL * (Istand + S) + 0.01);
    console.log(
      `[W3 move inaccuracy] AK first shot at ${WALL} u: standing mean ${mStand.toFixed(2)} u (max ${Math.max(...stand.map((x) => x.r)).toFixed(2)}), running 215 u/s mean ${mRun.toFixed(1)} u (max ${Math.max(...run.map((x) => x.r)).toFixed(1)}); ratio ${ratio.toFixed(1)} (cones: ${want.toFixed(1)})`,
    );
  });

  it('counter-strafing gets under 34 % of max speed within the recovery time and restores the standing cone', () => {
    const ticks = counter.map((x) => x.counterTicks);
    const recoveryTicks = ak.recovery.stand * 64;
    expect(Math.max(...ticks)).toBeLessThan(recoveryTicks);
    expect(Math.max(...counter.map((x) => x.speed))).toBeLessThan(215 * 0.34);
    const mC = mean(counter);
    expect(Math.abs(mC / (WALL * meanCone(Istand, S)) - 1)).toBeLessThan(TOL);
    expect(Math.max(...counter.map((x) => x.r))).toBeLessThanOrEqual(WALL * (Istand + S) + 0.01);
    console.log(`[W3 counter-strafe] from 215 u/s: under 73.1 u/s in ${Math.min(...ticks)}–${Math.max(...ticks)} ticks (AK recovery ${recoveryTicks.toFixed(1)} ticks); next shot mean ${mC.toFixed(2)} u (standing ${mean(stand).toFixed(2)})`);
  });
});

describe('W3: friendly fire (CS2 competitive: mp_friendlyfire 1, ff_damage_reduction_bullets 0.33)', () => {
  it('the tuning carries the competitive values', () => {
    expect(tuning.damage).toMatchObject({ mpFriendlyfire: true, ffDamageReductionBullets: 0.33, ffDamageReductionGrenade: 0.85, ffDamageReductionGrenadeSelf: 1, ffDamageReductionOther: 0.4, friendlyFire: false });
  });

  /** The human's first AK bullet at the chest of a pawn standing 400 u ahead: the shot and the damage events. */
  function shootAt(victim: 'barely' | 'sp4rtan', armor: number): { shot: Shot3; amount: number; armor: number } {
    const h = host(3, range, 'ak47', { [victim]: { x: 400, y: 0, z: 0 }, armor });
    const pitch = Math.atan2(64 - 48, 400) * DEG;
    for (let t = 0; t < 8; t++) {
      h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch, buttons: ['ATTACK'] });
      h.tick();
      const shot = h.shots().find((q) => q.shooter === 'cart');
      if (shot !== undefined) {
        const e = h.observe().events.find((x) => x.type === 'damage' && x.victim === victim);
        return { shot, amount: e?.type === 'damage' ? e.amount : 0, armor: e?.type === 'damage' ? e.armor : 0 };
      }
    }
    throw new Error('no shot');
  }

  it("the human's AK on a teammate: hit, and 33 % of the damage an enemy takes from the same bullet", () => {
    for (const armor of [0, 100]) {
      const mate = shootAt('barely', armor);
      const foe = shootAt('sp4rtan', armor);
      expect(mate.shot.victim).toBe('barely');
      expect(foe.shot.victim).toBe('sp4rtan');
      expect(mate.shot.hitgroup).toBe(foe.shot.hitgroup);
      expect(foe.amount).toBeGreaterThan(20);
      expect(mate.amount).toBeGreaterThan(0);
      // 33 % of the enemy's damage, to within the integer truncation (the ratio is applied before hitgroup and armor).
      expect(Math.abs(mate.amount - 0.33 * foe.amount)).toBeLessThanOrEqual(1);
      console.log(`[W3 friendly fire] AK ${mate.shot.hitgroup ?? ''} at 400 u, armor ${armor}: enemy ${foe.amount} hp, teammate ${mate.amount} hp`);
    }
  });

  it("a puppet's bullets pass through its teammates (the recording decides its outcomes)", () => {
    const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed: 1 }, { movement: range, world: range });
    h.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, 'ak47'), ...setupActions('barely', { x: 400, y: 0 }, 0, 'ak47'), ...setupActions('sp4rtan', { x: -2000, y: 2000 }, 180, 'ak47')]));
    h.tick();
    const pitch = Math.atan2(64 - 48, 400) * DEG;
    let shot: Shot3 | undefined;
    for (let t = 0; shot === undefined && t < 8; t++) {
      h.apply(act([], [{ id: 'cart', forward: 0, side: 0, yaw: 0, pitch, buttons: ['ATTACK'] }]));
      h.tick();
      shot = h.shots().find((q) => q.shooter === 'cart');
    }
    expect(shot).toBeDefined();
    expect(shot?.victim).toBeNull();
    expect(h.pawnState('barely')?.hp).toBe(100);
  });

  it('team-damage ratios: bullets 0.33, HE 0.85, own HE 1, other (knife, fire) 0.4; enemies 1', () => {
    const h = host(1, range);
    const mate = { id: 'barely' as PlayerId, team: 'T' as const };
    const foe = { id: 'sp4rtan' as PlayerId, team: 'CT' as const };
    const self = { id: 'cart' as PlayerId, team: 'T' as const };
    expect(h.teamDamageRatio('cart', mate, 'bullet')).toBe(0.33);
    expect(h.teamDamageRatio('cart', mate, 'grenade')).toBe(0.85);
    expect(h.teamDamageRatio('cart', mate, 'other')).toBe(0.4);
    expect(h.teamDamageRatio('cart', self, 'grenade')).toBe(1);
    expect(h.teamDamageRatio('cart', self, 'other')).toBe(1);
    for (const k of ['bullet', 'grenade', 'other'] as const) expect(h.teamDamageRatio('cart', foe, k)).toBe(1);
    expect(h.teamDamageRatio(null, mate, 'other')).toBe(1);
  });

  it('HUD notices: "<x> attacked a teammate" (once per 3 s per attacker), the human\'s hint for 3 s; not for fire or self', () => {
    const n = new TeamDamageNotes();
    const pawns = [
      { id: 'cart', team: 'T' },
      { id: 'barely', team: 'T' },
      { id: 'sp4rtan', team: 'CT' },
    ];
    const ev = (tick: number, attacker: string, victim: string, weapon: string): unknown => ({ tick, pawns, events: [{ type: 'damage', attacker, victim, amount: 10, armor: 0, weapon, hitgroup: 'chest', scripted: false }] });
    const feed = (o: unknown): void => n.ingest(o as Parameters<TeamDamageNotes['ingest']>[0]);
    feed(ev(100, 'cart', 'sp4rtan', 'ak47'));
    expect(n.feed(100)).toEqual([]);
    feed(ev(110, 'cart', 'barely', 'ak47'));
    feed(ev(120, 'cart', 'barely', 'ak47'));
    expect(n.feed(120)).toEqual(['cart attacked a teammate']);
    expect(n.hint('cart', 120)).toBe('Try not to injure your teammates');
    expect(n.hint('barely', 120)).toBeNull();
    expect(n.hint('cart', 120 + 3 * 64)).toBeNull();
    feed(ev(110 + 3 * 64, 'cart', 'barely', 'ak47'));
    expect(n.feed(110 + 3 * 64)).toHaveLength(2);
    expect(n.feed(110 + 5 * 64)).toHaveLength(1);
    const m = new TeamDamageNotes();
    m.ingest(ev(10, 'cart', 'barely', 'molotov') as Parameters<TeamDamageNotes['ingest']>[0]);
    m.ingest(ev(11, 'cart', 'cart', 'he') as Parameters<TeamDamageNotes['ingest']>[0]);
    expect(m.feed(12)).toEqual([]);
    expect(m.hint('cart', 12)).toBeNull();
  });
});
