/**
 * V1 end-to-end helpers: synthetic ranges (a floor and a wall as a CS2 collision mesh), a Sim3DHost with a human
 * pawn on them, and small statistics. Everything goes through the 3D host (src/sim3d) the way the 3D app drives it
 * (`setHumanInput` + `tick`), so these measure what a player of the 3D game gets, not only the pure modules.
 */
import { readFileSync } from 'node:fs';
import { parseTuning, type Act, type Action, type Button, type PawnInput, type PlayerId, type Tuning } from '../../src/contracts/index';
import { MapGeometry } from '../../src/sim2d/geometry';
import { NavMesh, navOptionsFromTuning } from '../../src/sim2d/nav';
import { Sim3DHost } from '../../src/sim3d/index';

export const ROOT = new URL('../../', import.meta.url);
export const tuning: Tuning = parseTuning(JSON.parse(readFileSync(new URL('data/tuning.json', ROOT), 'utf8')) as unknown);
export const weaponsJson: unknown = JSON.parse(readFileSync(new URL('data/weapons.json', ROOT), 'utf8')) as unknown;
export const DEG = 180 / Math.PI;

/** World-unit triangles → a MapGeometry (1/8 unit, as the extractor). */
export function meshOf(tris: number[][]): MapGeometry {
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

export const floorQuad = (x0: number, y0: number, x1: number, y1: number, z: number): number[][] => [
  [x0, y0, z, x1, y0, z, x1, y1, z],
  [x0, y0, z, x1, y1, z, x0, y1, z],
];
export const wallX = (x: number, y0: number, y1: number, z0: number, z1: number): number[][] => [
  [x, y0, z0, x, y1, z0, x, y1, z1],
  [x, y0, z0, x, y1, z1, x, y0, z1],
];

const E = 6000;
/** A flat floor at z 0 (±6,000) and, optionally, a wall at x = `wall` facing a shooter at the origin. */
const rangeCache = new Map<string, MapGeometry>();
export function range(wall: number | null): MapGeometry {
  const key = String(wall);
  const hit = rangeCache.get(key);
  if (hit !== undefined) return hit;
  const g = meshOf([...floorQuad(-E, -E, E, E, 0), ...(wall === null ? [] : wallX(wall, -E, E, -E, E))]);
  rangeCache.set(key, g);
  return g;
}

/** One flat nav area (the Core/2D side of the host only needs it for the 2D sight and grenades). */
export const openNav = new NavMesh({ places: ['Open'], areas: [{ id: 0, x1: -6000, y1: -6000, x2: 6000, y2: 6000, z1: 0, z2: 0, place: 0 }] }, navOptionsFromTuning(tuning));

export function act(actions: readonly Action[]): Act {
  return { inputs: [], actions, status: [] };
}

export function setup(id: PlayerId, pos: { x: number; y: number; z?: number }, yaw: number, weapon: string, opts: { hp?: number; armor?: number; helmet?: boolean } = {}): Action[] {
  const w = tuning.weapons[weapon];
  const clip = w?.clip ?? 30;
  return [
    { type: 'teleport', id, pos: { x: pos.x, y: pos.y, z: pos.z ?? 0 }, yaw },
    { type: 'set_hp', id, hp: opts.hp ?? 100, armor: opts.armor ?? 100, helmet: opts.helmet ?? true },
    { type: 'give', id, item: weapon as Extract<Action, { type: 'give' }>['item'], clip, reserve: w?.reserve ?? 90 },
    { type: 'set_weapon', id, weapon: weapon as Extract<Action, { type: 'set_weapon' }>['weapon'] },
  ];
}

export const HUMAN = 'cart' as PlayerId;
export const TARGET = 'sp4rtan' as PlayerId;
const ROSTER = [
  { id: HUMAN, team: 'T' as const },
  { id: TARGET, team: 'CT' as const },
];

export interface RangeOpts {
  readonly weapon?: string;
  readonly wall?: number | null;
  readonly geometry?: MapGeometry;
  /** Where the CT stands (default far off the line of fire) and his armor. */
  readonly target?: { x: number; y: number; z?: number; yaw?: number; armor?: number; helmet?: boolean; hp?: number };
  readonly t?: Tuning;
}

/** A Sim3DHost with cart (the human, at the origin facing +x) and sp4rtan; deploys and lets the weapon get ready. */
export function rangeHost(seed: number, o: RangeOpts = {}): Sim3DHost {
  const g = o.geometry ?? range(o.wall === undefined ? 1024 : o.wall);
  const h = new Sim3DHost(openNav, o.t ?? tuning, ROSTER, null, { mask: null, seed }, { movement: g, world: g });
  const tg = o.target ?? { x: -3000, y: 3000 };
  h.apply(
    act([
      ...setup(HUMAN, { x: 0, y: 0 }, 0, o.weapon ?? 'ak47'),
      ...setup(TARGET, { x: tg.x, y: tg.y, z: tg.z ?? 0 }, tg.yaw ?? 180, 'ak47', {
        armor: tg.armor ?? 100,
        helmet: tg.helmet ?? true,
        hp: tg.hp ?? 100,
      }),
    ]),
  );
  h.tick();
  h.setHuman(HUMAN);
  return h;
}

export function input(o: { forward?: number; side?: number; yaw?: number; pitch?: number; buttons?: Button[] } = {}): PawnInput {
  return { id: HUMAN, forward: o.forward ?? 0, side: o.side ?? 0, yaw: o.yaw ?? 0, pitch: o.pitch ?? 0, buttons: o.buttons ?? [] };
}

/** Angles (pitch + = down, yaw + = left, degrees) of a shot from its eye to its impact. */
export function shotAngles(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): { pitch: number; yaw: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { pitch: -Math.atan2(dz, Math.hypot(dx, dy)) * DEG, yaw: Math.atan2(dy, dx) * DEG };
}

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i] as number;
}
export const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '–');

/** A markdown table. */
export function table(head: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const line = (r: readonly (string | number)[]): string => `| ${r.map(String).join(' | ')} |`;
  return [line(head), line(head.map((_h, i) => (i === 0 ? '---' : '---:'))), ...rows.map(line)].join('\n');
}

/** Degrees → units at a distance (the radius a cone of that half-angle makes at `d`). */
export const unitsAt = (deg: number, d: number): number => Math.tan(deg / DEG) * d;
