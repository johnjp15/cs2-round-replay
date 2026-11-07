/**
 * H2b acceptance, headless: an AK-47 sprayed in the 3D host (Sim3DHost) at a wall 1,024 units away lands like the
 * engine's spray model (tests/weapons-spray.test.ts): per bullet the mean impact is the recoil pattern and the scatter
 * the bullet's inaccuracy cone; pulling the view against the pattern groups the bullets; the camera and crosshair
 * kick and recover; the scope and the weapon max speeds (scoped AWP 100 u/s) reach the host's movement; a bullet goes
 * through a thin wall (less damage) and not a thick one; a hit tags the victim (slower, then recovers).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng, type Button, type PlayerId, type Vec3 } from '../src/contracts/index';
import { armsContext, freshArms, parseWeaponTable, stepArms, weaponDef, type ArmsState } from '../src/engine/weapons/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { Sim3DHost } from '../src/sim3d/index';
import { act, openNav, setupActions, tuning } from './combat-fixtures';

const table = parseWeaponTable(JSON.parse(readFileSync(new URL('../data/weapons.json', import.meta.url), 'utf8')) as unknown);
const pattern = table.sprays['ak47'] ?? [];
const ak = weaponDef(table, 'ak47');
const DEG = 180 / Math.PI;
const WALL = 1024;

/** World-unit triangles → a MapGeometry (1/8 unit, like the extractor). */
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

const E = 3000;
/** A floor at z 0 and a wall at x = 1,024 facing the shooter at the origin. */
const range = meshOf([
  [-E, -E, 0, E, -E, 0, E, E, 0],
  [-E, -E, 0, E, E, 0, -E, E, 0],
  [WALL, -E, -E, WALL, E, -E, WALL, E, E],
  [WALL, -E, -E, WALL, E, E, WALL, -E, E],
]);
const roster = [
  { id: 'cart' as PlayerId, team: 'T' as const },
  { id: 'sp4rtan' as PlayerId, team: 'CT' as const },
];

function newHost(seed: number, weapon = 'ak47'): Sim3DHost {
  const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed }, { movement: range, world: range });
  h.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, weapon), ...setupActions('sp4rtan', { x: -2000, y: 2000 }, 0, 'ak47')]));
  h.tick();
  h.setHuman('cart');
  return h;
}

interface Hit {
  readonly pitch: number;
  readonly yaw: number;
}

/** Hold ATTACK until 30 bullets hit the wall; `control` pulls the view against the pattern before each bullet. */
function spray3d(seed: number, control: boolean): Hit[] {
  const h = newHost(seed);
  const hits: Hit[] = [];
  for (let t = 0; hits.length < 30 && t < 400; t++) {
    const p = pattern[hits.length] as readonly [number, number];
    const view = control ? { pitch: -p[0], yaw: -p[1] } : { pitch: 0, yaw: 0 };
    h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: view.yaw, pitch: view.pitch, buttons: ['ATTACK'] });
    h.tick();
    for (const s of h.shots()) {
      if (s.shooter !== 'cart') continue;
      expect(s.wall).toBe(true);
      expect(s.to.x).toBeCloseTo(WALL, 0);
      const dz = s.to.z - s.from.z;
      const dy = s.to.y - s.from.y;
      const dx = s.to.x - s.from.x;
      hits.push({ pitch: -Math.atan2(dz, Math.hypot(dx, dy)) * DEG, yaw: Math.atan2(dy, dx) * DEG });
    }
  }
  return hits;
}

/** The engine's per-bullet inaccuracy of a standing AK spray (deterministic: it doesn't depend on the RNG). */
function engineInaccuracy(): number[] {
  const ctx = armsContext(table, tuning, 64);
  let s: ArmsState = freshArms(ctx, 'ak47', -1000);
  const rng = new Rng(1);
  const out: number[] = [];
  for (let t = 0; out.length < 30 && t < 400; t++) {
    const r = stepArms(ctx, s, { tick: t, attack: true, attack2: false, reload: false, view: { pitch: 0, yaw: 0 }, motion: { velocity: { x: 0, y: 0, z: 0 }, onGround: true, crouched: false, onLadder: false } }, rng);
    s = r.state;
    if (r.shot !== null) out.push(r.shot.inaccuracy);
  }
  return out;
}

/** E|r1·I·e^{iθ1} + r2·S·e^{iθ2}|, r and θ uniform (midpoint rule; tests/weapons-spray.test.ts). */
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

const N = 1000;
const free = Array.from({ length: N }, (_, k) => spray3d(5000 + k, false));
const controlled = Array.from({ length: N }, (_, k) => spray3d(5000 + k, true));

function meanOf(runs: Hit[][], i: number): Hit {
  return { pitch: runs.reduce((a, r) => a + (r[i] as Hit).pitch, 0) / runs.length, yaw: runs.reduce((a, r) => a + (r[i] as Hit).yaw, 0) / runs.length };
}
function scatterOf(runs: Hit[][], i: number): number {
  const m = meanOf(runs, i);
  return (runs.reduce((a, r) => a + Math.hypot((r[i] as Hit).pitch - m.pitch, (r[i] as Hit).yaw - m.yaw), 0) / runs.length / DEG) * WALL;
}

describe('AK-47 sprayed in the 3D host at a wall 1,024 u away (1,000 seeded magazines)', () => {
  it('fires 30 bullets at 600 rpm; bullet 1 is the standing cone (≤ 7.2 u from the aim point)', () => {
    expect(free.every((r) => r.length === 30)).toBe(true);
    for (const r of free) expect((Math.hypot((r[0] as Hit).pitch, (r[0] as Hit).yaw) / DEG) * WALL).toBeLessThan(7.3);
  });

  it('per bullet the mean impact is the pattern of data/weapons.json (within 0.1°, as tests/weapons-spray.test.ts)', () => {
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      const m = meanOf(free, i);
      const p = pattern[i] as readonly [number, number];
      expect(Math.abs(m.pitch - p[0]), `bullet ${i + 1} pitch`).toBeLessThan(0.1);
      expect(Math.abs(m.yaw - p[1]), `bullet ${i + 1} yaw`).toBeLessThan(0.1);
      worst = Math.max(worst, Math.abs(m.pitch - p[0]), Math.abs(m.yaw - p[1]));
    }
    console.log(`[3D spray] worst per-bullet mean error ${worst.toFixed(3)}°`);
  });

  it("per bullet the dispersion is that bullet's inaccuracy + spread cone, as the engine's (within 6 %, as tests/weapons-spray.test.ts)", () => {
    const I = engineInaccuracy();
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      const expected = meanCone(I[i] as number, ak.spread[0]) * WALL;
      const ratio = scatterOf(free, i) / expected;
      expect(Math.abs(ratio - 1), `bullet ${i + 1}: ${scatterOf(free, i).toFixed(2)} u vs ${expected.toFixed(2)} u`).toBeLessThan(0.06);
      worst = Math.max(worst, Math.abs(ratio - 1));
    }
    console.log(`[3D spray] dispersion: bullet 1 ${scatterOf(free, 0).toFixed(2)} u, bullet 30 ${scatterOf(free, 29).toFixed(2)} u; worst ratio error ${(worst * 100).toFixed(1)} %`);
  });

  it('recoil control: pulling against the pattern centres every bullet (within 0.06°) and groups bullets 1–10 (median ~7 u, 95 % within 18 u, all within 21 u)', () => {
    const r: number[] = [];
    for (let i = 0; i < 30; i++) {
      const m = meanOf(controlled, i);
      expect(Math.hypot(m.pitch, m.yaw), `bullet ${i + 1}`).toBeLessThan(0.06);
    }
    for (const run of controlled) for (let i = 0; i < 10; i++) r.push((Math.hypot((run[i] as Hit).pitch, (run[i] as Hit).yaw) / DEG) * WALL);
    r.sort((a, b) => a - b);
    const pct = (q: number): number => r[Math.min(r.length - 1, Math.floor(r.length * q))] as number;
    expect(pct(0.5)).toBeGreaterThan(6);
    expect(pct(0.5)).toBeLessThan(8.5);
    expect(pct(0.95)).toBeLessThan(18);
    expect(r[r.length - 1]).toBeLessThan(21);
    // Without control the same 10 bullets climb out of that group (median ~94 u; Valve's suppression slows bullets 2–8).
    const u: number[] = [];
    for (const run of free) for (let i = 0; i < 10; i++) u.push((Math.hypot((run[i] as Hit).pitch, (run[i] as Hit).yaw) / DEG) * WALL);
    u.sort((a, b) => a - b);
    expect(u[Math.floor(u.length / 2)]).toBeGreaterThan(85);
    let worst = 0;
    for (let i = 0; i < 30; i++) worst = Math.max(worst, Math.hypot(meanOf(controlled, i).pitch, meanOf(controlled, i).yaw));
    console.log(
      `[3D recoil control] bullets 1-10: median ${pct(0.5).toFixed(2)} u, 95 % ${pct(0.95).toFixed(2)} u, max ${(r[r.length - 1] as number).toFixed(2)} u; uncontrolled median ${(u[Math.floor(u.length / 2)] as number).toFixed(1)} u; worst mean offset ${worst.toFixed(3)}°`,
    );
  });
});

describe('camera, crosshair, scope and speed in the 3D host', () => {
  it('the camera and crosshair kick during a spray and recover after it', () => {
    const h = newHost(1);
    const view = { pitch: 0, yaw: 0 };
    const hold = (ticks: number, buttons: Button[]): void => {
      for (let i = 0; i < ticks; i++) {
        h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch: 0, buttons });
        h.tick();
      }
    };
    hold(64, ['ATTACK']);
    const during = h.aimView('cart', view);
    expect(during.crosshair.pitch).toBeLessThan(-8); // up
    expect(during.camera.pitch).toBeLessThan(-3);
    expect(during.camera.pitch).toBeGreaterThan(during.crosshair.pitch);
    hold(128, []);
    const after = h.aimView('cart', view);
    expect(Math.abs(after.crosshair.pitch)).toBeLessThan(0.01);
    expect(Math.abs(after.camera.pitch)).toBeLessThan(0.01);
  });

  it('AWP: mouse 2 scopes (FOV 40, then 10, from the weapon table); scoped the human runs at most 100 u/s', () => {
    const h = newHost(1, 'awp');
    const step = (buttons: Button[], forward = 0): Vec3 => {
      h.setHumanInput({ id: 'cart', forward, side: 0, yaw: 0, pitch: 0, buttons });
      h.tick();
      return h.observe().pawns.find((p) => p.id === 'cart')?.vel ?? { x: 0, y: 0, z: 0 };
    };
    for (let i = 0; i < 90; i++) step([]); // deploy
    step(['ATTACK2']);
    step([]);
    expect(h.aimView('cart', { pitch: 0, yaw: 0 })).toMatchObject({ zoom: 1, fov4x3: 40 });
    let v: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 128; i++) v = step([], 1);
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(100.001);
    expect(Math.hypot(v.x, v.y)).toBeGreaterThan(95);
    step(['ATTACK2'], 1);
    step([], 1);
    expect(h.aimView('cart', { pitch: 0, yaw: 0 })).toMatchObject({ zoom: 2, fov4x3: 10 });
    for (let i = 0; i < 8; i++) step([], 1); // the scope's cooldown (m_flZoomTime1)
    step(['ATTACK2'], 1);
    for (let i = 0; i < 128; i++) v = step([], 1);
    expect(h.aimView('cart', { pitch: 0, yaw: 0 }).zoom).toBe(0);
    expect(Math.hypot(v.x, v.y)).toBeGreaterThan(195); // unscoped AWP 200
  });
});

describe('wall penetration and tagging in the 3D host', () => {
  /** The range with a solid of `thick` units at x 500 between cart (origin) and Sp4rtaN (x 800). */
  function wallHost(thick: number): Sim3DHost {
    const a = 500;
    const b = 500 + thick;
    const g = meshOf([
      [-E, -E, 0, E, -E, 0, E, E, 0],
      [-E, -E, 0, E, E, 0, -E, E, 0],
      [a, -E, -E, a, E, -E, a, E, E],
      [a, -E, -E, a, E, E, a, -E, E],
      [b, -E, -E, b, E, -E, b, E, E],
      [b, -E, -E, b, E, E, b, -E, E],
    ]);
    const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed: 1 }, { movement: g, world: g });
    h.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, 'ak47'), ...setupActions('sp4rtan', { x: 800, y: 0 }, 180, 'ak47')]));
    h.tick();
    h.setHuman('cart');
    return h;
  }

  /** One AK bullet at Sp4rtaN's chest (eye 64 → chest 48 at 800 u): the damage events. */
  function oneShot(h: Sim3DHost): { amount: number; armor: number; scripted: boolean }[] {
    const pitch = Math.atan2(64 - 46, 800) * DEG;
    const out: { amount: number; armor: number; scripted: boolean }[] = [];
    for (let t = 0; t < 4; t++) {
      h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch, buttons: t === 0 ? ['ATTACK'] : [] });
      h.tick();
      for (const e of h.observe().events) if (e.type === 'damage' && e.victim === 'sp4rtan') out.push({ amount: e.amount, armor: e.armor, scripted: e.scripted });
    }
    return out;
  }

  it('an AK bullet goes through 8 u of wall (less damage than in the open) and not through 120 u', () => {
    const open = oneShot(newHostAt800());
    const thin = oneShot(wallHost(8));
    const thick = oneShot(wallHost(120));
    expect(open).toHaveLength(1);
    expect(thin).toHaveLength(1);
    expect(thin[0]?.scripted).toBe(false);
    expect(thin[0]?.amount).toBeGreaterThan(0);
    expect(thin[0]?.amount).toBeLessThan(open[0]?.amount ?? 0);
    expect(thick).toHaveLength(0);
    console.log(`[3D wallbang] AK at 800 u, chest, armored: open ${open[0]?.amount} hp, through 8 u ${thin[0]?.amount} hp, through 120 u none`);
  });

  it('a hit tags the victim: right after it Sp4rtaN (now the human) runs slower than untouched, and recovers', () => {
    const run = (hit: boolean): number[] => {
      const h = newHostAt800();
      if (hit) expect(oneShot(h)).toHaveLength(1);
      else for (let t = 0; t < 4; t++) h.tick();
      h.setHuman('sp4rtan');
      const v: number[] = [];
      for (let t = 0; t < 192; t++) {
        h.setHumanInput({ id: 'sp4rtan', forward: 1, side: 0, yaw: 90, pitch: 0, buttons: [] });
        h.tick();
        const p = h.observe().pawns.find((q) => q.id === 'sp4rtan');
        v.push(Math.hypot(p?.vel.x ?? 0, p?.vel.y ?? 0));
      }
      return v;
    };
    const tagged = run(true);
    const clean = run(false);
    console.log(`[3D tagging] speed after 5/10/20/40/191 ticks: tagged ${[5, 10, 20, 40, 191].map((i) => (tagged[i] as number).toFixed(1)).join(" / ")}, clean ${[5, 10, 20, 40, 191].map((i) => (clean[i] as number).toFixed(1)).join(" / ")}`);
    expect(tagged[10] as number).toBeLessThan((clean[10] as number) * 0.9);
    expect(Math.abs((tagged[191] as number) - (clean[191] as number))).toBeLessThan(1);
  });
});

function newHostAt800(): Sim3DHost {
  const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed: 1 }, { movement: range, world: range });
  h.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, 'ak47'), ...setupActions('sp4rtan', { x: 800, y: 0 }, 180, 'ak47')]));
  h.tick();
  h.setHuman('cart');
  return h;
}
