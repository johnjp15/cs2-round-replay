/** H5: the CS2 grenade mechanics on synthetic box worlds (docs/grenades.md). */
import { describe, expect, it } from 'vitest';
import {
  applyArmor,
  blastDamage,
  blindFromExposure,
  createGrenadeState,
  createSmoke,
  flashAlpha,
  flashExposure,
  isBlind,
  jumpThrowPose,
  releaseGrenade,
  simulateThrow,
  smokeBlocks,
  smokeBulletHole,
  smokeDensityAt,
  stepGrenades,
  throwGrenade,
  throwPitch,
  throwSpeed,
  type GrenadeEvent,
  type GrenadePawn,
  type GrenadeState,
  type GrenadeType,
  type ThrowRequest,
} from '../../src/engine/grenades/index';
import { BoxWorld } from './box-world';
import { cs2Tuning } from './mirage-world';

const t = cs2Tuning();
const cfg = { tuning: t };
const flat = BoxWorld.flat();
const ZERO = { x: 0, y: 0, z: 0 };

function pawn(id: string, team: 'T' | 'CT', x: number, y: number, yaw = 0, pitch = 0, z = 0): GrenadePawn {
  return { id, team, alive: true, pos: { x, y, z }, height: 72, eye: { x, y, z: z + 64 }, yaw, pitch };
}

function req(type: GrenadeType, over: Partial<ThrowRequest> = {}): ThrowRequest {
  return { type, thrower: 'me', team: 'T', eye: { x: 0, y: 0, z: 64 }, pitch: 0, yaw: 0, strength: 1, velocity: ZERO, ...over };
}

/** Run a state until `ticks` ticks have passed, collecting events. */
function run(state: GrenadeState, world: BoxWorld, pawns: GrenadePawn[], ticks: number, friendlyFire = false): GrenadeEvent[] {
  const out: GrenadeEvent[] = [];
  for (let k = 0; k < ticks; k++) out.push(...stepGrenades(state, world, { pawns, friendlyFire }, cfg));
  return out;
}

/** A smoke resting at (x, y) on the flat floor. */
function smokeAt(world: BoxWorld, x: number, y: number, tick = 0): GrenadeState {
  const s = createGrenadeState(5, tick);
  s.smokes.push(createSmoke(99, 'me', 'T', { x, y, z: 2 }, tick, world, t));
  return s;
}

describe('throw (release law)', () => {
  it('speed by strength: 675 / 438.75 / 202.5 u/s', () => {
    expect(throwSpeed(1, t)).toBeCloseTo(675, 9);
    expect(throwSpeed(0.5, t)).toBeCloseTo(438.75, 9);
    expect(throwSpeed(0, t)).toBeCloseTo(202.5, 9);
  });
  it('pitch remap: level aim throws 10° up; straight up / down unchanged', () => {
    expect(throwPitch(0, t)).toBeCloseTo(-10, 9);
    expect(throwPitch(-90, t)).toBeCloseTo(-90, 9);
    expect(throwPitch(90, t)).toBeCloseTo(90, 9);
    expect(throwPitch(45, t)).toBeCloseTo(40, 9);
    expect(throwPitch(-45, t)).toBeCloseTo(-50, 9);
    expect(throwPitch(350, t)).toBeCloseTo(throwPitch(-10, t), 9);
  });
  it('spawns 16 ahead of the eye (22 traced, 6 back), underhand 12 lower, plus 1.25 × the player velocity', () => {
    const r = releaseGrenade({ x: 0, y: 0, z: 64 }, 9, 0, 1, { x: 100, y: 0, z: 0 }, flat, t);
    expect(r.pos.x).toBeCloseTo(16, 2);
    expect(r.pos.z).toBeCloseTo(64, 9);
    expect(r.vel.x).toBeCloseTo(675 + 125, 9);
    expect(r.vel.z).toBeCloseTo(0, 9);
    const u = releaseGrenade({ x: 0, y: 0, z: 64 }, 9, 0, 0, ZERO, flat, t);
    expect(u.pos.z).toBeCloseTo(52, 9);
    expect(Math.hypot(u.vel.x, u.vel.y, u.vel.z)).toBeCloseTo(202.5, 9);
  });
  it('spawn stops short of a wall in front of the face', () => {
    const wall = BoxWorld.flat([{ min: [10, -100, 0], max: [30, 100, 200] }]);
    const r = releaseGrenade({ x: 0, y: 0, z: 64 }, 9, 0, 1, ZERO, wall, t);
    expect(r.pos.x).toBeLessThan(8 - 6 + 0.01);
  });
  it('jump-throw latch: vz 218.87 and the eye 25.9 higher, horizontal speed carried', () => {
    const p = jumpThrowPose({ x: 0, y: 0, z: 64 }, { x: 200, y: 0 }, t);
    expect(p.velocity.z).toBeCloseTo(218.86838, 4);
    expect(p.eye.z - 64).toBeCloseTo(25.886838, 4);
    expect(p.eye.x).toBeCloseTo(20, 9);
    expect(p.velocity.x).toBe(200);
  });
});

describe('projectile', () => {
  it('a level throw on flat ground lands where the exact ballistic solution says (trapezoid integration)', () => {
    const r = simulateThrow(req('he'), flat, cfg, { maxSec: 3 });
    const first = r.events.find((e) => e.type === 'bounce');
    expect(first).toBeDefined();
    if (first === undefined || first.type !== 'bounce') return;
    // Spawned 16 along the throw direction; the box centre reaches z = 2: z(t) = z0 + vz t − 160 t².
    const c = Math.cos(10 * (Math.PI / 180));
    const sn = Math.sin(10 * (Math.PI / 180));
    const z0 = 64 + 16 * sn;
    const vz = 675 * sn;
    const tt = (vz + Math.sqrt(vz * vz + 4 * 160 * (z0 - 2))) / (2 * 160);
    expect(first.pos.x).toBeCloseTo(16 * c + 675 * c * tt, 0);
    expect(first.pos.z).toBeCloseTo(2, 1);
    expect(first.tick / 64).toBeCloseTo(tt, 1);
  });
  it('bounce: the velocity reflects off the normal × 0.45 (floor and wall)', () => {
    const s = createGrenadeState(1);
    throwGrenade(s, req('he', { eye: { x: 0, y: 0, z: 40 }, pitch: 90, strength: 0 }), flat, cfg);
    const p = s.projectiles[0];
    if (p === undefined) throw new Error('no projectile');
    p.vel = { x: 100, y: 0, z: -300 };
    p.pos = { x: 0, y: 0, z: 4 };
    const ev = run(s, flat, [], 1);
    expect(ev.some((e) => e.type === 'bounce')).toBe(true);
    expect(p.vel.x).toBeCloseTo(45, 6);
    expect(p.vel.z).toBeGreaterThan(0.45 * 300 - 5);
    expect(p.vel.z).toBeLessThan(0.45 * 300);
    const wall = BoxWorld.flat([{ min: [20, -100, 0], max: [40, 100, 300] }]);
    const s2 = createGrenadeState(1);
    throwGrenade(s2, req('he'), wall, cfg);
    const q = s2.projectiles[0];
    if (q === undefined) throw new Error('no projectile');
    q.pos = { x: 10, y: 0, z: 100 };
    q.vel = { x: 1000, y: 0, z: 0 };
    run(s2, wall, [], 1);
    expect(q.vel.x).toBeCloseTo(-450, 6);
  });
  it('bounces off players with 0.3 × the elasticity and never off the thrower', () => {
    const s = createGrenadeState(1);
    throwGrenade(s, req('he', { eye: { x: 0, y: 0, z: 40 } }), flat, cfg);
    const p = s.projectiles[0];
    if (p === undefined) throw new Error('no projectile');
    p.pos = { x: 0, y: 0, z: 40 };
    p.vel = { x: 1000, y: 0, z: 0 };
    const ev = run(s, flat, [pawn('me', 'T', 20, 0), pawn('cart', 'T', 40, 0)], 2);
    const b = ev.find((e) => e.type === 'bounce');
    expect(b !== undefined && b.type === 'bounce' && b.pawn).toBe('cart');
    expect(p.vel.x).toBeCloseTo(-1000 * 0.45 * 0.3, 6);
  });
  it('rolls, slows and comes to rest; a smoke detonates on the first rest check after 1.5 s', () => {
    const r = simulateThrow(req('smoke'), flat, cfg);
    const rest = r.events.find((e) => e.type === 'rest');
    expect(rest).toBeDefined();
    const det = r.detonation;
    expect(det).not.toBeNull();
    if (det === null || rest === undefined) return;
    expect(det.tick).toBeGreaterThanOrEqual(rest.tick);
    expect(det.tick).toBeGreaterThanOrEqual(96);
    expect((det.tick - 96) % 13).toBe(0);
    expect(det.pos.z).toBeCloseTo(2, 1);
  });
  it('HE and flash detonate 1.5 s after the throw, mid-air if need be', () => {
    for (const type of ['he', 'flash'] as const) {
      const r = simulateThrow(req(type, { pitch: -80 }), flat, cfg);
      expect(r.detonation?.tick).toBe(96);
      expect(r.detonation?.pos.z ?? 0).toBeGreaterThan(100);
    }
  });
  it('molotov: bursts on flat ground, bounces off walls and steep slopes, air-bursts at 2 s', () => {
    const r = simulateThrow(req('molotov', { pitch: 20 }), flat, cfg);
    expect(r.detonation?.tick ?? 999).toBeLessThan(64);
    expect(r.events.filter((e) => e.type === 'bounce')).toHaveLength(1);
    const wall = BoxWorld.flat([{ min: [100, -500, 0], max: [120, 500, 500] }]);
    const w = simulateThrow(req('molotov', { pitch: -5 }), wall, cfg);
    expect(w.events.filter((e) => e.type === 'bounce').length).toBeGreaterThanOrEqual(2);
    expect(w.detonation?.pos.x ?? 999).toBeLessThan(100);
    const up = simulateThrow(req('molotov', { pitch: -89 }), flat, cfg);
    expect(up.detonation?.tick).toBe(128);
    const s = createGrenadeState(1);
    throwGrenade(s, req('molotov', { pitch: -89 }), flat, cfg);
    const ev = run(s, flat, [], 130);
    expect(ev.find((e) => e.type === 'no_fire')).toMatchObject({ reason: 'airburst' });
  });
  it('a molotov hitting another player bursts on the floor under it', () => {
    const s = createGrenadeState(1);
    throwGrenade(s, req('molotov', { pitch: 15 }), flat, cfg);
    const ev = run(s, flat, [pawn('donk', 'CT', 120, 0)], 64);
    const b = ev.find((e) => e.type === 'bounce');
    expect(b !== undefined && b.type === 'bounce' && b.pawn).toBe('donk');
    expect(ev.find((e) => e.type === 'fire_start')).toBeDefined();
  });
  it('is deterministic: the same throws give the same events and state', () => {
    const once = (): string => {
      const s = createGrenadeState(42);
      const types: GrenadeType[] = ['smoke', 'flash', 'he', 'molotov', 'incendiary', 'decoy'];
      types.forEach((type, k) => throwGrenade(s, req(type, { yaw: k * 60, pitch: -20 }), flat, cfg));
      const ev = run(s, flat, [pawn('a', 'CT', 300, 0, 180), pawn('b', 'T', -200, 50)], 64 * 20);
      return JSON.stringify({ ev, s });
    };
    expect(once()).toBe(once());
  });
});

describe('smoke', () => {
  it('fills a ~140-unit dome in the open (750 voxels of 20 units) and lasts 18 s: full for 15 s, then thins out over 3 s (V5)', () => {
    const s = smokeAt(flat, 0, 0);
    const smoke = s.smokes[0];
    if (smoke === undefined) throw new Error('no smoke');
    expect(smoke.cells).toHaveLength(750);
    let maxR = 0;
    let maxZ = 0;
    for (let x = -300; x <= 300; x += 10) if (smokeDensityAt(s, { x, y: 0, z: 30 }, 100, t) > 0) maxR = Math.max(maxR, Math.abs(x));
    for (let z = 0; z <= 300; z += 10) if (smokeDensityAt(s, { x: 0, y: 0, z }, 100, t) > 0) maxZ = z;
    expect(maxR).toBeGreaterThanOrEqual(130);
    expect(maxR).toBeLessThanOrEqual(190);
    expect(maxZ).toBeGreaterThanOrEqual(90);
    expect(maxZ).toBeLessThan(maxR);
    const a = { x: -400, y: 0, z: 60 };
    const b = { x: 400, y: 0, z: 60 };
    expect(smokeBlocks(s, a, b, 0, t)).toBe(false);
    expect(smokeBlocks(s, a, b, 64 * 2, t)).toBe(true);
    expect(smokeBlocks(s, a, b, 64 * 15 - 1, t)).toBe(true);
    // Thinning: half density at 16.5 s; gone at 18 s.
    expect(smokeDensityAt(s, { x: 0, y: 0, z: 30 }, 64 * 15 - 1, t)).toBe(1);
    expect(smokeDensityAt(s, { x: 0, y: 0, z: 30 }, Math.round(64 * 16.5), t)).toBeCloseTo(0.5, 1);
    expect(smokeBlocks(s, a, b, 64 * 18, t)).toBe(false);
    expect(smokeDensityAt(s, { x: 0, y: 0, z: 30 }, 64 * 18, t)).toBe(0);
    expect(smokeBlocks(s, { x: -400, y: 300, z: 60 }, { x: 400, y: 300, z: 60 }, 64 * 2, t)).toBe(false);
  });
  it('grows from the centre over 1.2 s', () => {
    const s = smokeAt(flat, 0, 0);
    expect(smokeDensityAt(s, { x: 0, y: 0, z: 20 }, 1, t)).toBe(1);
    expect(smokeDensityAt(s, { x: 120, y: 0, z: 20 }, 10, t)).toBe(0);
    expect(smokeDensityAt(s, { x: 120, y: 0, z: 20 }, 80, t)).toBe(1);
  });
  it('does not pass through a wall, and runs further down a corridor', () => {
    const wallWorld = BoxWorld.flat([{ min: [60, -1000, 0], max: [80, 1000, 400] }]);
    const s = smokeAt(wallWorld, 0, 0);
    for (let x = 80; x < 400; x += 10) for (let z = 10; z < 300; z += 20) expect(smokeDensityAt(s, { x, y: 0, z }, 200, t)).toBe(0);
    const corridor = BoxWorld.flat([
      { min: [-2000, 40, 0], max: [2000, 60, 400] },
      { min: [-2000, -60, 0], max: [2000, -40, 400] },
      { min: [-2000, -60, 120], max: [2000, 60, 140] },
    ]);
    const c = smokeAt(corridor, 0, 0);
    let reach = 0;
    for (let x = 0; x < 400; x += 10) if (smokeDensityAt(c, { x, y: 0, z: 30 }, 200, t) > 0) reach = x;
    expect(reach).toBeGreaterThan(250);
  });
  it('HE opens a hole that regrows over 0.5–5 s; bullets cut short-lived gaps', () => {
    const s = smokeAt(flat, 0, 0);
    const a = { x: -400, y: 0, z: 60 };
    const b = { x: 400, y: 0, z: 60 };
    s.heHoles.push({ pos: { x: 0, y: 0, z: 30 }, tick: 200 });
    expect(smokeBlocks(s, a, b, 199, t)).toBe(true);
    expect(smokeBlocks(s, a, b, 210, t)).toBe(false);
    expect(smokeDensityAt(s, { x: 0, y: 0, z: 30 }, 210, t)).toBeCloseTo(0.02, 6);
    expect(smokeBlocks(s, a, b, 200 + 64 * 5, t)).toBe(true);
    const s2 = smokeAt(flat, 0, 0);
    expect(smokeBulletHole(s2, a, b, 300, t)).toBeGreaterThan(0);
    expect(smokeBlocks(s2, a, b, 301, t)).toBe(false);
    expect(smokeBlocks(s2, { x: -400, y: 0, z: 100 }, { x: 400, y: 0, z: 100 }, 301, t)).toBe(true);
    expect(smokeBlocks(s2, a, b, 300 + 96, t)).toBe(true);
  });
});

describe('flash', () => {
  const src = { x: 100, y: 0, z: 64 };
  const blindOf = (p: GrenadePawn, world = flat): ReturnType<typeof blindFromExposure> =>
    blindFromExposure(flashExposure(src, p, world, createGrenadeState(1), 0, t), 0, t);
  it('duration table: distance falls linearly to 0 at 1500, by facing band', () => {
    const rows: [number, number, number, number][] = [];
    for (const d of [0, 375, 750, 1125, 1499]) {
      for (const yaw of [180, 90, 0]) {
        const b = blindOf(pawn('v', 'CT', 100 + d + 1e-9, 0, yaw));
        rows.push([d, yaw, b?.holdSec ?? 0, b?.fadeSec ?? 0]);
      }
    }
    const front0 = rows.find((r) => r[0] === 0 && r[1] === 180);
    expect(front0?.[2]).toBeCloseTo(2.5, 6);
    expect(front0?.[3]).toBeCloseTo(5, 6);
    const front750 = rows.find((r) => r[0] === 750 && r[1] === 180);
    expect(front750?.[3]).toBeCloseTo(2.5, 6);
    const side0 = rows.find((r) => r[0] === 0 && r[1] === 90);
    expect(side0?.[3]).toBeCloseTo(3.5, 6);
    expect(side0?.[2]).toBeCloseTo(1.6, 6);
    const back0 = rows.find((r) => r[0] === 0 && r[1] === 0);
    expect(back0?.[3]).toBeCloseTo(2, 6);
    expect(blindOf(pawn('v', 'CT', 100 + 1500, 0, 180))).toBeNull();
  });
  it('a wall blocks it; partial cover gives the probe share', () => {
    const wall = BoxWorld.flat([{ min: [200, -500, 0], max: [220, 500, 500] }]);
    expect(blindOf(pawn('v', 'CT', 400, 0, 180), wall)).toBeNull();
    const post = BoxWorld.flat([{ min: [200, -5, 0], max: [220, 5, 500] }]);
    const x = flashExposure(src, pawn('v', 'CT', 400, 0, 180), post, createGrenadeState(1), 0, t);
    expect(x.exposure).toBeCloseTo(2 * 0.167, 9);
  });
  it('fade curve: full white through the hold, linear to 0; blind while alpha ≥ 0.7', () => {
    const b = { startTick: 0, holdSec: 2, fadeSec: 4, maxAlpha: 1 };
    expect(flashAlpha(b, 64)).toBe(1);
    expect(flashAlpha(b, 64 * 3)).toBeCloseTo(0.5, 9);
    expect(flashAlpha(b, 64 * 4)).toBe(0);
    expect(isBlind(b, 64 * 2.5, t)).toBe(true);
    expect(isBlind(b, 64 * 3, t)).toBe(false);
  });
  it('blinds everyone with a line to it, the thrower too', () => {
    const s = createGrenadeState(1);
    throwGrenade(s, req('flash', { pitch: -30 }), flat, cfg);
    const ev = run(s, flat, [pawn('me', 'T', 0, 0, 180), pawn('ct', 'CT', 800, 0, 180)], 97);
    expect(ev.filter((e) => e.type === 'blind').map((e) => (e.type === 'blind' ? e.victim : ''))).toEqual(['ct', 'me']);
  });
});

describe('fire', () => {
  function burn(world: BoxWorld, type: 'molotov' | 'incendiary', ticks: number, pawns: GrenadePawn[] = [], pre?: (s: GrenadeState) => void): { s: GrenadeState; ev: GrenadeEvent[]; maxFlames: number; maxR: number } {
    const s = createGrenadeState(7);
    pre?.(s);
    throwGrenade(s, req(type, { pitch: 60, eye: { x: 0, y: 0, z: 64 } }), world, cfg);
    const ev: GrenadeEvent[] = [];
    let maxFlames = 0;
    let maxR = 0;
    for (let k = 0; k < ticks; k++) {
      ev.push(...stepGrenades(s, world, { pawns, friendlyFire: false }, cfg));
      for (const inf of s.infernos) {
        maxFlames = Math.max(maxFlames, inf.flames.length);
        for (const f of inf.flames) maxR = Math.max(maxR, Math.hypot(f.pos.x - inf.center.x, f.pos.y - inf.center.y));
      }
    }
    return { s, ev, maxFlames, maxR };
  }
  it('on flat ground: 16 flames within 150, full spread in about 2 s, out after 6–7 s', () => {
    const r = burn(BoxWorld.flat(), 'molotov', 64 * 10);
    expect(r.maxFlames).toBe(16);
    expect(r.maxR).toBeGreaterThan(90);
    expect(r.maxR).toBeLessThanOrEqual(150);
    const start = r.ev.find((e) => e.type === 'fire_start');
    const end = r.ev.find((e) => e.type === 'fire_end');
    if (start === undefined || end === undefined) throw new Error('no fire');
    expect((end.tick - start.tick) / 64).toBeGreaterThanOrEqual(5.9);
    expect((end.tick - start.tick) / 64).toBeLessThanOrEqual(7.05);
    expect(end).toMatchObject({ reason: 'burnt_out' });
  });
  it('the CT incendiary spreads within 110 and burns 5.5 s at most', () => {
    const r = burn(BoxWorld.flat(), 'incendiary', 64 * 10);
    expect(r.maxR).toBeLessThanOrEqual(110);
    const start = r.ev.find((e) => e.type === 'fire_start');
    const end = r.ev.find((e) => e.type === 'fire_end');
    expect(((end?.tick ?? 0) - (start?.tick ?? 0)) / 64).toBeLessThanOrEqual(5.55);
  });
  it('against a wall: no flame on the far side', () => {
    const r = burn(BoxWorld.flat([{ min: [80, -1000, 0], max: [100, 1000, 300] }]), 'molotov', 64 * 3);
    for (const inf of r.s.infernos) for (const f of inf.flames) expect(f.pos.x).toBeLessThan(80);
    expect(r.maxFlames).toBeGreaterThan(8);
  });
  it('deals 8 per 0.2 s (40/s) to a pawn in it, armor ratio 1.8 → armorPen 0.9', () => {
    const r = burn(BoxWorld.flat(), 'molotov', 64 * 3, [pawn('ct', 'CT', 64, 0), pawn('far', 'CT', 900, 0)]);
    const hurts = r.ev.filter((e) => e.type === 'hurt');
    expect(hurts.length).toBeGreaterThan(5);
    for (const h of hurts) expect(h).toMatchObject({ victim: 'ct', damage: 8, armorPen: 0.9 });
    const ticks = hurts.map((h) => h.tick);
    const gap = (ticks[1] ?? 0) - (ticks[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(12);
    expect(gap).toBeLessThanOrEqual(13);
  });
  it('smoke puts it out; a molotov landing in smoke makes no fire', () => {
    const r = burn(BoxWorld.flat(), 'molotov', 64 * 2);
    const inf = r.s.infernos[0];
    if (inf === undefined) throw new Error('no fire');
    r.s.smokes.push(createSmoke(50, 'x', 'CT', { x: inf.center.x, y: inf.center.y, z: 2 }, r.s.tick, BoxWorld.flat(), t));
    const from = r.s.tick;
    const ev = run(r.s, BoxWorld.flat(), [], 80);
    const end = ev.find((e) => e.type === 'fire_end');
    expect(end).toMatchObject({ reason: 'smoked' });
    expect((end?.tick ?? 999) - from).toBeLessThan(80);
    const r2 = burn(BoxWorld.flat(), 'molotov', 64 * 2, [], (s) => {
      s.smokes.push(createSmoke(50, 'x', 'CT', { x: 40, y: 0, z: 2 }, -200, BoxWorld.flat(), t));
    });
    expect(r2.ev.find((e) => e.type === 'no_fire')).toMatchObject({ reason: 'smoke' });
  });
});

describe('HE', () => {
  it('damage by distance: 99 × exp(−d² / 2σ²), σ = 350 / 3, 0 from 350', () => {
    const table = [0, 50, 100, 175, 250, 349, 350].map((d) => blastDamage(d, 99, 350, t));
    expect(table[0]).toBe(99);
    expect(table[1]).toBeCloseTo(99 * Math.exp(-(50 * 50) / (2 * (350 / 3) ** 2)), 9);
    expect(table[2]).toBeCloseTo(99 * Math.exp(-(100 * 100) / (2 * (350 / 3) ** 2)), 9);
    expect(table[3]).toBeCloseTo(99 * Math.exp(-1.125), 9);
    expect(table[6]).toBe(0);
    expect(blastDamage(175, 99, 350, { heGaussian: false, heSigmaFraction: 1 / 3 })).toBeCloseTo(49.5, 9);
  });
  it('point blank on a standing pawn: ~95; armored (armorPen 0.6) ~57', () => {
    const s = createGrenadeState(1);
    throwGrenade(s, req('he', { thrower: 'he1', pitch: 89, strength: 0, eye: { x: 0, y: 0, z: 30 } }), flat, cfg);
    const ev = run(s, flat, [pawn('ct', 'CT', 20, 0)], 97);
    const h = ev.find((e) => e.type === 'hurt');
    if (h === undefined || h.type !== 'hurt') throw new Error('no hurt');
    expect(h.damage).toBeGreaterThan(90);
    expect(h.armorPen).toBeCloseTo(0.6, 9);
    const a = applyArmor(h.damage, 100, h.armorPen);
    expect(a.health).toBeGreaterThan(54);
    expect(a.health).toBeLessThan(60);
  });
  it('a wall stops it; the thrower takes full damage; teammates only with friendly fire (× 0.25)', () => {
    const wall = BoxWorld.flat([{ min: [40, -500, 0], max: [60, 500, 500] }]);
    const s = createGrenadeState(1);
    throwGrenade(s, req('he', { pitch: 89, strength: 0, eye: { x: 0, y: 0, z: 30 } }), wall, cfg);
    const pawns = [pawn('behind', 'CT', 120, 0), pawn('me', 'T', -30, 0), pawn('mate', 'T', 0, 60)];
    const ev = run(s, wall, pawns, 97).filter((e) => e.type === 'hurt');
    expect(ev.map((e) => (e.type === 'hurt' ? e.victim : ''))).toEqual(['me']);
    const s2 = createGrenadeState(1);
    throwGrenade(s2, req('he', { pitch: 89, strength: 0, eye: { x: 0, y: 0, z: 30 } }), wall, cfg);
    const ff = run(s2, wall, pawns, 97, true).filter((e) => e.type === 'hurt');
    const mate = ff.find((e) => e.type === 'hurt' && e.victim === 'mate');
    const me = ff.find((e) => e.type === 'hurt' && e.victim === 'me');
    if (mate?.type !== 'hurt' || me?.type !== 'hurt') throw new Error('missing');
    const d = Math.hypot(0 - mate.damage, 0);
    expect(d).toBeGreaterThan(0);
    expect(mate.damage).toBeCloseTo(blastDamage(Math.hypot(0, 60, 36 - 3), 99, 350, t) * 0.25, 0);
  });
  it('the armor rule', () => {
    expect(applyArmor(100, 100, 0.5)).toEqual({ health: 50, armor: 25 });
    expect(applyArmor(100, 10, 0.5)).toEqual({ health: 80, armor: 10 });
    expect(applyArmor(100, 0, 0.5)).toEqual({ health: 100, armor: 0 });
  });
});

describe('decoy', () => {
  it('fakes shots in bursts for 15 s after it stops, then pops for ≤ 5', () => {
    const s = createGrenadeState(3);
    throwGrenade(s, req('decoy', { decoyShotIntervalSec: 0.1 }), flat, cfg);
    const ev = run(s, flat, [pawn('ct', 'CT', 700, 0)], 64 * 25);
    const det = ev.find((e) => e.type === 'detonate');
    const shots = ev.filter((e) => e.type === 'decoy_shot');
    const boom = ev.find((e) => e.type === 'decoy_explode');
    if (det === undefined || boom === undefined) throw new Error('no decoy');
    expect(boom.tick - det.tick).toBe(64 * 15);
    expect(shots.length).toBeGreaterThan(15);
    for (const sh of shots) {
      expect(sh.tick).toBeGreaterThanOrEqual(det.tick);
      expect(sh.tick).toBeLessThan(boom.tick);
    }
    const gaps = shots.slice(1).map((sh, k) => sh.tick - (shots[k] as GrenadeEvent).tick);
    expect(Math.min(...gaps)).toBe(6);
    expect(Math.max(...gaps)).toBeGreaterThan(20);
    const again = createGrenadeState(3);
    throwGrenade(again, req('decoy', { decoyShotIntervalSec: 0.1 }), flat, cfg);
    expect(JSON.stringify(run(again, flat, [pawn('ct', 'CT', 700, 0)], 64 * 25))).toBe(JSON.stringify(ev));
  });
});
