/**
 * H2b acceptance, headless: an AK-47 sprayed in the 3D host (Sim3DHost) at a wall 1,024 units away lands like the
 * engine's spray model (tests/weapons-spray.test.ts): per bullet the mean impact is the recoil pattern and the scatter
 * the bullet's inaccuracy cone; pulling the view against the pattern groups the bullets; the camera and crosshair
 * kick and recover; the scope and the weapon max speeds (scoped AWP 100 u/s) reach the host's movement.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Button, type PlayerId, type Vec3 } from '../src/contracts/index';
import { parseWeaponTable } from '../src/engine/weapons/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { Sim3DHost } from '../src/sim3d/index';
import { act, openNav, setupActions, tuning } from './combat-fixtures';

const table = parseWeaponTable(JSON.parse(readFileSync(new URL('../data/weapons.json', import.meta.url), 'utf8')) as unknown);
const pattern = table.sprays['ak47'] ?? [];
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

const N = 300;
const free = Array.from({ length: N }, (_, k) => spray3d(5000 + k, false));
const controlled = Array.from({ length: N }, (_, k) => spray3d(5000 + k, true));

function meanOf(runs: Hit[][], i: number): Hit {
  return { pitch: runs.reduce((a, r) => a + (r[i] as Hit).pitch, 0) / runs.length, yaw: runs.reduce((a, r) => a + (r[i] as Hit).yaw, 0) / runs.length };
}
function scatterOf(runs: Hit[][], i: number): number {
  const m = meanOf(runs, i);
  return (runs.reduce((a, r) => a + Math.hypot((r[i] as Hit).pitch - m.pitch, (r[i] as Hit).yaw - m.yaw), 0) / runs.length / DEG) * WALL;
}

describe('AK-47 sprayed in the 3D host at a wall 1,024 u away (300 seeded magazines)', () => {
  it('fires 30 bullets at 600 rpm; bullet 1 is the standing cone (≤ 7.2 u from the aim point)', () => {
    expect(free.every((r) => r.length === 30)).toBe(true);
    for (const r of free) expect((Math.hypot((r[0] as Hit).pitch, (r[0] as Hit).yaw) / DEG) * WALL).toBeLessThan(7.3);
  });

  it('per bullet the mean impact is the pattern of data/weapons.json (within 0.15°)', () => {
    for (let i = 0; i < 30; i++) {
      const m = meanOf(free, i);
      const p = pattern[i] as readonly [number, number];
      expect(Math.abs(m.pitch - p[0]), `bullet ${i + 1} pitch`).toBeLessThan(0.15);
      expect(Math.abs(m.yaw - p[1]), `bullet ${i + 1} yaw`).toBeLessThan(0.15);
    }
  });

  it('the scatter grows from ~3.3 u (bullet 1) to ~10 u (bullets 8–30), as in the engine test', () => {
    expect(scatterOf(free, 0)).toBeGreaterThan(2.9);
    expect(scatterOf(free, 0)).toBeLessThan(3.7);
    for (let i = 7; i < 30; i++) {
      expect(scatterOf(free, i), `bullet ${i + 1}`).toBeGreaterThan(8.8);
      expect(scatterOf(free, i), `bullet ${i + 1}`).toBeLessThan(11.4);
    }
  });

  it('recoil control: pulling against the pattern centres every bullet and groups bullets 1–10 (median ~7 u, all within 21 u)', () => {
    const r: number[] = [];
    for (let i = 0; i < 30; i++) {
      const m = meanOf(controlled, i);
      expect(Math.hypot(m.pitch, m.yaw), `bullet ${i + 1}`).toBeLessThan(0.1);
    }
    for (const run of controlled) for (let i = 0; i < 10; i++) r.push((Math.hypot((run[i] as Hit).pitch, (run[i] as Hit).yaw) / DEG) * WALL);
    r.sort((a, b) => a - b);
    expect(r[Math.floor(r.length / 2)]).toBeGreaterThan(6);
    expect(r[Math.floor(r.length / 2)]).toBeLessThan(8.5);
    expect(r[r.length - 1]).toBeLessThan(21);
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
