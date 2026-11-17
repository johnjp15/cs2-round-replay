/**
 * K6 table `sight.firsts`: each player's first sight in each duel, with where the crosshair was (docs/coach/sight.md,
 * "Crosshair placement" and "Time to damage").
 *
 * At the observer's first sighting row of a duel: the view direction (the row's view angles) against the ray from his
 * eye to the enemy's head point. `right` and `up` say where the enemy's head was relative to the crosshair (degrees;
 * + = right of it / above it: "your crosshair sits 3.1° low" is up = +3.1), `angle` the angle between them. The
 * Leetify-style figure is the angle between that view direction and the view the first damaging bullet left from
 * (K2's `ShotRow.viewPitch/viewYaw`). Times are from the first sight to the first bullet at him and to the first damage
 * (null when there was none, or when it came before the sight: a prefire or a wallbang).
 */
import type { TableDef } from '../../analyze/context';
import { SHOTS } from '../aim/shots';
import { angleToPoint, anglesTo, dirOf, wrap180, type V3 } from '../aim/geom';
import { DUELS, sideOf, type DuelRow, type DuelSide } from './duels';
import { SIGHT_TUNING } from './tuning';

export type FirstOutcome = 'won' | 'lost' | 'no_shot' | 'other';

export interface FirstSight {
  readonly duel: DuelRow;
  readonly p: number;
  readonly enemy: number;
  readonly round: number;
  readonly row: number;
  readonly tick: number;
  readonly eye: V3;
  readonly head: V3;
  readonly viewPitch: number;
  readonly viewYaw: number;
  readonly right: number;
  readonly up: number;
  readonly angle: number;
  readonly dist: number;
  readonly holding: boolean;
  /** The observer's place name at the first sight ('' unknown). */
  readonly place: string;
  /** Angle the view moved from the first sight to the first damaging bullet (null: no damage after the sight). */
  readonly moved: number | null;
  readonly shotMs: number | null;
  readonly damageMs: number | null;
  /** He saw the enemy at least clearMarginMs before the enemy saw him (or the enemy never did). */
  readonly sawFirst: boolean;
  readonly outcome: FirstOutcome;
}

export interface FirstTables {
  readonly available: boolean;
  /** Per slot, in time order. */
  readonly bySlot: readonly (readonly FirstSight[])[];
}

export const FIRSTS: TableDef<FirstTables> = {
  id: 'sight.firsts',
  build(ctx) {
    const P = ctx.P;
    const duels = ctx.table(DUELS);
    const bySlot: FirstSight[][] = Array.from({ length: P }, () => []);
    if (!duels.available || ctx.los === null) return { available: false, bySlot };
    const los = ctx.los;
    const raw = ctx.raw;
    const T = raw.ticks;
    const rate = raw.header.tickRate || 64;
    const msPerTick = 1000 / rate;
    const { shots } = ctx.table(SHOTS);
    const shotAt = new Map<number, number>();
    for (const s of shots) {
      const k = s.tick * P + s.p;
      if (!shotAt.has(k)) shotAt.set(k, s.i);
    }
    const margin = SIGHT_TUNING.duels.clearMarginMs / msPerTick;
    for (const d of duels.duels) {
      for (const p of [d.a.p, d.b.p]) {
        const sides = sideOf(d, p) as { me: DuelSide; them: DuelSide };
        const { me, them } = sides;
        if (me.sightRow === null || me.sightTick === null) continue;
        const st = me.sightTick;
        const r = me.sightRow;
        const i = r * P + p;
        const j = r * P + them.p;
        const eyeV = los.eyePosition({ x: T.x[i] ?? 0, y: T.y[i] ?? 0, z: T.z[i] ?? 0 }, (T.duck[i] ?? 0) / 255);
        const headV = los.bodyPoint({ x: T.x[j] ?? 0, y: T.y[j] ?? 0, z: T.z[j] ?? 0, yaw: T.yaw[j] ?? 0, duck: (T.duck[j] ?? 0) / 255 }, 0);
        const eye: V3 = [eyeV.x, eyeV.y, eyeV.z];
        const head: V3 = [headV.x, headV.y, headV.z];
        const viewPitch = T.pitch[i] ?? 0;
        const viewYaw = T.yaw[i] ?? 0;
        const to = anglesTo(eye, head);
        const dir = dirOf(viewPitch, viewYaw);
        let moved: number | null = null;
        if (me.hurt !== null && me.damageTick !== null && me.damageTick >= st) {
          const si = shotAt.get(me.damageTick * P + p);
          const s = si === undefined ? undefined : shots[si];
          if (s !== undefined) moved = r3(angleToPoint([0, 0, 0], dir, dirOf(s.viewPitch, s.viewYaw)));
        }
        const after = (t: number | null): number | null => (t === null || t < st ? null : Math.round((t - st) * msPerTick));
        const sawFirst = them.sightTick === null || them.sightTick - st >= margin;
        const outcome: FirstOutcome = d.outcome === 'kill' && d.winner === p ? 'won' : d.outcome === 'kill' && d.winner === them.p ? 'lost' : me.shots === 0 ? 'no_shot' : 'other';
        bySlot[p]?.push({
          duel: d, p, enemy: them.p, round: d.round, row: r, tick: st, eye, head, viewPitch, viewYaw,
          right: r3(wrap180(viewYaw - to.yaw)), up: r3(viewPitch - to.pitch), angle: r3(angleToPoint(eye, dir, head)),
          dist: Math.round(Math.hypot(head[0] - eye[0], head[1] - eye[1], head[2] - eye[2])), holding: me.holding,
          place: raw.names.places[T.place[i] ?? 0] ?? '', moved, shotMs: after(me.shotTick), damageMs: after(me.damageTick), sawFirst, outcome,
        });
      }
    }
    for (const l of bySlot) l.sort((x, y) => x.tick - y.tick || x.enemy - y.enemy);
    return { available: true, bySlot };
  },
};

function r3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
