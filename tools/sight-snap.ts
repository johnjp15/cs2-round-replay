/**
 * G6: pass 5 of tools/snap-tracks.ts, sight. The recording's positions are a 2020 POV video's, ±20–40 units and more
 * near walls (docs/geometry.md), so a recorded duel can be impossible on CS2 Mirage at the snapped positions: on the
 * real mesh (G6 sight) cart's recorded path through the Apartments is 80–145 units behind the window's 24-unit sill,
 * which hides him from Lokier on B for all but a few ticks of their duel (17.45–18.8 s), and neither recorded shot
 * (Lokier's 73 at 18.5, cart's kill at 18.8) can connect. Cart's recorded view yaw at the kill (−145.7°) points from
 * about 100 units further south, where Lokier is in sight through the window. This pass moves such samples as
 * little as it can so that every recorded duel is in sight on the mesh (docs/vision.md "Recorded duels").
 *
 * Duels: each trusted sighting of the vision labels (tools/vision-labels.ts: both ends backed by observed samples, not
 * excluded with evidence, or excluded for a position the pass fixes: `SNAP_FIXES`) whose window holds a trusted hit or kill between the pair. From the sighting's t0 until the
 * window ends (its t1, or the death of either), at every 10 Hz sample both must see each other (MeshSight, standing;
 * where a pawn's snapped track moves slower than SIGHT_PARAMS.crouchBelow but isn't standing still
 * (`replay.standSpeedThreshold`), crouched too, since the puppet may crouch-walk there).
 *
 * For a duel that fails at some sample, one of the two (the mover) gets new spots for the samples from `blendSec`
 * before the window to `blendSec` after it: a Viterbi search over candidate spots on a grid around each snapped spot
 * (the spot itself, then allowed stand levels within `radius` on the same floor), where window samples must satisfy
 * the duel against the other's snapped position, consecutive spots must be within the recorded weapon's run speed
 * (× `stepSlack`, or the snapped step) and in a clear hull line (unchanged snapped steps are kept as they are), and the
 * cost is the distance from the snapped spot plus `smooth` × how much each step differs from the snapped step. Both
 * pawns are tried as the mover; the cheaper wins. Deterministic: fixed candidate order, ties to the earlier candidate.
 */
import { PLAYER_IDS, type PlayerId, type RoundData } from '../src/contracts/index';
import type { MapGeometry } from '../src/sim2d/geometry';
import type { MeshSight } from '../src/sim2d/mesh-sight';
import { SEES_AB, SEES_BA } from '../src/sim2d/vision';
import { hullLineClear } from '../src/sim2d/walk-query';
import type { Snapper, SnappedSample } from './snap-tracks';
import { SNAP_FIXES, buildMustSee } from './vision-labels';

export const SIGHT_PARAMS = {
  /** How far a sample may move for sight (units), and the candidate grids inside and outside the duel window. */
  radius: 128,
  gridWindow: 4,
  gridBlend: 8,
  /** Samples this long before and after a window may move too, so the track gets there at run speed. */
  blendSec: 1.5,
  /** A level within this of the snapped z (the same floor). */
  zWindow: 24,
  /** A step may be this × the weapon's run speed × 0.1 s (or the snapped step, if longer). */
  stepSlack: 1.1,
  /** Cost per unit a step differs from the snapped one (keeps the recorded motion: speeds, so WALK / DUCK, stay). */
  smooth: 1,
  /** Where the snapped track is slower than this (units/s, over the neighbouring samples), the duel must hold crouched too. */
  crouchBelow: 120,
} as const;

/**
 * Recorded duels this pass leaves alone, by vision-label id: the recorded (video-fitted) positions are right and the
 * line is blocked because CS2 Mirage differs from the 2020 map there. V2 (docs/viewfit.md "Engagement positions"):
 * cart's first-person frames put him and Lokier within the radar's accuracy of their dots, and no position within it
 * opens the window duel on CS2 Mirage; the 2020 opening of the Apartments window starts ~60 u further west than CS2's.
 * The positions stay; the map gets the 2020 opening (a separate map patch). The G6 audit lines of the duel's scripted
 * hits (ticks 1184, 1203) are labelled as this map difference (docs/vision.md).
 */
export const MAP_DIFFERENCES: Readonly<Record<string, string>> = {
  'sighting@17.45 cart->lokier': 'the Apartments window over B: the 2020 opening is wider (west) than CS2 Mirage\'s; a map difference, not a position error (docs/viewfit.md)',
};

export interface Duel {
  readonly a: PlayerId;
  readonly b: PlayerId;
  /** The sighting (its id in the vision labels) and the window, in seconds. */
  readonly label: string;
  readonly t0: number;
  readonly t1: number;
}

/** The recorded duels the pass enforces (see the file comment), in label order. */
export function recordedDuels(round: RoundData): Duel[] {
  const labels = buildMustSee(round).filter((m) => m.excluded === null || SNAP_FIXES.has(m.id));
  const out: Duel[] = [];
  for (const s of labels) {
    if (s.source !== 'sighting') continue;
    const rec = round.sightings.find((q) => Math.abs(q.t0 - s.t) < 1e-9 && q.who === s.to);
    if (rec === undefined) continue;
    const hits = labels.filter((h) => h.source !== 'sighting' && ((h.from === s.from && h.to === s.to) || (h.from === s.to && h.to === s.from)) && h.t >= s.t - 1e-9 && h.t <= rec.t1 + 1e-9);
    if (hits.length === 0) continue;
    let t1 = rec.t1;
    for (const id of [s.from, s.to]) {
      const d = round.players.find((p) => p.id === id)?.deathT ?? null;
      if (d !== null && d < t1) t1 = d;
    }
    out.push({ a: s.from, b: s.to, label: s.id, t0: s.t, t1 });
  }
  return out;
}

export interface SightPassInput {
  readonly round: RoundData;
  /** Snapped tracks after passes 1–4, by player. */
  readonly tracks: ReadonlyMap<PlayerId, readonly SnappedSample[]>;
  /** The movement mesh (world + clips): stand levels and hull lines. */
  readonly g: MapGeometry;
  /** Sight on the world triangles. */
  readonly sight: MeshSight;
  readonly snapper: Snapper;
  readonly step: number;
  /** Run speed of the recorded weapon at sample i. */
  readonly runSpeed: (id: PlayerId, i: number) => number;
  /** Sample i must not move (plant, defuse). */
  readonly frozen: (id: PlayerId, i: number) => boolean;
  /** Below this speed (units/s) a puppet stands still upright (`replay.standSpeedThreshold`): no crouch to check. */
  readonly standSpeed: number;
  /** The recording's samples (for the moved samples' distance from it). */
  readonly raw: (id: PlayerId) => readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

export interface SightPassResult {
  readonly tracks: Map<PlayerId, SnappedSample[]>;
  readonly notes: string[];
}

interface Spot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 1/32 unit, as the snapped tracks. */
function q32(v: number): number {
  return Math.round(v * 32) / 32;
}

function offsets(r: number, grid: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dy = -r; dy <= r; dy += grid) for (let dx = -r; dx <= r; dx += grid) if ((dx !== 0 || dy !== 0) && dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]) || p[0] - q[0] || p[1] - q[1]);
}

export function sightPass(input: SightPassInput): SightPassResult {
  const tracks = new Map<PlayerId, SnappedSample[]>();
  for (const id of PLAYER_IDS) {
    const t = input.tracks.get(id);
    if (t !== undefined) tracks.set(id, [...t]);
  }
  const notes: string[] = [];
  const { sight } = input;
  const P = SIGHT_PARAMS;
  // Mutual sight between two feet positions (standing; with `crouch`, the first crouched too).
  const duelHolds = (p: Spot, q: Spot, crouch: boolean): boolean => {
    for (const c of crouch ? [false, true] : [false]) {
      if (sight.pairSight({ pos: p, crouching: c }, { pos: q, crouching: false }, true, true) !== (SEES_AB | SEES_BA)) return false;
    }
    return true;
  };
  // Samples are 10 Hz from t = 0 for everyone (docs/round-data.md), so index i is t = i / 10 on every track.
  for (const id of PLAYER_IDS) {
    const raw = input.raw(id) as readonly { readonly t?: number }[];
    raw.forEach((q, i) => {
      if (q.t !== undefined && Math.abs(q.t - i / 10) > 1e-6) throw new Error(`sightPass: ${id} sample ${i} at t ${q.t}, expected ${i / 10}`);
    });
  }
  for (const duel of recordedDuels(input.round)) {
    const ta = tracks.get(duel.a);
    const tb = tracks.get(duel.b);
    if (ta === undefined || tb === undefined) continue;
    const known = MAP_DIFFERENCES[duel.label];
    if (known !== undefined) {
      notes.push(`${duel.label} (${duel.a} ↔ ${duel.b}, ${duel.t0}–${duel.t1} s): left as fitted — known CS2-vs-2020 map difference: ${known}`);
      continue;
    }
    const w0 = Math.ceil(duel.t0 * 10 - 1e-9);
    const w1 = Math.floor(duel.t1 * 10 + 1e-9);
    const slow = (track: readonly SnappedSample[], i: number): boolean => {
      const p = track[Math.max(0, i - 1)] as SnappedSample;
      const q = track[Math.min(track.length - 1, i + 1)] as SnappedSample;
      const v = Math.hypot(q.x - p.x, q.y - p.y) / 0.2;
      return v >= input.standSpeed && v < P.crouchBelow;
    };
    let failing = 0;
    for (let i = w0; i <= w1; i++) {
      const pa = ta[i] as SnappedSample;
      const pb = tb[i] as SnappedSample;
      if (!duelHolds(pa, pb, slow(ta, i)) || !duelHolds(pb, pa, slow(tb, i))) failing++;
    }
    if (failing === 0) {
      notes.push(`${duel.label} (${duel.a} ↔ ${duel.b}, ${duel.t0}–${duel.t1} s): in sight at the snapped positions, unchanged`);
      continue;
    }
    let best: { id: PlayerId; out: SnappedSample[]; cost: number; max: number; from: number; to: number } | null = null;
    for (const [mover, other] of [
      [duel.a, duel.b],
      [duel.b, duel.a],
    ] as const) {
      const r = moveForDuel(input, tracks.get(mover) as SnappedSample[], tracks.get(other) as SnappedSample[], mover, w0, w1, duelHolds, slow);
      if (r !== null && (best === null || r.cost < best.cost - 1e-9)) best = { id: mover, ...r };
    }
    if (best === null) {
      notes.push(`${duel.label} (${duel.a} ↔ ${duel.b}, ${duel.t0}–${duel.t1} s): ${failing} samples out of sight, no way found within ${P.radius} u`);
      continue;
    }
    tracks.set(best.id, best.out);
    notes.push(
      `${duel.label} (${duel.a} ↔ ${duel.b}, ${duel.t0}–${duel.t1} s): ${failing} samples out of sight at the snapped positions; ${best.id} moved ` +
        `${(best.from / 10).toFixed(1)}–${(best.to / 10).toFixed(1)} s, up to ${best.max.toFixed(0)} u`,
    );
  }
  return { tracks, notes };
}

/** The Viterbi search for one mover (see the file comment). null if there is no way. */
function moveForDuel(
  input: SightPassInput,
  track: readonly SnappedSample[],
  other: readonly SnappedSample[],
  id: PlayerId,
  w0: number,
  w1: number,
  duelHolds: (p: Spot, q: Spot, crouch: boolean) => boolean,
  slow: (track: readonly SnappedSample[], i: number) => boolean,
): { out: SnappedSample[]; cost: number; max: number; from: number; to: number } | null {
  const P = SIGHT_PARAMS;
  const blend = Math.round(P.blendSec * 10);
  const n = track.length;
  let i0 = Math.max(0, w0 - blend);
  let i1 = Math.min(n - 1, w1 + blend);
  for (let i = w0; i <= w1; i++) if (input.frozen(id, i)) return null;
  for (let i = w0 - 1; i >= i0; i--) if (input.frozen(id, i)) i0 = i + 1;
  for (let i = w1 + 1; i <= i1; i++) if (input.frozen(id, i)) i1 = i - 1;
  if (i0 > w0 || i1 < w1) return null;
  const offWindow = offsets(P.radius, P.gridWindow);
  const offBlend = offsets(P.radius, P.gridBlend);
  // Candidates: index 0 is the snapped spot itself (if it qualifies), then the grid in order of distance.
  const cands: Spot[][] = [];
  const disp: number[][] = [];
  for (let i = i0; i <= i1; i++) {
    const s = track[i] as SnappedSample;
    const inWindow = i >= w0 && i <= w1;
    const q = inWindow ? (other[i] as SnappedSample) : null;
    const crouch = slow(track, i);
    const crouchOther = q !== null && slow(other, i);
    const ok = (c: Spot): boolean => q === null || (duelHolds(c, q, crouch) && (!crouchOther || duelHolds(q, c, true)));
    const list: Spot[] = [];
    const d: number[] = [];
    if (ok(s)) {
      list.push({ x: s.x, y: s.y, z: s.z });
      d.push(0);
    }
    for (const [dx, dy] of inWindow ? offWindow : offBlend) {
      const lv = input.snapper.levels(s.x + dx, s.y + dy, s.z, P.zWindow)[0];
      if (lv === undefined) continue;
      const c = { x: q32(s.x + dx), y: q32(s.y + dy), z: q32(lv) };
      if (!ok(c)) continue;
      list.push(c);
      d.push(Math.hypot(dx, dy));
    }
    if (list.length === 0) return null;
    cands.push(list);
    disp.push(d);
  }
  const isOrig = (i: number, c: Spot): boolean => {
    const s = track[i] as SnappedSample;
    return c.x === s.x && c.y === s.y && c.z === s.z;
  };
  // A step from c (sample i − 1) to e (sample i): free if both are the snapped spots (passes 1–4 accepted it), else
  // within the allowance and in a clear hull line. Its smoothness cost compares it with the snapped step.
  const stepCost = (i: number, c: Spot, e: Spot): number => {
    const a = track[i - 1] as SnappedSample;
    const b = track[i] as SnappedSample;
    const dev = Math.hypot(e.x - c.x - (b.x - a.x), e.y - c.y - (b.y - a.y));
    if (isOrig(i - 1, c) && isOrig(i, e)) return 0;
    const allow = Math.max(P.stepSlack * Math.max(input.runSpeed(id, i - 1), input.runSpeed(id, i)) * 0.1, Math.hypot(b.x - a.x, b.y - a.y));
    if (Math.hypot(e.x - c.x, e.y - c.y) > allow) return Infinity;
    if (!hullLineClear(input.g, c, e, input.step)) return Infinity;
    return P.smooth * dev;
  };
  // The samples just outside stay where they are (none at a track's start or end: a death ends the track).
  const left = i0 > 0 ? (track[i0 - 1] as SnappedSample) : null;
  const right = i1 + 1 < n ? (track[i1 + 1] as SnappedSample) : null;
  let cost: number[] = (cands[0] as Spot[]).map((c, k) => ((disp[0] as number[])[k] as number) + (left === null ? 0 : stepCost(i0, left, c)));
  const back: number[][] = [];
  for (let j = 1; j < cands.length; j++) {
    const i = i0 + j;
    const prev = cands[j - 1] as Spot[];
    const cur = cands[j] as Spot[];
    const next: number[] = [];
    const from: number[] = [];
    for (let k = 0; k < cur.length; k++) {
      const e = cur[k] as Spot;
      const dv = (disp[j] as number[])[k] as number;
      let b = Infinity;
      let bk = -1;
      for (let m = 0; m < prev.length; m++) {
        const base = cost[m] as number;
        if (base === Infinity || base + dv >= b) continue;
        const c = prev[m] as Spot;
        if (Math.abs(e.x - c.x) > 64 || Math.abs(e.y - c.y) > 64) continue;
        const v = base + dv + stepCost(i, c, e);
        if (v < b) {
          b = v;
          bk = m;
        }
      }
      next.push(b);
      from.push(bk);
    }
    cost = next;
    back.push(from);
  }
  const last = cands[cands.length - 1] as Spot[];
  let end = -1;
  let endCost = Infinity;
  for (let k = 0; k < last.length; k++) {
    const base = cost[k] as number;
    if (base === Infinity || base >= endCost) continue;
    const v = base + (right === null ? 0 : stepCost(i1 + 1, last[k] as Spot, right));
    if (v < endCost) {
      endCost = v;
      end = k;
    }
  }
  if (end < 0) return null;
  const pick: Spot[] = [];
  for (let j = cands.length - 1, k = end; j >= 0; j--) {
    pick.unshift((cands[j] as Spot[])[k] as Spot);
    if (j > 0) k = (back[j - 1] as number[])[k] as number;
  }
  const out = [...track];
  let max = 0;
  let from = -1;
  let to = -1;
  pick.forEach((c, j) => {
    const i = i0 + j;
    const s = track[i] as SnappedSample;
    if (isOrig(i, c)) return;
    const moved = Math.hypot(c.x - s.x, c.y - s.y);
    if (moved > max) max = moved;
    if (from < 0) from = i;
    to = i;
    const r = input.raw(id)[i] as { x: number; y: number; z: number };
    const dxy = Math.hypot(c.x - r.x, c.y - r.y);
    out[i] = { x: c.x, y: c.y, z: c.z, kind: dxy === 0 ? 'ok' : dxy <= 16 ? 'moved' : dxy <= 64 ? 'far' : 'impossible', dxy, dz: c.z - r.z, connected: true };
  });
  return { out, cost: endCost, max, from, to };
}
