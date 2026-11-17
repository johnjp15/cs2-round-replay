/**
 * KM: line of sight between players on a coach map pack (docs/coach/maps.md). Deterministic, no DOM: runs in Node and
 * in a worker.
 *
 * - `LosWorld` wraps the pack's sight mesh (`MapGeometry`, G2GM): `eyePosition`, `visible` (eye to a fixed set of body
 *   points), `segmentClear`.
 * - `inFov`: is a point inside a player's view frustum.
 * - `SmokeField`: smokes from detonation events, through the engine's voxel smoke (src/engine/grenades/smoke.ts).
 *
 * Positions are feet origins in the map's world frame (Source units, z up), as the demo gives them; yaw and pitch in
 * Source degrees (yaw counter-clockwise from +x, pitch positive down). `duck` is the demo's duck amount, 0–1.
 *
 * Body points: picked from the hitbox table (src/engine/hitboxes.ts `HITBOXES`), posed the way `poseHitboxes` poses
 * them (forward along the yaw, left of it, z above the feet), with the crouch scale applied continuously in `duck`
 * (k = 1 − duck · (1 − crouchEye / eye), z never below the box's radius). In mask order:
 *
 *   | bit | point        | from                        | standing (f, l, z) |
 *   |-----|--------------|-----------------------------|--------------------|
 *   | 0   | head         | head sphere centre          | (0, 0, 63)         |
 *   | 1   | upper chest  | chest capsule middle        | (0, 0, 48.5)       |
 *   | 2   | pelvis       | the legs' top ends, middle  | (0, 0, 29)         |
 *   | 3   | left shoulder| arm_l's shoulder end        | (0, 11, 52)        |
 *   | 4   | right shoulder| arm_r's shoulder end       | (0, −11, 52)       |
 *   | 5   | left knee    | leg_l's middle              | (0, 4.25, 16.75)   |
 *   | 6   | right knee   | leg_r's middle              | (0, −4.25, 16.75)  |
 *
 * A point is visible when the segment from the eye to it crosses no sight triangle (and, with a smoke field, no
 * opaque smoke). The target's own body never blocks.
 */
import { parseTuning, type GrenadeCs2Tuning, type Team, type Vec3 } from '../../contracts/index';
import { TICK_RATE } from '../../engine/grenades/math';
import { createSmoke, smokeBlocks } from '../../engine/grenades/smoke';
import type { GrenadeState, GrenadeWorld, HullTrace, Smoke } from '../../engine/grenades/types';
import { HITBOXES, type HitboxDef } from '../../engine/hitboxes';
import { MapGeometry } from '../../sim2d/geometry';
import tuningJson from '../../../data/tuning.json';
import losTuningJson from '../../../data/coach/tuning/sight.json';

export type { Vec3 };

/** A player as a sight target: feet origin, body yaw (the view yaw is close enough: no animation), duck amount 0–1. */
export interface LosTarget {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly duck: number;
}

export interface Visibility {
  /** Some body point is visible. */
  readonly any: boolean;
  /** The head point is visible. */
  readonly head: boolean;
  /** Bit i set: BODY_POINTS[i] is visible. */
  readonly mask: number;
}

export interface LosTuning {
  readonly eyeHeight: number;
  readonly crouchEyeHeight: number;
  /** Horizontal field of view at `fovAspect` (CS2: 90 at 4:3). */
  readonly fovDeg: number;
  readonly fovAspect: number;
  /** The screen's aspect ratio (default 16:9). */
  readonly aspect: number;
  readonly smokeQueryRadius: number;
  readonly smoke: GrenadeCs2Tuning;
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`los tuning: ${k} must be a number`);
  return v;
}

/** The tunables from data/tuning.json (eye heights, grenades.cs2) and data/coach/tuning/sight.json (`los`). */
export function losTuningFrom(tuning: unknown, los: unknown): LosTuning {
  const t = parseTuning(tuning);
  const l = (los as { los?: Record<string, unknown> }).los;
  if (l === undefined || typeof l !== 'object') throw new Error('los tuning: no `los` section');
  return {
    eyeHeight: t.damage.eyeHeight,
    crouchEyeHeight: t.damage.crouchEyeHeight,
    fovDeg: num(l, 'fovDeg'),
    fovAspect: num(l, 'fovAspect'),
    aspect: num(l, 'aspect'),
    smokeQueryRadius: num(l, 'smokeQueryRadius'),
    smoke: t.grenades.cs2,
  };
}

let defaultTuning: LosTuning | null = null;
/** The committed tunables (parsed once). */
export function defaultLosTuning(): LosTuning {
  if (defaultTuning === null) defaultTuning = losTuningFrom(tuningJson, losTuningJson);
  return defaultTuning;
}

export interface BodyPoint {
  readonly name: string;
  /** Forward, left, up from the feet (standing). */
  readonly f: number;
  readonly l: number;
  readonly z: number;
  /** The hitbox's radius: the lowest a point sinks when crouched. */
  readonly radius: number;
}

function box(name: string): HitboxDef {
  const h = HITBOXES.find((b) => b.name === name);
  if (h === undefined) throw new Error(`hitboxes: no ${name}`);
  return h;
}

function mid(h: HitboxDef, name: string, ta: number): BodyPoint {
  const tb = 1 - ta;
  return { name, f: h.a[0] * ta + h.b[0] * tb, l: h.a[1] * ta + h.b[1] * tb, z: h.a[2] * ta + h.b[2] * tb, radius: h.radius };
}

/** The sampled body points, in mask order (see the file comment). */
export const BODY_POINTS: readonly BodyPoint[] = (() => {
  const legL = box('leg_l');
  const legR = box('leg_r');
  const pelvis: BodyPoint = { name: 'pelvis', f: (legL.a[0] + legR.a[0]) / 2, l: (legL.a[1] + legR.a[1]) / 2, z: (legL.a[2] + legR.a[2]) / 2, radius: legL.radius };
  return [mid(box('head'), 'head', 1), mid(box('chest'), 'upper_chest', 0.5), pelvis, mid(box('arm_l'), 'shoulder_l', 1), mid(box('arm_r'), 'shoulder_r', 1), mid(legL, 'knee_l', 0.5), mid(legR, 'knee_r', 0.5)];
})();
export const HEAD_BIT = 1;
export const ALL_POINTS_MASK = (1 << BODY_POINTS.length) - 1;

const DEG = Math.PI / 180;

/** Line of sight on one map. Not re-entrant (MapGeometry's scratch), fine on one thread. */
export class LosWorld {
  readonly geometry: MapGeometry;
  readonly tuning: LosTuning;
  /** Segment tests run since construction (for benchmarks). */
  segmentTests = 0;
  private readonly px = new Float64Array(BODY_POINTS.length);
  private readonly py = new Float64Array(BODY_POINTS.length);
  private readonly pz = new Float64Array(BODY_POINTS.length);

  constructor(geometry: MapGeometry, tuning: LosTuning = defaultLosTuning()) {
    this.geometry = geometry;
    this.tuning = tuning;
  }

  /** From a pack's G2GM bytes (los.bin.gz inflated: the browser uses DecompressionStream('gzip'), Node zlib). */
  static fromBytes(bytes: Uint8Array, tuning: LosTuning = defaultLosTuning()): LosWorld {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error('LosWorld.fromBytes: these bytes are gzipped; inflate los.bin.gz first');
    return new LosWorld(MapGeometry.fromBytes(bytes), tuning);
  }

  /** Eye height above the feet: eyeHeight standing, crouchEyeHeight at duck 1, linear between. */
  eyeHeight(duck: number): number {
    const d = duck < 0 ? 0 : duck > 1 ? 1 : duck;
    return this.tuning.eyeHeight - d * (this.tuning.eyeHeight - this.tuning.crouchEyeHeight);
  }

  eyePosition(feet: { readonly x: number; readonly y: number; readonly z: number }, duck: number): Vec3 {
    return { x: feet.x, y: feet.y, z: feet.z + this.eyeHeight(duck) };
  }

  /** Body point i of a target, in world space. */
  bodyPoint(target: LosTarget, i: number): Vec3 {
    this.poseTarget(target);
    return { x: this.px[i] as number, y: this.py[i] as number, z: this.pz[i] as number };
  }

  /** All body points of a target into `out` (x, y, z per point, mask order; length ≥ 3 × BODY_POINTS.length): no allocation. */
  bodyPointsInto(target: LosTarget, out: Float64Array): void {
    this.poseTarget(target);
    for (let i = 0; i < BODY_POINTS.length; i++) {
      out[i * 3] = this.px[i] as number;
      out[i * 3 + 1] = this.py[i] as number;
      out[i * 3 + 2] = this.pz[i] as number;
    }
  }

  /** True if nothing in the mesh lies between a and b. */
  segmentClear(a: Vec3, b: Vec3): boolean {
    this.segmentTests++;
    return !this.geometry.sightBlocked(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  /**
   * Which body points of `target` the eye sees. With `smoke` (and its `tick`), a point behind opaque smoke is not
   * visible. `want` limits the points tested (a mask; default all); `stopAtFirst` returns after the first visible one.
   */
  visible(eye: Vec3, target: LosTarget, smoke: SmokeField | null = null, tick = 0, want = ALL_POINTS_MASK, stopAtFirst = false): Visibility {
    this.poseTarget(target);
    let mask = 0;
    for (let i = 0; i < BODY_POINTS.length; i++) {
      if ((want & (1 << i)) === 0) continue;
      const bx = this.px[i] as number;
      const by = this.py[i] as number;
      const bz = this.pz[i] as number;
      this.segmentTests++;
      if (this.geometry.sightBlocked(eye.x, eye.y, eye.z, bx, by, bz)) continue;
      if (smoke !== null && smoke.blocks(eye, { x: bx, y: by, z: bz }, tick)) continue;
      mask |= 1 << i;
      if (stopAtFirst) break;
    }
    return { any: mask !== 0, head: (mask & HEAD_BIT) !== 0, mask };
  }

  private poseTarget(t: LosTarget): void {
    const c = Math.cos(t.yaw * DEG);
    const s = Math.sin(t.yaw * DEG);
    const d = t.duck < 0 ? 0 : t.duck > 1 ? 1 : t.duck;
    const k = 1 - d * (1 - this.tuning.crouchEyeHeight / this.tuning.eyeHeight);
    for (let i = 0; i < BODY_POINTS.length; i++) {
      const p = BODY_POINTS[i] as BodyPoint;
      // forward = (c, s), left = (−s, c), as poseHitboxes.
      this.px[i] = t.x + p.f * c - p.l * s;
      this.py[i] = t.y + p.f * s + p.l * c;
      this.pz[i] = t.z + Math.max(p.radius, p.z * k);
    }
  }
}

/**
 * Is `point` inside the view frustum of a player looking along (viewYaw, viewPitch) from `eye`? `hFovDeg` is the
 * horizontal field of view at 4:3 (`fovAspect`), widened for `aspect` the way CS2 does (Hor+: the vertical field stays,
 * the horizontal grows): tan(h/2) = tan(hFovDeg/2) · aspect / fovAspect, tan(v/2) = tan(hFovDeg/2) / fovAspect. 90° at
 * 16:9 is 106.3° wide and 73.7° high. A point at the eye counts as inside.
 */
export function inFov(viewYaw: number, viewPitch: number, eye: Vec3, point: Vec3, hFovDeg?: number, aspect?: number, tuning: LosTuning = defaultLosTuning()): boolean {
  const fov = hFovDeg ?? tuning.fovDeg;
  const asp = aspect ?? tuning.aspect;
  const tanV = Math.tan((fov * DEG) / 2) / tuning.fovAspect;
  const tanH = tanV * asp;
  const cy = Math.cos(viewYaw * DEG);
  const sy = Math.sin(viewYaw * DEG);
  const cp = Math.cos(viewPitch * DEG);
  const sp = Math.sin(viewPitch * DEG);
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  // forward (cp·cy, cp·sy, −sp), right (sy, −cy, 0), up (sp·cy, sp·sy, cp)
  const f = dx * cp * cy + dy * cp * sy - dz * sp;
  const r = dx * sy - dy * cy;
  const u = dx * sp * cy + dy * sp * sy + dz * cp;
  if (f === 0 && r === 0 && u === 0) return true;
  if (!(f > 0)) return false;
  return Math.abs(r) <= f * tanH && Math.abs(u) <= f * tanV;
}

/** A smoke grenade's detonation (from `smokegrenade_detonate`) and its expiry tick (`smokegrenade_expired`; null if unknown). */
export interface SmokeDetonation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly startTick: number;
  readonly endTick: number | null;
}

/** The engine's GrenadeWorld over the sight mesh: the smoke flood only traces lines. */
class SightWorld implements GrenadeWorld {
  private readonly g: MapGeometry;
  constructor(g: MapGeometry) {
    this.g = g;
  }
  traceLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return this.g.traceSight(ax, ay, az, bx, by, bz, true);
  }
  traceHull(): HullTrace {
    throw new Error('SightWorld: the smoke flood does not sweep hulls');
  }
}

/**
 * Smokes of one match as CS2's volumetric cloud (src/engine/grenades/smoke.ts: a 20-unit voxel flood from the
 * detonation that flows around walls, grows over smokeGrowSec, fades over the last smokeFadeSec before it expires).
 * Each smoke is flooded the first time a segment comes near it while it is up (about 10–30 ms on a full cloud), so a
 * match pays only for the smokes it asks about. No bullet holes or HE holes (the demo has them as events; not wired).
 */
export class SmokeField {
  readonly detonations: readonly SmokeDetonation[];
  private readonly world: LosWorld;
  private readonly built: (Smoke | null)[];
  private readonly state: GrenadeState = { seed: 0, tick: 0, nextSeq: 0, projectiles: [], smokes: [], infernos: [], decoys: [], heHoles: [] };
  /** Smokes flooded so far. */
  floods = 0;

  /** `detonations` in any order: they are sorted by start tick, then position. */
  constructor(world: LosWorld, detonations: readonly SmokeDetonation[]) {
    this.world = world;
    this.detonations = [...detonations].sort((a, b) => a.startTick - b.startTick || a.x - b.x || a.y - b.y || a.z - b.z);
    this.built = this.detonations.map(() => null);
  }

  /** The tick smoke i is gone (its expiry, else the model's lifetime). */
  endTick(i: number): number {
    const d = this.detonations[i] as SmokeDetonation;
    const t = this.world.tuning.smoke;
    return d.endTick ?? d.startTick + Math.round((t.smokeFullSec + t.smokeFadeSec) * TICK_RATE);
  }

  /** The flooded cloud of smoke i (built on first use). */
  smoke(i: number): Smoke {
    const have = this.built[i];
    if (have !== undefined && have !== null) return have;
    const d = this.detonations[i] as SmokeDetonation;
    const t = this.world.tuning.smoke;
    const team: Team = 'T';
    const s = createSmoke(i, '', team, { x: d.x, y: d.y, z: d.z }, d.startTick, new SightWorld(this.world.geometry), t);
    const end = this.endTick(i);
    const fade = Math.max(d.startTick, end - Math.round(t.smokeFadeSec * TICK_RATE));
    const out: Smoke = { ...s, fadeTick: fade, endTick: end };
    this.built[i] = out;
    this.floods++;
    return out;
  }

  /** True if smoke up at `tick` hides b from a. */
  blocks(a: Vec3, b: Vec3, tick: number): boolean {
    const r = this.world.tuning.smokeQueryRadius;
    const near: Smoke[] = [];
    for (let i = 0; i < this.detonations.length; i++) {
      const d = this.detonations[i] as SmokeDetonation;
      if (d.startTick > tick) break;
      if (tick >= this.endTick(i)) continue;
      if (segmentPointDist2(a, b, d.x, d.y, d.z) > r * r) continue;
      near.push(this.smoke(i));
    }
    if (near.length === 0) return false;
    this.state.smokes = near;
    return smokeBlocks(this.state, a, b, tick, this.world.tuning.smoke);
  }
}

function segmentPointDist2(a: Vec3, b: Vec3, x: number, y: number, z: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  let f = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy + (z - a.z) * dz) / l2 : 0;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  const qx = a.x + dx * f - x;
  const qy = a.y + dy * f - y;
  const qz = a.z + dz * f - z;
  return qx * qx + qy * qy + qz * qz;
}
