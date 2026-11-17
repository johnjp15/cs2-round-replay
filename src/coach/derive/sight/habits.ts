/**
 * K6 table `sight.habits`: counted habits per slot (docs/coach/sight.md, "Habits"; thresholds in sight.json `habits`).
 *
 * - `airborne`: bullets fired in the air at a target (K2's `SHOTS.airborne`, `TARGETS`).
 * - `flashed`: bullets fired while blind (the sightings table's `blind` rows).
 * - `scopedMoving`: runs of at least scopedMinMs with a scoped sniper rifle above the movement-inaccuracy threshold
 *   (moveStartFraction × the scoped max speed) while the player sees an enemy or an enemy sees him.
 * - `repeeks`: a sniper bullet at a target that hurt nobody; the two then lose line of sight both ways; within
 *   repeekSec of the shot the target sees the player again, the player within repeekRadius of where he shot from.
 */
import type { TableDef } from '../../analyze/context';
import { SHOTS, type ShotRow } from '../aim/shots';
import { TARGETS } from '../aim/targets';
import { speedAt } from '../movement/speed';
import { FLAG, rowAtOrAfter } from '../../model/raw';
import { SEE, SIGHTINGS } from './sightings';
import { SIGHT_TUNING } from './tuning';

export interface ScopedRun {
  readonly p: number;
  readonly round: number;
  readonly r0: number;
  readonly r1: number;
  readonly tick0: number;
  readonly tick1: number;
  readonly weapon: string;
  /** Peak speed in the run, units/s, and the threshold it was above. */
  readonly peak: number;
  readonly threshold: number;
  /** An enemy in sight during the run (the first one met). */
  readonly enemy: number;
}

export interface Repeek {
  readonly p: number;
  readonly enemy: number;
  readonly round: number;
  /** The missed shot (SHOTS index) and its tick. */
  readonly shot: number;
  readonly shotTick: number;
  /** Tick sight was lost, and the tick the enemy saw the player again. */
  readonly hideTick: number;
  readonly backTick: number;
  /** The enemy killed the player within repeekSec after he came back. */
  readonly died: boolean;
}

export interface HabitTables {
  readonly available: boolean;
  readonly airborne: readonly (readonly ShotRow[])[];
  readonly flashed: readonly (readonly ShotRow[])[];
  readonly scopedMoving: readonly (readonly ScopedRun[])[];
  readonly repeeks: readonly (readonly Repeek[])[];
}

export const HABITS: TableDef<HabitTables> = {
  id: 'sight.habits',
  build(ctx) {
    const P = ctx.P;
    const empty = (): never[][] => Array.from({ length: P }, () => []);
    const tab = ctx.table(SIGHTINGS);
    if (!tab.available) return { available: false, airborne: empty(), flashed: empty(), scopedMoving: empty(), repeeks: empty() };
    const raw = ctx.raw;
    const T = raw.ticks;
    const rate = raw.header.tickRate || 64;
    const h = SIGHT_TUNING.habits;
    const { shots } = ctx.table(SHOTS);
    const targets = ctx.table(TARGETS).rows;
    const see = (r: number, o: number, t: number): number => tab.state[(r * P + o) * P + t] ?? 0;
    const airborne: ShotRow[][] = empty();
    const flashed: ShotRow[][] = empty();
    const repeeks: Repeek[][] = empty();
    const repeekTicks = Math.round(h.repeekSec * rate);

    for (const s of shots) {
      if (s.round === 0) continue;
      const tg = targets[s.i];
      if (s.airborne && tg !== undefined && tg.target >= 0) airborne[s.p]?.push(s);
      // Blind on the row the shot left from (the row before the shot's row).
      if (tab.blind[Math.max(0, s.row - 1) * P + s.p] === 1) flashed[s.p]?.push(s);
      if (s.kind === 'sniper' && tg !== undefined && tg.target >= 0 && !s.hitEnemy) {
        const q = tg.target;
        const end = Math.min(T.count - 1, rowAtOrAfter(T, s.tick + repeekTicks));
        let hide = -1;
        for (let r = s.row + 1; r <= end; r++) {
          if ((see(r, s.p, q) & SEE.los) === 0 && (see(r, q, s.p) & SEE.los) === 0) {
            hide = r;
            break;
          }
          if (((T.flags[r * P + s.p] ?? 0) & FLAG.alive) === 0) break;
        }
        if (hide < 0) continue;
        for (let r = hide + 1; r <= end; r++) {
          if (((T.flags[r * P + s.p] ?? 0) & FLAG.alive) === 0) break;
          if ((see(r, q, s.p) & SEE.seen) === 0) continue;
          const i = r * P + s.p;
          if (Math.hypot((T.x[i] ?? 0) - s.eye[0], (T.y[i] ?? 0) - s.eye[1]) > h.repeekRadius) break;
          const back = T.tick[r] ?? 0;
          const died = raw.events.kills.some((k) => k.victim === s.p && k.attacker === q && k.tick >= back && k.tick <= back + repeekTicks);
          repeeks[s.p]?.push({ p: s.p, enemy: q, round: s.round, shot: s.i, shotTick: s.tick, hideTick: T.tick[hide] ?? 0, backTick: back, died });
          break;
        }
      }
    }

    // Scoped movement with an enemy in sight either way.
    const kindOf = raw.names.weapons.map((w) => ctx.weapon(w));
    const minRows = Math.max(1, Math.round((h.scopedMinMs * rate) / 1000));
    const scopedMoving: ScopedRun[][] = empty();
    for (const round of ctx.match.rounds) {
      if (!round.played || round.freezeEndTick === null) continue;
      const R0 = Math.max(round.rowStart, rowAtOrAfter(T, round.freezeEndTick));
      const R1 = round.rowEnd - 1;
      for (let p = 0; p < P; p++) {
        let start = -1;
        let peak = 0;
        let enemy = -1;
        let thr = 0;
        let wname = '';
        const close = (r: number): void => {
          if (start >= 0 && r - start >= minRows && enemy >= 0) {
            scopedMoving[p]?.push({ p, round: round.number, r0: start, r1: r - 1, tick0: T.tick[start] ?? 0, tick1: T.tick[r - 1] ?? 0, weapon: wname, peak: Math.round(peak), threshold: Math.round(thr), enemy });
          }
          start = -1;
          peak = 0;
          enemy = -1;
        };
        for (let r = R0; r <= R1; r++) {
          const i = r * P + p;
          const w = kindOf[T.weapon[i] ?? 0] ?? null;
          const f = T.flags[i] ?? 0;
          let on = false;
          if (w !== null && w.kind === 'sniper' && (f & FLAG.scoped) !== 0 && (f & FLAG.alive) !== 0) {
            const threshold = w.maxSpeed[1] * ctx.weaponModel.moveStartFraction;
            const sp = speedAt(raw, r, p);
            if (sp > threshold) {
              on = true;
              if (start < 0) {
                start = r;
                thr = threshold;
                wname = raw.names.weapons[T.weapon[i] ?? 0] ?? '';
              }
              peak = Math.max(peak, sp);
              if (enemy < 0) {
                for (let q = 0; q < P; q++) {
                  if (((see(r, p, q) | see(r, q, p)) & SEE.seen) !== 0) {
                    enemy = q;
                    break;
                  }
                }
              }
            }
          }
          if (!on) close(r);
        }
        close(R1 + 1);
      }
    }
    for (const l of scopedMoving) l.sort((a, b) => a.tick0 - b.tick0);
    return { available: true, airborne, flashed, scopedMoving, repeeks };
  },
};
