/**
 * G6: sight and bullets on CS2 Mirage's real 3D geometry (docs/vision.md). `sees`, the hitscan wall test, the LIVE AI's
 * guard-spot check and grenade effects (flash, HE) trace straight segments against the CS2 collision mesh
 * (`MapGeometry.traceSight`: the world triangles; G3's player clips are skipped, as CS2's bullets and sight traces pass
 * through `playerclip`). Glass, windows and bullet-pass railings aren't in the mesh (docs/geometry.md), so they are open.
 *
 * Visibility of a pawn is checked like CS2's bots do (`CCSBot::IsVisible(player)`: gut, head, feet, left and right
 * side): from the viewer's eye to several **aim points** on the target's body, seen if any segment is clear:
 *
 *   1. head  (`damage.bandHeights.head` above the feet; scaled by crouchEyeHeight / eyeHeight when crouched)
 *   2. chest (`bandHeights.chest`)
 *   3. left and right side: chest height, `ai.sightSideUnits` to either side, perpendicular to the 2D line of sight
 *   4. legs  (`bandHeights.leg`)
 *
 * The eye is `pos.z` + `damage.eyeHeight` (`crouchEyeHeight` crouched) at the pawn's real z, so airborne pawns look
 * from where they are. The head band equals the eye height (64; 46 crouched), so the eye-to-head segment of a pair is
 * eye to eye and serves both directions: `pairSight` traces it once (from the first pawn of the pair) and only the
 * directions it leaves open trace the other points. FOV, smoke and flash are computeSees's (vision.ts), as before.
 *
 * No wall penetration: any sight triangle stops a bullet (CS2's penetration needs materials the mesh doesn't have).
 * Pure apart from the geometry's scratch fields (not re-entrant: one thread). Plain + − × ÷, sqrt and comparisons, in a
 * fixed order, so a C# port gives the same answers (docs/port-notes.md).
 */
import type { AiTuning, DamageTuning, Vec3 } from '../contracts/index';
import type { MapGeometry } from './geometry';
import { SEES_AB, SEES_BA, type GuardSight, type PairSight } from './vision';

/** Aim points per target, in the order they are tried (docs/vision.md "Aim points"). */
export const AIM_POINTS = ['head', 'chest', 'left', 'right', 'leg'] as const;
export type AimPoint = (typeof AIM_POINTS)[number];

/** What MeshSight needs from tuning. */
export interface MeshSightOptions {
  /** Eye above the feet, standing and crouched (`damage.eyeHeight`, `damage.crouchEyeHeight`). */
  readonly eyeHeight: number;
  readonly crouchEyeHeight: number;
  /** Aim point heights above the feet, standing (`damage.bandHeights`). */
  readonly headHeight: number;
  readonly chestHeight: number;
  readonly legHeight: number;
  /** Side points' offset from the body axis, perpendicular to the line of sight (`ai.sightSideUnits`). */
  readonly sideUnits: number;
}

export function meshSightOptionsFromTuning(t: { readonly damage: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight' | 'bandHeights'>; readonly ai: Pick<AiTuning, 'sightSideUnits'> }): MeshSightOptions {
  const b = t.damage.bandHeights;
  return {
    eyeHeight: t.damage.eyeHeight,
    crouchEyeHeight: t.damage.crouchEyeHeight,
    headHeight: b['head'] ?? t.damage.eyeHeight,
    chestHeight: b['chest'] ?? 48,
    legHeight: b['leg'] ?? 16,
    sideUnits: t.ai.sightSideUnits,
  };
}

/** A pawn as sight sees it: feet position and posture. */
export interface SightBody {
  readonly pos: Vec3;
  readonly crouching: boolean;
}

/** A grenade at rest sits this far above the floor (its radius) when its effect is traced (game constant, not tuning). */
const GRENADE_REST_UNITS = 2;
/** How far above or below a landed grenade's z (the 2020 nav floor) to look for the CS2 floor it lies on (units). */
const GRENADE_FLOOR_WINDOW = 32;

export class MeshSight implements PairSight, GuardSight {
  readonly options: MeshSightOptions;
  private readonly g: MapGeometry;
  /** Segment tests and the full traces among them (the rest were answered by a hint triangle); benchmarks, not state. */
  traces = 0;
  fullTraces = 0;
  /**
   * Per pair (`pairSight`'s key): the triangle that last blocked one of its segments. A pair's next query tests it
   * first: if the segment crosses it, the segment is blocked, which is what the full trace would say. Otherwise the
   * full trace decides. So the hints only save time: answers never depend on them (snapshots don't carry them).
   */
  private readonly hints = new Map<number, number>();
  /** The hint in use during one query (−1: none). */
  private hint = -1;

  constructor(g: MapGeometry, options: MeshSightOptions) {
    this.g = g;
    this.options = { ...options };
  }

  /** The geometry this sight traces (its sight triangles). */
  geometry(): MapGeometry {
    return this.g;
  }

  /** True if the segment a → b crosses no sight triangle (the current hint triangle first, then the full trace). */
  segmentClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    this.traces++;
    if (this.hint >= 0 && this.g.crossesTriangle(this.hint, ax, ay, az, bx, by, bz)) return false;
    this.fullTraces++;
    const t = this.g.sightBlocker(ax, ay, az, bx, by, bz);
    if (t < 0) return true;
    this.hint = t;
    return false;
  }

  /** `segmentClear` for two points (bullets, grenade effects); no hint carried in or out. */
  clear(a: Vec3, b: Vec3): boolean {
    this.hint = -1;
    return this.segmentClear(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  /** Eye height above the feet. */
  eye(crouching: boolean): number {
    return crouching ? this.options.crouchEyeHeight : this.options.eyeHeight;
  }

  /** Height of a standing height `h` on a pawn of this posture (crouched bodies scale by crouchEyeHeight / eyeHeight). */
  private scaled(h: number, crouching: boolean): number {
    const o = this.options;
    return crouching ? (h * o.crouchEyeHeight) / o.eyeHeight : h;
  }

  /** The aim points of `target` as seen from `viewer` (AIM_POINTS order; tools, tests and the debug view). */
  aimPoints(viewer: SightBody, target: SightBody): { readonly name: AimPoint; readonly pos: Vec3 }[] {
    const o = this.options;
    const t = target.pos;
    const dx = t.x - viewer.pos.x;
    const dy = t.y - viewer.pos.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    // Perpendicular to the 2D line of sight (left of it when looking from viewer to target); none for the same spot.
    const px = len > 0 ? (-dy / len) * o.sideUnits : 0;
    const py = len > 0 ? (dx / len) * o.sideUnits : 0;
    const head = t.z + this.scaled(o.headHeight, target.crouching);
    const chest = t.z + this.scaled(o.chestHeight, target.crouching);
    const leg = t.z + this.scaled(o.legHeight, target.crouching);
    return [
      { name: 'head', pos: { x: t.x, y: t.y, z: head } },
      { name: 'chest', pos: { x: t.x, y: t.y, z: chest } },
      { name: 'left', pos: { x: t.x + px, y: t.y + py, z: chest } },
      { name: 'right', pos: { x: t.x - px, y: t.y - py, z: chest } },
      { name: 'leg', pos: { x: t.x, y: t.y, z: leg } },
    ];
  }

  /**
   * True if `viewer`'s eye sees any aim point of `target` (no FOV, smoke or flash here). Tries the points in
   * AIM_POINTS order and stops at the first clear one; `skipHead`: the head point is already known blocked.
   */
  visible(viewer: SightBody, target: SightBody, skipHead = false): boolean {
    if (!skipHead) this.hint = -1;
    return this.visibleFrom(viewer, target, skipHead);
  }

  /** `visible` with the current hint (one pair's query). */
  private visibleFrom(viewer: SightBody, target: SightBody, skipHead: boolean): boolean {
    const o = this.options;
    const v = viewer.pos;
    const t = target.pos;
    const ex = v.x;
    const ey = v.y;
    const ez = v.z + this.eye(viewer.crouching);
    if (!skipHead && this.segmentClear(ex, ey, ez, t.x, t.y, t.z + this.scaled(o.headHeight, target.crouching))) return true;
    const chest = t.z + this.scaled(o.chestHeight, target.crouching);
    if (this.segmentClear(ex, ey, ez, t.x, t.y, chest)) return true;
    const dx = t.x - v.x;
    const dy = t.y - v.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const px = (-dy / len) * o.sideUnits;
      const py = (dx / len) * o.sideUnits;
      if (this.segmentClear(ex, ey, ez, t.x + px, t.y + py, chest)) return true;
      if (this.segmentClear(ex, ey, ez, t.x - px, t.y - py, chest)) return true;
    }
    return this.segmentClear(ex, ey, ez, t.x, t.y, t.z + this.scaled(o.legHeight, target.crouching));
  }

  /**
   * GuardSight (the LIVE AI's guard spot, ai.ts): a pawn standing at `spot` (eye `eye` above its z) sees the point
   * `height` above `target`. One segment; a box between hides the bomb unless the line passes over it.
   */
  pointClear(spot: Vec3, eye: number, target: Vec3, height: number): boolean {
    this.hint = -1;
    return this.segmentClear(spot.x, spot.y, spot.z + eye, target.x, target.y, target.z + height);
  }

  /**
   * Where a grenade's effect traces start (flash, HE): `p` itself while it is in the air; on the ground the CS2 floor
   * under it (within GRENADE_FLOOR_WINDOW of its z, which is the 2020 nav's) plus its radius, so a grenade lying on a
   * step the nav models low doesn't trace from inside the floor.
   */
  effectOrigin(p: Vec3, landed: boolean): Vec3 {
    if (!landed) return { x: p.x, y: p.y, z: p.z };
    const f = this.g.floorBelow(p.x, p.y, p.z, 1, GRENADE_FLOOR_WINDOW, GRENADE_FLOOR_WINDOW);
    return { x: p.x, y: p.y, z: (f === null ? p.z : f.z) + GRENADE_REST_UNITS };
  }

  /**
   * Both directions of a pair at once: SEES_AB if `ab` is asked and a sees b, SEES_BA if `ba` is asked and b sees a.
   * When both pawns' head points are their eyes (the head band is the eye height, standing or crouched), the
   * eye-to-eye segment is traced once, from a's eye to b's, for both directions: clear means both see each other;
   * blocked, each asked direction tries its remaining points. Otherwise each asked direction runs `visible`. `key`
   * (computeSees: the pair's index) keeps the pair's blocking triangle as a hint for its next query.
   */
  pairSight(a: SightBody, b: SightBody, ab: boolean, ba: boolean, key = -1): number {
    if (!ab && !ba) return 0;
    this.hint = key < 0 ? -1 : (this.hints.get(key) ?? -1);
    const r = this.pairQuery(a, b, ab, ba);
    if (key >= 0 && this.hint >= 0) this.hints.set(key, this.hint);
    return r;
  }

  private pairQuery(a: SightBody, b: SightBody, ab: boolean, ba: boolean): number {
    const o = this.options;
    const eyeA = this.eye(a.crouching);
    const eyeB = this.eye(b.crouching);
    const shared = this.scaled(o.headHeight, a.crouching) === eyeA && this.scaled(o.headHeight, b.crouching) === eyeB;
    if (!shared) return (ab && this.visibleFrom(a, b, false) ? SEES_AB : 0) | (ba && this.visibleFrom(b, a, false) ? SEES_BA : 0);
    if (this.segmentClear(a.pos.x, a.pos.y, a.pos.z + eyeA, b.pos.x, b.pos.y, b.pos.z + eyeB)) return (ab ? SEES_AB : 0) | (ba ? SEES_BA : 0);
    return (ab && this.visibleFrom(a, b, true) ? SEES_AB : 0) | (ba && this.visibleFrom(b, a, true) ? SEES_BA : 0);
  }
}
