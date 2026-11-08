/**
 * W3, headless in the 3D host (Sim3DHost): what the renderer's tracers and impacts are drawn from.
 * - tracers: 1 in TracerFrequency (weapons.vdata m_nTracerFrequency; AK: bullets 3, 6, 9, … of the magazine; Deagle
 *   every bullet);
 * - impacts: the wall's hit point and normal, entry / exit of a thin wall then the wall that stops the bullet, flesh
 *   on a hit.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlayerId, Vec3 } from '../src/contracts/index';
import { parseWeaponTable, weaponDef } from '../src/engine/weapons/index';
import { MapGeometry } from '../src/sim2d/geometry';
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

describe('W3: tracers and impacts in the shot results', () => {
  function spray(weapon: string, n: number, g = range): Shot3[] {
    const h = host(1, g, weapon);
    const out: Shot3[] = [];
    for (let t = 0; out.length < n && t < 600; t++) {
      h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch: 0, buttons: t % 2 === 0 || weapon === 'ak47' ? ['ATTACK'] : [] });
      h.tick();
      out.push(...h.shots().filter((s) => s.shooter === 'cart'));
    }
    return out;
  }

  it('AK-47: a tracer on bullets 3, 6, 9 … of the magazine (TracerFrequency 3); Deagle: every bullet (1)', () => {
    expect(ak.tracerFrequency).toBe(3);
    const a = spray('ak47', 12);
    expect(a.map((s) => s.tracer)).toEqual([false, false, true, false, false, true, false, false, true, false, false, true]);
    const d = spray('deagle', 4);
    expect(d.map((s) => s.tracer)).toEqual([true, true, true, true]);
  });

  it('a bullet into a wall: one wall impact at the hit point, normal facing the shooter', () => {
    const s = spray('ak47', 1)[0] as Shot3;
    expect(s.impacts).toHaveLength(1);
    const im = s.impacts[0];
    expect(im?.kind).toBe('wall');
    expect(im?.pos).toEqual(s.to);
    expect(im?.pos.x).toBeCloseTo(WALL, 3);
    expect(im?.normal).toEqual({ x: -1, y: 0, z: 0 });
  });

  it('through a thin wall: entry, exit (normal facing on), then the wall that stops it', () => {
    const g = meshOf([...floor, ...wallAt(500), ...wallAt(508), ...wallAt(WALL)]);
    const s = spray('ak47', 1, g)[0] as Shot3;
    expect(s.impacts.map((i) => i.kind)).toEqual(['wall', 'exit', 'wall']);
    expect(s.impacts.map((i) => Math.round(i.pos.x))).toEqual([500, 508, WALL]);
    expect(s.impacts[1]?.normal).toEqual({ x: 1, y: 0, z: 0 });
    expect(s.impacts[2]?.normal).toEqual({ x: -1, y: 0, z: 0 });
  });

  it('a hit on a pawn: a flesh impact at the hitbox entry, facing the shooter', () => {
    const h = host(1, range, 'ak47', { sp4rtan: { x: 400, y: 0, z: 0 } });
    const pitch = Math.atan2(64 - 48, 400) * DEG;
    let s: Shot3 | undefined;
    for (let t = 0; s === undefined && t < 8; t++) {
      h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch, buttons: ['ATTACK'] });
      h.tick();
      s = h.shots().find((q) => q.shooter === 'cart');
    }
    expect(s?.victim).toBe('sp4rtan');
    expect(s?.impacts.map((i) => i.kind)).toEqual(['flesh']);
    expect(s?.impacts[0]?.pos).toEqual(s?.to);
    expect(s?.impacts[0]?.normal.x).toBeLessThan(-0.99);
  });
});
