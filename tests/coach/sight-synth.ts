/**
 * K6 test helpers: a tiny box map (a floor and one wall) as a `MapGeometry`, and ten-player demos with a row every
 * tick on it. a1 (slot 0) and b1 (slot 5) stand on either side of the wall; everyone else is parked far away (beyond
 * the sightings' maxDistance), so only the pairs a test sets up can see each other.
 *
 *     y
 *     ^      a1 PEEK (-300, 1200)          b1 PEEK (300, 1200)
 *     |
 *     |      a1 COVER (-300, 0)  | wall |  b1 COVER (300, 0)       wall: x = 0, y −500…500, z 0…200
 *     +-----------------------------------------------> x
 */
import { createContext, type AnalysisContext } from '../../src/coach/analyze/context';
import { LosWorld } from '../../src/coach/derive/los';
import type { Match } from '../../src/coach/model/match';
import { rowAtOrAfter, type RawDemo } from '../../src/coach/model/raw';
import { MapGeometry, type GeometryMesh } from '../../src/sim2d/geometry';
import { armAll, finish, setPos, tenPlayers } from './k4-helpers';

export const A1 = 0;
export const A2 = 1;
export const B1 = 5;
export const B2 = 6;
export const A_COVER: [number, number] = [-300, 0];
export const A_PEEK: [number, number] = [-300, 1200];
export const B_COVER: [number, number] = [300, 0];
export const B_PEEK: [number, number] = [300, 1200];

/** Floor at z 0 over ±6000 and the wall across x = 0. */
export function boxWorld(): LosWorld {
  const quads: [number, number, number][][] = [
    [[-6000, -6000, 0], [6000, -6000, 0], [6000, 6000, 0], [-6000, 6000, 0]],
    [[0, -500, 0], [0, 500, 0], [0, 500, 200], [0, -500, 200]],
  ];
  const verts: number[] = [];
  const tris: number[] = [];
  for (const q of quads) {
    const base = verts.length / 3;
    for (const p of q) verts.push(p[0], p[1], p[2]);
    tris.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const m: GeometryMesh = { quant: 1, verts: Int32Array.from(verts), tris: Int32Array.from(tris) };
  return new LosWorld(new MapGeometry(m));
}

/** Rounds of 1000 ticks from 100 (freeze end +100, end +900), a row every tick; a1 and b1 in cover, the rest parked. */
export function sightDemo(rounds = 1): RawDemo {
  const raw = tenPlayers(rounds, {}, 1);
  armAll(raw);
  for (let p = 0; p < 10; p++) {
    if (p === A1 || p === B1) continue;
    if (p < 5) setPos(raw, p, 0, Infinity, -5000, -5000 + p * 60);
    else setPos(raw, p, 0, Infinity, 5000, 5000 + p * 60);
  }
  setPos(raw, A1, 0, Infinity, A_COVER[0], A_COVER[1]);
  setPos(raw, B1, 0, Infinity, B_COVER[0], B_COVER[1]);
  return raw;
}

export function row(raw: RawDemo, tick: number): number {
  return rowAtOrAfter(raw.ticks, tick);
}

/** View angles of p over [from, to] toward q's head point (as posed at `from`), plus offsets: up / right = where the head is relative to the crosshair (+ = above / right of it). */
export function look(raw: RawDemo, world: LosWorld, p: number, from: number, to: number, q: number, up = 0, right = 0): void {
  const P = raw.players.length;
  const T = raw.ticks;
  const r = row(raw, from);
  const i = r * P + p;
  const j = r * P + q;
  const eye = world.eyePosition({ x: T.x[i] ?? 0, y: T.y[i] ?? 0, z: T.z[i] ?? 0 }, 0);
  const head = world.bodyPoint({ x: T.x[j] ?? 0, y: T.y[j] ?? 0, z: T.z[j] ?? 0, yaw: T.yaw[j] ?? 0, duck: 0 }, 0);
  const pitch = (-Math.atan2(head.z - eye.z, Math.hypot(head.x - eye.x, head.y - eye.y)) * 180) / Math.PI;
  const yaw = (Math.atan2(head.y - eye.y, head.x - eye.x) * 180) / Math.PI;
  setView(raw, p, from, to, pitch + up, yaw + right);
}

export function setView(raw: RawDemo, p: number, from: number, to: number, pitch: number, yaw: number): void {
  const P = raw.players.length;
  for (let t = row(raw, from); t < raw.ticks.count && (raw.ticks.tick[t] ?? 0) <= to; t++) {
    raw.ticks.pitch[t * P + p] = pitch;
    raw.ticks.yaw[t * P + p] = yaw;
  }
}

export function sightCtx(raw: RawDemo, los: LosWorld | null = boxWorld()): { ctx: AnalysisContext; match: Match } {
  const { match } = finish(raw);
  return { ctx: createContext(raw, match, { los }), match };
}
