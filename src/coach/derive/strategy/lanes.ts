/**
 * K8 table `strategy.lanes`: per played round and lane of the map knowledge, how the Ts took it and whether a CT
 * contested it in time.
 *
 * - First T: the first sample before the cap (the plant, else the round end) with a living T in one of the lane's
 *   places. Taken: at least `takeMinTs` Ts entered before the cap. `enteredBy[i]`: distinct Ts who had entered by
 *   checkpoint i (seconds after freeze end); `maxTs`: the most Ts in it at once before the cap.
 * - Contested in time, from freeze end until the Ts were through the lane (the first of its Ts on the lane's site;
 *   for a lane without a site, or when none got through, the last T in it) plus `contestSec`, at most the cap: a CT
 *   stood in the lane (`body`), had a T in the lane on his radar through his own sight (`sight`: the T's
 *   `spotted_by` holds the CT), dealt damage to a T in the lane or from inside it (`damage`), or a CT grenade
 *   landed in it (`grenade`). One entry per CT and kind, the first.
 * - The CTs gave it up: the last sample with a CT in the lane before the cap (`ctLastTick`) and why he was gone
 *   after it (`died`, `left`, or `held` when one was still there at the cap).
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import type { Side } from '../../model/match';
import { rowAtOrAfter } from '../../model/raw';
import { HURTS } from '../hurts';
import { THROWS } from '../utility/throws';
import { STRAT_GRID, Z_DEAD, sampleAt } from './grid';
import { STRAT_HITS, type HitRow } from './hits';
import type { SiteId } from './knowledge';
import { STRATEGY_TUNING, checkpoints } from './tuning';

export type ContestKind = 'body' | 'sight' | 'damage' | 'grenade';

export interface Contest {
  slot: number;
  how: ContestKind;
  tick: number;
}

export interface LaneRow {
  round: number;
  /** Index into the knowledge file's lanes, and its id. */
  lane: number;
  laneId: string;
  site: SiteId | null;
  taken: boolean;
  firstTTick: number | null;
  firstTSlot: number;
  /** Seconds from freeze end to the first T. */
  firstTSec: number | null;
  /** When the Ts were through: the first T of the lane on its site (else the last T in the lane); null when not taken. */
  throughTick: number | null;
  enteredBy: number[];
  maxTs: number;
  /** Ts who entered before the cap (slots, ascending). */
  ts: number[];
  contested: boolean;
  contests: Contest[];
  /** CTs who contested (slots, ascending). */
  contesters: number[];
  ctLastTick: number | null;
  ctGaveUp: 'died' | 'left' | 'held' | null;
  /** The round's result (from `strategy.hits`). */
  hitSite: SiteId | null;
  planted: boolean;
  plantSite: SiteId | null;
  winnerSide: Side | null;
}

export function buildLanes(ctx: AnalysisContext): LaneRow[] {
  const grid = ctx.table(STRAT_GRID);
  const lookup = grid.lookup;
  if (lookup === null) return [];
  const hits = new Map<number, HitRow>(ctx.table(STRAT_HITS).map((h) => [h.round, h]));
  const hurts = ctx.table(HURTS);
  const throws = ctx.table(THROWS);
  const P = ctx.P;
  const rate = ctx.raw.header.tickRate || 64;
  const cps = checkpoints();
  const tl = STRATEGY_TUNING.lanes;
  const out: LaneRow[] = [];
  for (const g of grid.rounds) {
    const r = g.round;
    const hit = hits.get(r.number);
    const lastK = sampleAt(g, g.cap);
    const ctSet = new Set(g.CT);
    const tSet = new Set(g.T);
    lookup.k.lanes.forEach((ln, li) => {
      const places = new Set(ln.places);
      const placeIds = new Set<number>();
      ctx.raw.names.places.forEach((n, id) => { if (places.has(n)) placeIds.add(id); });
      let firstK = -1;
      let firstSlot = -1;
      let maxTs = 0;
      const entered = new Map<number, number>();
      for (let k = 0; k <= lastK; k++) {
        let n = 0;
        for (const p of g.T) {
          if ((g.lane[k * P + p] ?? -1) !== li) continue;
          n++;
          if (!entered.has(p)) entered.set(p, g.ticks[k] ?? 0);
          if (firstK < 0) { firstK = k; firstSlot = p; }
        }
        if (n > maxTs) maxTs = n;
      }
      const firstTTick = firstK >= 0 ? (g.ticks[firstK] ?? null) : null;
      const taken = entered.size >= tl.takeMinTs && firstK >= 0;
      const enteredBy = cps.map((sec) => [...entered.values()].filter((tk) => tk <= g.t0 + sec * rate).length);
      // In time: before the Ts were through the lane (the first T of the lane on its site), plus contestSec.
      let throughK = -1;
      if (firstK >= 0) {
        for (let k = firstK; k <= lastK && throughK < 0; k++) {
          for (const p of entered.keys()) {
            const z = g.zone[k * P + p] ?? Z_DEAD;
            if (ln.site !== null && z >= 0 && lookup.siteOfZone(z) === ln.site && (entered.get(p) ?? Infinity) <= (g.ticks[k] ?? 0)) { throughK = k; break; }
          }
        }
        if (throughK < 0) for (let k = lastK; k >= firstK && throughK < 0; k--) for (const p of g.T) if ((g.lane[k * P + p] ?? -1) === li) { throughK = k; break; }
      }
      const throughTick = throughK >= 0 ? (g.ticks[throughK] ?? null) : null;
      const windowEnd = throughTick !== null ? Math.min(g.cap, throughTick + Math.round(tl.contestSec * rate)) : g.cap;
      const endK = sampleAt(g, windowEnd);
      const contests: Contest[] = [];
      const have = new Set<string>();
      const add = (slot: number, how: ContestKind, tick: number): void => {
        const key = `${slot}:${how}`;
        if (have.has(key)) return;
        have.add(key);
        contests.push({ slot, how, tick });
      };
      for (let k = 0; k <= endK; k++) {
        const tick = g.ticks[k] ?? 0;
        for (const q of g.CT) if ((g.lane[k * P + q] ?? -1) === li) add(q, 'body', tick);
        // Sight: a T in the lane with this CT in his spotted_by.
        const row = g.rows[k] ?? 0;
        for (const p of g.T) {
          if ((g.lane[k * P + p] ?? -1) !== li) continue;
          const mask = ctx.raw.ticks.spottedBy[row * P + p] ?? 0;
          for (const q of g.CT) if (q < 16 && (mask & (1 << q)) !== 0 && (g.zone[k * P + q] ?? Z_DEAD) !== Z_DEAD) add(q, 'sight', tick);
        }
      }
      for (const h of hurts) {
        if (h.round !== r.number || !h.enemy) continue;
        const tick = h.hurt.tick;
        if (tick < g.t0 || tick > windowEnd) continue;
        const a = h.hurt.attacker;
        const v = h.hurt.victim;
        if (!ctSet.has(a) || !tSet.has(v)) continue;
        const row = Math.max(0, rowAtOrAfter(ctx.raw.ticks, tick) - 1);
        const vp = ctx.raw.ticks.place[row * P + v] ?? 0;
        const ap = ctx.raw.ticks.place[row * P + a] ?? 0;
        if (placeIds.has(vp) || placeIds.has(ap)) add(a, 'damage', tick);
      }
      for (const th of throws) {
        if (th.round !== r.number || !ctSet.has(th.thrower) || th.detTick === null || th.type === 'decoy') continue;
        if (th.detTick < g.t0 || th.detTick > windowEnd) continue;
        if (places.has(th.landPlace)) add(th.thrower, 'grenade', th.detTick);
      }
      contests.sort((a, b) => a.tick - b.tick || a.slot - b.slot || (a.how < b.how ? -1 : a.how > b.how ? 1 : 0));
      let ctLastK = -1;
      let lastSlot = -1;
      for (let k = 0; k <= lastK; k++) for (const q of g.CT) if ((g.lane[k * P + q] ?? -1) === li) { ctLastK = k; lastSlot = q; }
      let gaveUp: LaneRow['ctGaveUp'] = null;
      if (ctLastK >= 0) {
        if (ctLastK >= lastK) gaveUp = 'held';
        else gaveUp = (g.zone[(ctLastK + 1) * P + lastSlot] ?? Z_DEAD) === Z_DEAD ? 'died' : 'left';
      }
      out.push({
        round: r.number, lane: li, laneId: ln.id, site: ln.site, taken, firstTTick, firstTSlot: firstSlot,
        firstTSec: firstTTick === null ? null : Math.round(((firstTTick - g.t0) / rate) * 10) / 10, throughTick,
        enteredBy, maxTs, ts: [...entered.keys()].sort((a, b) => a - b),
        contested: contests.length > 0, contests, contesters: [...new Set(contests.map((c) => c.slot))].sort((a, b) => a - b),
        ctLastTick: ctLastK >= 0 ? (g.ticks[ctLastK] ?? null) : null, ctGaveUp: gaveUp,
        hitSite: hit?.site ?? null, planted: r.bomb.plantTick !== null, plantSite: g.plantSite, winnerSide: r.winnerSide,
      });
    });
  }
  return out;
}

export const STRAT_LANES: TableDef<LaneRow[]> = { id: 'strategy.lanes', build: buildLanes };
