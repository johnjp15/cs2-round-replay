/**
 * Public CS2 Mirage lineups (cs2util.com, each page's `setpos … ;setang …` command; setpos z is the eye height,
 * CS2's getpos convention) and the recorded round's utility, run through the engine on the Mirage mesh.
 */
import { readFileSync } from 'node:fs';
import { jumpThrowPose, simulateThrow, type GrenadeEvent, type GrenadeType } from '../../src/engine/grenades/index';
import type { GrenadeCs2Tuning, Vec3 } from '../../src/contracts/index';
import type { MirageWorld } from './mirage-world';

export interface Lineup {
  readonly name: string;
  readonly url: string;
  readonly type: GrenadeType;
  /** setpos (x, y, eye z) and setang (pitch, yaw). */
  readonly setpos: readonly [number, number, number];
  readonly setang: readonly [number, number];
  readonly jump: boolean;
  /** The callout it targets (2020 nav place name) and, where measurable on the mesh, a reference point. */
  readonly expectPlace: string;
  readonly expectSpot: Vec3 | null;
  /** Tolerance (units) around expectSpot. */
  readonly tolerance: number;
}

const U = 'https://www.cs2util.com/mirage/';

/** The asserted lineups (standing throws, one jump throw). */
export const LINEUPS: readonly Lineup[] = [
  {
    name: 'Window smoke from Top Mid cart',
    url: `${U}smoke/window-smoke-from-cart8`,
    type: 'smoke',
    setpos: [360.075439, -691.96875, -100.067307],
    setang: [-37.951241, 176.761139],
    jump: false,
    expectPlace: 'Snipers Nest',
    // Centre of the window opening on the mesh: the face x = −1088, open for y −725…−525, z −130…−60.
    expectSpot: { x: -1088, y: -625, z: -95 },
    tolerance: 120,
  },
  {
    name: 'Jungle smoke from Side Alley (jump throw)',
    url: `${U}smoke/jungle-smoke-from-side-alley`,
    type: 'smoke',
    setpos: [502.968445, -64.03125, -96.509933],
    setang: [-4.835793, -134.963165],
    jump: true,
    expectPlace: 'Jungle',
    expectSpot: null,
    tolerance: 0,
  },
  {
    name: 'Tetris molotov from Trash',
    url: `${U}molotov/tetris-molotov-from-trash`,
    type: 'molotov',
    setpos: [-889.295227, -2303.985596, -106.69162],
    setang: [-20.295094, 46.435417],
    jump: false,
    expectPlace: 'Bombsite A',
    expectSpot: null,
    tolerance: 0,
  },
  {
    name: 'Default molotov from Stairs',
    url: `${U}molotov/default-molotov-from-stairs`,
    type: 'molotov',
    setpos: [-618.031494, -1254.487183, -104.128754],
    setang: [-13.612561, -71.647865],
    jump: false,
    expectPlace: 'Bombsite A',
    expectSpot: null,
    tolerance: 0,
  },
  {
    name: 'Bench molotov from B Apartments',
    url: `${U}molotov/bench-molotov-from-b-apartments`,
    type: 'molotov',
    setpos: [-1393.263794, 807.968689, -14.749435],
    setang: [-7.920142, -148.512177],
    jump: false,
    expectPlace: 'Bombsite B',
    expectSpot: null,
    tolerance: 0,
  },
  {
    name: 'B flash from B Apartments window',
    url: `${U}flash/b-flash-from-b-apartments-window`,
    type: 'flash',
    setpos: [-1471.972412, 664.031372, 15.87125],
    setang: [-5.774949, 110.639763],
    jump: false,
    expectPlace: 'Bombsite B',
    expectSpot: null,
    tolerance: 0,
  },
];

/** Long T-spawn jump throws that thread past geometry: reported, not asserted (docs/grenades.md, Lineups). */
export const REPORTED: readonly Lineup[] = [
  {
    name: 'Window smoke from T Spawn trash can (jump throw)',
    url: `${U}smoke/window-smoke-from-t-spawn-trash-can`,
    type: 'smoke',
    setpos: [1422.954834, 36.46875, -103.96875],
    setang: [-22.665312, -166.39566],
    jump: true,
    expectPlace: 'Snipers Nest',
    expectSpot: { x: -1088, y: -625, z: -95 },
    tolerance: 120,
  },
  {
    name: 'Stairs smoke from T Spawn (jump throw)',
    url: `${U}smoke/stairs-smoke-from-t-spawn1`,
    type: 'smoke',
    setpos: [1422.96875, -248.031311, -104.128754],
    setang: [-39.773537, -145.216415],
    jump: true,
    expectPlace: 'Stairs',
    expectSpot: null,
    tolerance: 0,
  },
];

export interface Landing {
  readonly pos: Vec3;
  readonly sec: number;
  readonly bounces: number;
  readonly events: GrenadeEvent[];
}

export function runLineup(l: Pick<Lineup, 'type' | 'setpos' | 'setang' | 'jump'>, world: MirageWorld, t: GrenadeCs2Tuning, strength = 1): Landing {
  const eye0 = { x: l.setpos[0], y: l.setpos[1], z: l.setpos[2] };
  const pose = l.jump ? jumpThrowPose(eye0, { x: 0, y: 0 }, t) : { eye: eye0, velocity: { x: 0, y: 0, z: 0 } };
  const r = simulateThrow({ type: l.type, thrower: 'p', team: 'T', eye: pose.eye, pitch: l.setang[0], yaw: l.setang[1], strength, velocity: pose.velocity }, world, { tuning: t });
  if (r.detonation === null) throw new Error('no detonation');
  return { pos: r.detonation.pos, sec: r.ticks / 64, bounces: r.events.filter((e) => e.type === 'bounce').length, events: r.events };
}

interface NavArea {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z1: number;
  z2: number;
  place: number;
}

/** Named 2020-nav places (CS:GO callouts) with an area within `r` units (xy) of the point and within `dz` of its height. */
export function placesNear(p: Vec3, r = 48, dz = 160): string[] {
  const nav = JSON.parse(readFileSync(new URL('../../data/mirage-nav.json', import.meta.url), 'utf8')) as { places: string[]; areas: NavArea[] };
  const out = new Set<string>();
  for (const a of nav.areas) {
    const qx = Math.max(a.x1 - p.x, 0, p.x - a.x2);
    const qy = Math.max(a.y1 - p.y, 0, p.y - a.y2);
    if (qx * qx + qy * qy > r * r) continue;
    if (Math.abs(p.z - (a.z1 + a.z2) / 2) > dz) continue;
    const name = nav.places[a.place] ?? '';
    if (name !== '') out.add(name);
  }
  return [...out].sort();
}

export interface RecordedThrow {
  readonly t: number;
  readonly thrower: string;
  readonly kind: 'smoke' | 'flash' | 'he' | 'molotov';
  readonly place: string;
  readonly throwPos: Vec3;
}

export function recordedUtility(): RecordedThrow[] {
  const round = JSON.parse(readFileSync(new URL('../../data/round.json', import.meta.url), 'utf8')) as { utility: RecordedThrow[] };
  return round.utility;
}

/** The B-site floor 64 units in front of the Market window (window centre (−1921, −264, −90) on the mesh). */
export const MARKET_WINDOW_FRONT: Vec3 = { x: -1921, y: -200, z: -166 };

/**
 * Plausible aim for each recorded throw (the recording has only the thrower's spot): a target point; the pitch is
 * the one in −45…+10 (5° steps) whose detonation lands nearest the target. Assumptions, not data:
 * docs/grenades.md (Recorded utility).
 */
export const RECORDED_AIM: readonly { target: Vec3; why: string }[] = [
  { target: { x: -1300, y: 830, z: -80 }, why: 'cart, Back Alley: smoke west down the Apartments approach' },
  { target: { x: 300, y: -1600, z: -200 }, why: 'snarlbot, Palace Alley: smoke toward the A ramp' },
  { target: { x: 300, y: -1600, z: -200 }, why: 'snarlbot, Palace Alley: flash over the ramp' },
  { target: { x: -900, y: 640, z: -80 }, why: 'donk, Back Alley: flash ahead into the Apartments corridor' },
  { target: { x: -1800, y: 600, z: -100 }, why: 'barely, Apartments: HE toward the B balcony / truck' },
  { target: { x: -1700, y: 800, z: -60 }, why: 'donk, Apartments: molotov down the corridor to the exit' },
  // John (backlog 21): cart's smoke blocks the Market window. The window on the mesh: wall face y = −264, open over
  // x −1948…−1894, z −126 (sill) up; the target is the B-site floor 64 in front of it.
  { target: MARKET_WINDOW_FRONT, why: 'cart, B site: smoke onto the Market window' },
  { target: { x: -2250, y: 0, z: -160 }, why: 'barely, B site: smoke toward the CT / Market side' },
];

/**
 * The recorded spot is often inside a wall (docs/geometry.md (b)): stand on the nearest free floor within 64 units
 * (a standing hull that fits on walkable ground within 24 of the recorded height), searched on a 4-unit grid.
 */
export function freeStand(p: Vec3, world: MirageWorld): Vec3 {
  const g = world.geo;
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let dy = -64; dy <= 64; dy += 4) {
    for (let dx = -64; dx <= 64; dx += 4) {
      const d = Math.hypot(dx, dy);
      if (d >= bestD || d > 64) continue;
      const f = g.floorBelow(p.x + dx, p.y + dy, p.z + 24, 16, 0, 48);
      if (f === null || !f.walkable || g.hullBlocked(p.x + dx, p.y + dy, f.z + 0.05)) continue;
      best = { x: p.x + dx, y: p.y + dy, z: f.z };
      bestD = d;
    }
  }
  return best ?? p;
}

export function runRecorded(u: RecordedThrow, aim: { target: Vec3 }, world: MirageWorld, t: GrenadeCs2Tuning): Landing & { stand: Vec3; pitch: number; yaw: number; miss: number } {
  const stand = freeStand(u.throwPos, world);
  const eye = { x: stand.x, y: stand.y, z: stand.z + t.eyeHeight };
  const yaw = (Math.atan2(aim.target.y - eye.y, aim.target.x - eye.x) * 180) / Math.PI;
  let best: (Landing & { stand: Vec3; pitch: number; yaw: number; miss: number }) | null = null;
  for (let pitch = -45; pitch <= 10; pitch += 5) {
    const r = runLineup({ type: u.kind, setpos: [eye.x, eye.y, eye.z], setang: [pitch, yaw], jump: false }, world, t);
    const miss = Math.hypot(r.pos.x - aim.target.x, r.pos.y - aim.target.y);
    if (best === null || miss < best.miss) best = { ...r, stand, pitch, yaw, miss };
  }
  if (best === null) throw new Error('no throw');
  return best;
}
