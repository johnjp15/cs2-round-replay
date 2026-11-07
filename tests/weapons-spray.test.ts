/**
 * H2 acceptance for shooting: the AK-47 30-bullet spray as CS2 produces it (fixed recoil pattern + the per-shot
 * inaccuracy/spread cone), recoil control by pulling against the pattern, the camera / crosshair split, and first-shot
 * accuracy and recovery after moving, jumping and landing. docs/weapons.md, "Spraying".
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng, parseTuning } from '../src/contracts/index';
import {
  armsContext,
  cameraAngles,
  crosshairAngles,
  freshArms,
  inaccuracy,
  movementScale,
  parseWeaponTable,
  stepArms,
  weaponDef,
  type Angle2,
  type ArmsState,
  type Motion,
} from '../src/engine/weapons/index';

const readText = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const table = parseWeaponTable(JSON.parse(readText('../data/weapons.json')) as unknown);
const tuning = parseTuning(readText('../data/tuning.json'));
const ctx = armsContext(table, tuning, 64);
const ak = weaponDef(table, 'ak47');
const pattern = table.sprays['ak47'] ?? [];
const still: Motion = { velocity: { x: 0, y: 0, z: 0 }, onGround: true, crouched: false, onLadder: false };
const DEG = 180 / Math.PI;
const WALL = 1024;

interface Impact {
  /** Bullet direction as Source pitch / yaw, degrees. */
  readonly pitch: number;
  readonly yaw: number;
  readonly inacc: number;
}

/** One full AK magazine held from tick 0; `control` pulls the view against the pattern before each bullet. */
function spray(seed: number, control: boolean): Impact[] {
  let s: ArmsState = freshArms(ctx, 'ak47', -1000);
  const rng = new Rng(seed);
  const out: Impact[] = [];
  for (let t = 0; out.length < 30 && t < 400; t++) {
    const p = pattern[out.length] as readonly [number, number];
    const view: Angle2 = control ? { pitch: -p[0], yaw: -p[1] } : { pitch: 0, yaw: 0 };
    const r = stepArms(ctx, s, { tick: t, attack: true, attack2: false, reload: false, view, motion: still }, rng);
    s = r.state;
    if (r.shot !== null) {
      const d = r.shot.pellets[0];
      if (d === undefined) throw new Error('no pellet');
      out.push({ pitch: -Math.asin(d.z) * DEG, yaw: Math.atan2(d.y, d.x) * DEG, inacc: r.shot.inaccuracy });
    }
  }
  return out;
}

/** E|r1·I·e^{iθ1} + r2·S·e^{iθ2}|, r and θ uniform (midpoint rule). */
function meanCone(I: number, S: number): number {
  const n = 60;
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

const N = 1000;
const free = Array.from({ length: N }, (_, k) => spray(1000 + k, false));
const controlled = Array.from({ length: N }, (_, k) => spray(1000 + k, true));

function stats(runs: Impact[][], i: number): { pitch: number; yaw: number; disp: number; maxDev: number } {
  const pitch = runs.reduce((a, r) => a + (r[i] as Impact).pitch, 0) / runs.length;
  const yaw = runs.reduce((a, r) => a + (r[i] as Impact).yaw, 0) / runs.length;
  let disp = 0;
  let maxDev = 0;
  for (const r of runs) {
    const b = r[i] as Impact;
    const dev = (Math.hypot(b.pitch - pitch, b.yaw - yaw) / DEG) * WALL;
    disp += dev;
    maxDev = Math.max(maxDev, dev);
  }
  return { pitch, yaw, disp: disp / runs.length, maxDev };
}

describe('AK-47 spray: 1,000 seeded magazines at a wall 1,024 units away, standing still', () => {
  it('per bullet, the mean impact is the recoil pattern (within 0.1°) and the dispersion is the inaccuracy cone of that bullet (within 6 %)', () => {
    expect(pattern.length).toBe(30);
    for (let i = 0; i < 30; i++) {
      const st = stats(free, i);
      const p = pattern[i] as readonly [number, number];
      expect(Math.abs(st.pitch - p[0]), `bullet ${i + 1} pitch`).toBeLessThan(0.1);
      expect(Math.abs(st.yaw - p[1]), `bullet ${i + 1} yaw`).toBeLessThan(0.1);
      const I = (free[0]?.[i] as Impact).inacc;
      // The inaccuracy doesn't depend on the RNG: identical in every run.
      for (const r of free) expect((r[i] as Impact).inacc).toBe(I);
      const expected = meanCone(I, ak.spread[0]) * WALL;
      expect(Math.abs(st.disp / expected - 1), `bullet ${i + 1} dispersion ${st.disp} vs ${expected}`).toBeLessThan(0.06);
      expect(st.maxDev).toBeLessThan(WALL * (I + ak.spread[0]) * 1.03 + 0.5);
    }
  });

  it("first bullet: CS2's standing AK-47 cone, 1,024 × (0.00641 + 0.0006) = 7.2 units max; from bullet ~8 on the cone settles at ~0.020 (≈ 21 u max, 10 u mean)", () => {
    expect((free[0]?.[0] as Impact).inacc).toBe(0.00641);
    for (let i = 7; i < 30; i++) {
      const I = (free[0]?.[i] as Impact).inacc;
      expect(I).toBeGreaterThan(0.0185);
      expect(I).toBeLessThan(0.0206);
    }
  });

  it('the cloud of mean impacts spans csstats.gg’s CS2 AK-47 envelope (11.06° × 7.14°) within 3 %', () => {
    const means = Array.from({ length: 30 }, (_, i) => stats(free, i));
    const h = Math.max(...means.map((m) => m.pitch)) - Math.min(...means.map((m) => m.pitch));
    const w = Math.max(...means.map((m) => m.yaw)) - Math.min(...means.map((m) => m.yaw));
    expect(Math.abs(h / 11.06 - 1)).toBeLessThan(0.03);
    expect(Math.abs(w / 7.14 - 1)).toBeLessThan(0.03);
  });
});

describe('recoil control: pulling the view against the mean pattern before each bullet', () => {
  const radii = (runs: Impact[][], from: number, to: number): number[] => {
    const r: number[] = [];
    for (const run of runs) for (let i = from; i < to; i++) r.push((Math.hypot((run[i] as Impact).pitch, (run[i] as Impact).yaw) / DEG) * WALL);
    return r.sort((a, b) => a - b);
  };
  const pct = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] as number;

  it('centres every bullet (mean within 0.06° of the aim point) and groups the first 10 bullets: median 7.2 u, 95 % within 18 u, all within 21 u at 1,024 u', () => {
    for (let i = 0; i < 30; i++) {
      const st = stats(controlled, i);
      expect(Math.hypot(st.pitch, st.yaw), `bullet ${i + 1}`).toBeLessThan(0.06);
    }
    const r = radii(controlled, 0, 10);
    expect(pct(r, 0.5)).toBeGreaterThan(6);
    expect(pct(r, 0.5)).toBeLessThan(8.5);
    expect(pct(r, 0.95)).toBeLessThan(18);
    expect(r[r.length - 1]).toBeLessThan(21);
  });

  it('without control the first 10 bullets climb out of that group (median ~94 u, 95 % ~173 u from the aim point)', () => {
    const r = radii(free, 0, 10);
    expect(pct(r, 0.5)).toBeGreaterThan(85);
    expect(pct(r, 0.95)).toBeGreaterThan(160);
  });

  it('the controlled group is the same as the inaccuracy cone alone: the pattern is fixed, only the cone is random', () => {
    for (let i = 0; i < 30; i++) {
      const a = stats(controlled, i).disp;
      const b = stats(free, i).disp;
      expect(Math.abs(a / b - 1), `bullet ${i + 1}`).toBeLessThan(0.02);
    }
  });
});

describe('camera, crosshair and punch', () => {
  it('after 10 bullets the crosshair (cl_crosshair_recoil) sits on the next bullet, the camera follows 45 % of it plus the screen shake', () => {
    let s = freshArms(ctx, 'ak47', -1000);
    const rng = new Rng(7);
    let shots = 0;
    let t = 0;
    for (; shots < 10; t++) {
      const r = stepArms(ctx, s, { tick: t, attack: true, attack2: false, reload: false, view: { pitch: 0, yaw: 0 }, motion: still }, rng);
      s = r.state;
      if (r.shot !== null) shots++;
    }
    const cross = crosshairAngles(ctx, s, { pitch: 0, yaw: 0 });
    const cam = cameraAngles(ctx, s, { pitch: 0, yaw: 0 });
    expect(cross.pitch).toBeLessThan(-8);
    expect(cam.pitch).toBeCloseTo(cross.pitch * 0.45 + s.punch.view.pitch, 5);
    // The next shot leaves along the crosshair (+ the cone).
    while (true) {
      const r = stepArms(ctx, s, { tick: t, attack: true, attack2: false, reload: false, view: { pitch: 0, yaw: 0 }, motion: still }, rng);
      if (r.shot !== null) {
        expect(Math.abs(r.shot.aim.pitch - crosshairAngles(ctx, s, { pitch: 0, yaw: 0 }).pitch)).toBeLessThan(0.6);
        break;
      }
      s = r.state;
      t++;
    }
  });
});

describe('first-shot accuracy and recovery', () => {
  const m = ctx.model;
  it('running inaccuracy thresholds: no movement penalty up to 34 % of the max speed (AK 73.1 u/s, AWP scoped 34 u/s), full from 95 %', () => {
    expect(movementScale(73.1, 215, m)).toBe(0);
    expect(movementScale(73.2, 215, m)).toBeGreaterThan(0);
    expect(inaccuracy(ak, 0, ak.inaccuracy.stand[0], { ...still, velocity: { x: 215, y: 0, z: 0 } }, m)).toBeCloseTo(0.18147, 9);
    const awp = weaponDef(table, 'awp');
    expect(movementScale(34, awp.maxSpeed[1], m)).toBe(0);
  });

  it('counter-strafing: the movement penalty is instantaneous, so a stopped AK is back to its standing cone on the next shot', () => {
    let s = freshArms(ctx, 'ak47', -1000);
    for (let t = 0; t < 32; t++) s = stepArms(ctx, s, { tick: t, attack: false, attack2: false, reload: false, view: { pitch: 0, yaw: 0 }, motion: { ...still, velocity: { x: 215, y: 0, z: 0 } } }, new Rng(1)).state;
    const r = stepArms(ctx, s, { tick: 32, attack: true, attack2: false, reload: false, view: { pitch: 0, yaw: 0 }, motion: still }, new Rng(1));
    expect(r.shot?.inaccuracy).toBe(0.00641);
  });

  it('jump and land: the take-off penalty (0.10094) decays during the flight; after landing the AK is back within 2 % of its standing cone in 0.75 s', () => {
    let s = freshArms(ctx, 'ak47', -1000);
    const g = tuning.movement.gravity;
    let vz = tuning.movement.jumpImpulse;
    let z = 0;
    let landTick = -1;
    const curve: number[] = [];
    for (let t = 0; t < 200; t++) {
      const air = landTick < 0;
      const motion: Motion = { velocity: { x: 0, y: 0, z: air ? vz : 0 }, onGround: !air, crouched: false, onLadder: false };
      s = stepArms(ctx, s, { tick: t, attack: false, attack2: false, reload: false, view: { pitch: 0, yaw: 0 }, motion }, new Rng(1)).state;
      curve.push(inaccuracy(ak, 0, s.penalty, motion, m));
      if (air) {
        z += vz / 64;
        vz -= g / 64;
        if (z <= 0) landTick = t + 1;
      }
    }
    expect(curve[0]).toBeGreaterThan(0.23); // take-off: 0.00641 + 0.10094 (one tick of decay) + 0.14076 × vertical-speed scale
    expect(Math.min(...curve.slice(20, 30))).toBeLessThan(0.02); // near the apex the air term is ~0
    expect(landTick).toBeGreaterThan(40);
    expect(curve[landTick + 48] as number).toBeLessThan(0.00641 * 1.02);
  });

  it('scoped: the AWP first shot is pinpoint scoped (cone 1,024 × (0.0013 + 0.0002) ≈ 1.5 u) and wide unscoped', () => {
    const awp = weaponDef(table, 'awp');
    const scoped = inaccuracy(awp, 1, awp.inaccuracy.stand[1], still, m) + awp.spread[1];
    const unscoped = inaccuracy(awp, 0, awp.inaccuracy.stand[0], still, m) + awp.spread[0];
    expect(scoped * 1024).toBeLessThan(4);
    expect(unscoped * 1024).toBeGreaterThan(50);
  });
});
