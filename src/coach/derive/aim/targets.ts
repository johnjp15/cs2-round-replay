/**
 * Combat tables, part 2: the enemy each bullet was meant for.
 *
 * 1. The enemy it hurt (`how: 'hit'`).
 * 2. Otherwise the living enemy whose body (head, chest or pelvis) is nearest the bullet's zero-spread direction,
 *    inside a distance-aware tolerance min(maxDeg, baseDeg + atan(bodyRadius / distance)), within maxDistance, and
 *    visible from the eye when a map pack is loaded (`how: 'aim'`). When the runner-up is less than clearRatio times
 *    farther off than the best, the pick is ambiguous and the bullet gets no target (`how: 'ambiguous'`).
 * 3. Else no target (`how: 'none'`). Bullets without a target are counted and left out of the aim metrics.
 *
 * For each assigned bullet: distance, angle off the target, and the offsets of the aim from the target's chest
 * (`aimOffset`: up / right in degrees and whether the aim ray passed through the target's silhouette).
 */
import type { TableDef } from '../../analyze/context';
import { FLAG } from '../../model/raw';
import { aimOffset, angleToPoint, bodyPoints, dirOf, type V3 } from './geom';
import { SHOTS } from './shots';
import { AIM_TUNING } from './tuning';

export interface TargetRow {
  readonly i: number;
  /** Target slot, -1 = none. */
  readonly target: number;
  readonly how: 'hit' | 'aim' | 'ambiguous' | 'none';
  /** Eye to the target's chest, units (NaN without target). */
  readonly dist: number;
  /** Angle between the aim and the nearest body point, degrees. */
  readonly angle: number;
  readonly up: number;
  readonly right: number;
  readonly onTarget: boolean;
  /** The target's feet at the shot (for annotations). */
  readonly at: V3 | null;
}

export interface TargetTables {
  rows: TargetRow[];
  counts: { hit: number; aim: number; ambiguous: number; none: number };
  /** Whether line of sight was required (a map pack was loaded). */
  los: boolean;
}

const DEG = 180 / Math.PI;

export const TARGETS: TableDef<TargetTables> = {
  id: 'aim.targets',
  build(ctx) {
    const { shots } = ctx.table(SHOTS);
    const raw = ctx.raw;
    const T = raw.ticks;
    const P = ctx.P;
    const tt = AIM_TUNING.target;
    const body = AIM_TUNING.body;
    const hurts = raw.events.hurts;
    const counts = { hit: 0, aim: 0, ambiguous: 0, none: 0 };
    const feetOf = (t: number, q: number): V3 => {
      const i = t * P + q;
      return [T.x[i] ?? 0, T.y[i] ?? 0, T.z[i] ?? 0];
    };
    const rows: TargetRow[] = shots.map((s) => {
      const team = ctx.teamOf(s.p);
      const t = s.row;
      let target = -1;
      let how: TargetRow['how'] = 'none';
      for (const h of s.hits) {
        const v = hurts[h]?.victim ?? -1;
        if (v >= 0 && team !== null && ctx.teamOf(v) !== null && ctx.teamOf(v) !== team) {
          target = v;
          how = 'hit';
          break;
        }
      }
      const d = dirOf(s.pitch, s.yaw);
      if (target < 0) {
        let best = -1;
        let bestA = Infinity;
        let second = Infinity;
        for (let q = 0; q < P; q++) {
          const i = t * P + q;
          if (q === s.p || T.present[i] !== 1 || ((T.flags[i] ?? 0) & FLAG.alive) === 0) continue;
          const tq = ctx.teamOf(q);
          if (tq === null || tq === team) continue;
          const feet = feetOf(t, q);
          const duck = (T.duck[i] ?? 0) / 255;
          const pts = bodyPoints(feet, duck, body);
          const dist = Math.hypot(pts[1][0] - s.eye[0], pts[1][1] - s.eye[1], pts[1][2] - s.eye[2]);
          if (dist > tt.maxDistance) continue;
          const a = Math.min(angleToPoint(s.eye, d, pts[0]), angleToPoint(s.eye, d, pts[1]), angleToPoint(s.eye, d, pts[2]));
          const tol = Math.min(tt.maxDeg, tt.baseDeg + Math.atan(tt.bodyRadius / Math.max(1, dist)) * DEG);
          if (a > tol) continue;
          if (ctx.los !== null) {
            const eye = { x: s.eye[0], y: s.eye[1], z: s.eye[2] };
            const vis = ctx.los.visible(eye, { x: feet[0], y: feet[1], z: feet[2], yaw: T.yaw[i] ?? 0, duck }, null, s.tick, undefined, true);
            if (!vis.any) continue;
          }
          if (a < bestA) {
            second = bestA;
            bestA = a;
            best = q;
          } else if (a < second) second = a;
        }
        if (best >= 0) {
          if (second < Infinity && second < tt.clearRatio * Math.max(bestA, 0.25)) how = 'ambiguous';
          else {
            target = best;
            how = 'aim';
          }
        }
      }
      counts[how]++;
      if (target < 0) return { i: s.i, target, how, dist: NaN, angle: NaN, up: NaN, right: NaN, onTarget: false, at: null };
      const i = t * P + target;
      const feet = feetOf(t, target);
      const duck = (T.duck[i] ?? 0) / 255;
      const pts = bodyPoints(feet, duck, body);
      const off = aimOffset(s.eye, s.pitch, s.yaw, feet, duck, body);
      const angle = Math.min(angleToPoint(s.eye, d, pts[0]), angleToPoint(s.eye, d, pts[1]), angleToPoint(s.eye, d, pts[2]));
      return { i: s.i, target, how, dist: off.dist, angle, up: off.up, right: off.right, onTarget: off.onTarget || how === 'hit', at: feet };
    });
    return { rows, counts, los: ctx.los !== null };
  },
};
