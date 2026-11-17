/**
 * K6 table `sight.death_context`: every death by an enemy's gun or knife (K4's `DEATHS`; grenade, fire and world
 * deaths are left out) labelled from sight (docs/coach/sight.md, "Death context"; thresholds in sight.json
 * `deathContext`). A death can carry several labels.
 *
 * - `unseen`: the victim did not see the killer on any row of the lookbackSec before the death (checked on every row,
 *   not only the table's samples); `behind` when the
 *   killer was more than behindDeg off the victim's view yaw at death, `side` beyond the view's half-width, else
 *   `front` (hidden by a wall, a smoke or too small a sliver); `through` from the kill event's flags.
 * - `crossfire`: two or more enemies saw the victim on the row before the death.
 * - `repeek`: inside the repeekSec before the death the victim was hurt by an enemy, or killed one, within
 *   repeekRadius of where he died; after that no enemy saw him for at least hideSec; he came back into an enemy's
 *   sight and died within repeekSec of it.
 * - `objective`: planting or defusing.
 * - `open`: the killer had line of sight to the victim on every row of the openSec before the death, and the victim
 *   moved at least openMinMove units in it: no cover on the approach.
 */
import type { TableDef } from '../../analyze/context';
import { DEATHS, type DeathRow } from '../positioning/deaths';
import { isGun } from '../economy/prices';
import { wrap180 } from '../aim/geom';
import { rowAtOrAfter } from '../../model/raw';
import { SEE, SIGHTINGS } from './sightings';
import { SIGHT_TUNING } from './tuning';

export type DeathLabel = 'unseen' | 'crossfire' | 'repeek' | 'objective' | 'open';
export const DEATH_LABELS: readonly DeathLabel[] = ['unseen', 'crossfire', 'repeek', 'objective', 'open'];
/** Labels a player can change by playing differently (the finding ranks these). */
export const AVOIDABLE: readonly DeathLabel[] = ['unseen', 'crossfire', 'repeek', 'open'];

export interface DeathContext {
  readonly death: DeathRow;
  readonly labels: readonly DeathLabel[];
  /** unseen: the killer's angle off the victim's view yaw at death (degrees, 0–180), and whether that is behind. */
  readonly offDeg: number;
  readonly behind: boolean;
  /** Where the killer was against the victim's view at death: inside the view frustum's width, beside it, or behind (behindDeg). */
  readonly direction: 'front' | 'side' | 'behind';
  /** The kill went through smoke or a wall (the kill event's flags). */
  readonly through: 'smoke' | 'wall' | null;
  /** The victim was blind on the row before the death (the sightings' blind rows). */
  readonly blind: boolean;
  /** Enemies who saw the victim on the row before the death. */
  readonly seenBy: readonly number[];
  /** repeek: the tick of the earlier hit or kill and of coming back into sight. */
  readonly repeekFrom: number | null;
  readonly repeekBack: number | null;
  /** The victim saw the killer before dying: first tick in the lookback (null if not). */
  readonly sawKillerTick: number | null;
}

export interface DeathContextTables {
  readonly available: boolean;
  readonly rows: readonly DeathContext[];
}

export const DEATH_CONTEXT: TableDef<DeathContextTables> = {
  id: 'sight.death_context',
  build(ctx) {
    const tab = ctx.table(SIGHTINGS);
    if (!tab.available) return { available: false, rows: [] };
    const raw = ctx.raw;
    const T = raw.ticks;
    const P = ctx.P;
    const rate = raw.header.tickRate || 64;
    const c = SIGHT_TUNING.deathContext;
    const see = (r: number, o: number, t: number): number => tab.state[(r * P + o) * P + t] ?? 0;
    const rowOf = (tick: number): number => Math.min(T.count - 1, rowAtOrAfter(T, tick));
    const out: DeathContext[] = [];
    const lt = ctx.los?.tuning;
    const halfView = lt === undefined ? 53.1 : (Math.atan((Math.tan((lt.fovDeg * Math.PI) / 360) / lt.fovAspect) * lt.aspect) * 180) / Math.PI;
    for (const d of ctx.table(DEATHS)) {
      if (!d.byEnemy || d.killer < 0) continue;
      if (!isGun(d.weapon) && d.weapon !== 'knife') continue;
      const v = d.victim;
      const k = d.killer;
      const vr = Math.max(0, rowOf(d.tick) - 1);
      const labels: DeathLabel[] = [];
      const enemies = ctx.match.players.filter((pl) => pl.team !== d.team).map((pl) => pl.slot);

      // unseen
      const look0 = rowOf(d.tick - Math.round(c.lookbackSec * rate));
      // Exact on every row (the table can miss a glimpse shorter than its step between two samples).
      let sawKillerTick: number | null = null;
      for (let r = look0; r <= vr; r++) {
        if ((see(r, v, k) & SEE.seen) !== 0 || (tab.probe !== null && (tab.probe.eval(r, v, k) & SEE.seen) !== 0)) {
          sawKillerTick = T.tick[r] ?? null;
          break;
        }
      }
      const vi = vr * P + v;
      const ki = vr * P + k;
      const toKiller = (Math.atan2((T.y[ki] ?? 0) - (T.y[vi] ?? 0), (T.x[ki] ?? 0) - (T.x[vi] ?? 0)) * 180) / Math.PI;
      const offDeg = Math.round(Math.abs(wrap180(toKiller - (T.yaw[vi] ?? 0))) * 10) / 10;
      if (sawKillerTick === null) labels.push('unseen');

      // crossfire
      const seenBy = enemies.filter((q) => (see(vr, q, v) & SEE.seen) !== 0);
      if (seenBy.length >= 2) labels.push('crossfire');

      // repeek
      const w0 = d.tick - Math.round(c.repeekSec * rate);
      let from: number | null = null;
      const near = (tick: number): boolean => {
        const i = rowOf(tick) * P + v;
        return Math.hypot((T.x[i] ?? 0) - d.victimPos[0], (T.y[i] ?? 0) - d.victimPos[1]) <= c.repeekRadius;
      };
      for (const h of raw.events.hurts) {
        if (h.tick < w0) continue;
        if (h.tick >= d.tick) break;
        if (h.victim === v && h.attacker >= 0 && enemies.includes(h.attacker) && near(h.tick)) from = h.tick;
      }
      for (const kk of raw.events.kills) {
        if (kk.tick < w0) continue;
        if (kk.tick >= d.tick) break;
        if (kk.attacker === v && enemies.includes(kk.victim) && near(kk.tick)) from = Math.max(from ?? -Infinity, kk.tick);
      }
      let back: number | null = null;
      if (from !== null) {
        const hide = Math.max(1, Math.round(c.hideSec * rate));
        let unseenRun = 0;
        let hid = false;
        for (let r = rowOf(from) + 1; r <= vr; r++) {
          const any = enemies.some((q) => (see(r, q, v) & SEE.seen) !== 0);
          if (!any) {
            unseenRun++;
            if (unseenRun >= hide) hid = true;
          } else {
            if (hid && back === null) back = T.tick[r] ?? null;
            unseenRun = 0;
          }
        }
        if (back !== null && d.tick - back <= c.repeekSec * rate) labels.push('repeek');
        else back = null;
      }

      if (d.planting || d.defusing) labels.push('objective');

      // open
      const o0 = rowOf(d.tick - Math.round(c.openSec * rate));
      let open = o0 < vr;
      for (let r = o0; r <= vr && open; r++) if ((see(r, k, v) & SEE.los) === 0) open = false;
      if (open) {
        const i0 = o0 * P + v;
        if (Math.hypot((T.x[i0] ?? 0) - d.victimPos[0], (T.y[i0] ?? 0) - d.victimPos[1]) < c.openMinMove) open = false;
      }
      if (open) labels.push('open');

      const kev = raw.events.kills[d.k];
      out.push({
        death: d, labels, offDeg, behind: offDeg > c.behindDeg, direction: offDeg > c.behindDeg ? 'behind' : offDeg > halfView ? 'side' : 'front',
        through: kev?.thruSmoke === true ? 'smoke' : (kev?.penetrated ?? 0) > 0 ? 'wall' : null, blind: tab.blind[vr * P + v] === 1, seenBy, repeekFrom: back !== null ? from : null, repeekBack: back, sawKillerTick,
      });
    }
    return { available: true, rows: out };
  },
};
