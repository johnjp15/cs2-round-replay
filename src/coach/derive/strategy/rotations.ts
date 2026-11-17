/**
 * K8 table `strategy.rotations`: per played round and CT who started on a site (his zone at setup time is on the A or
 * B side), whether he rotated to the other site, when, relative to the first hard information, and whether the site
 * he left or the one he went to was hit.
 *
 * - Information on a site (`info[s]`): the first sample with a plant there, `infoMinTs` living Ts in its area or in a
 *   lane leading to it shown on the CT radar at once (`spotted_by` holds a CT), or the bomb carrier shown there.
 *   or a fight there (damage between a CT and a T standing in its area or lanes). Lanes count only where the zone is a
 *   lane or the site itself (Mirage's Middle, a `mid` zone, says nothing about which site). The radar flag is sparse
 *   in GOTV demos, so fights carry most of the information.
 * - Rotated: after setup time he reached a zone that defends the other site within `rotateMaxSec` of his last sample
 *   on his own side (when he left), without passing through T territory (that is a flank, not a rotation). Early: he
 *   left more than `earlySlackSec` before any information on the site he went to (or there was none). Punished:
 *   early, and the Ts entered his own site within `punishSec` after he left.
 * - Stayed: information on the other site, the Ts hit it, and `stayGraceSec` after the information he was alive,
 *   still on his own side, with no T in his own site's area or lanes.
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { HURTS, type HurtRow } from '../hurts';
import { STRAT_GRID, Z_DEAD, sampleAt, type RoundGrid } from './grid';
import { STRAT_HITS } from './hits';
import type { PlaceLookup, SiteId } from './knowledge';
import { STRATEGY_TUNING } from './tuning';

export type InfoKind = 'plant' | 'seen' | 'bomb' | 'fight';

export interface SiteInfo {
  tick: number;
  kind: InfoKind;
  /** Ts shown there at that sample. */
  count: number;
}

export interface RotationRow {
  round: number;
  slot: number;
  home: SiteId;
  other: SiteId;
  rotated: boolean;
  leftTick: number | null;
  arriveTick: number | null;
  info: Record<SiteId, SiteInfo | null>;
  /** Seconds from the information on the site he went to, to his leaving (negative: before it). Null when either is missing. */
  leftVsInfoSec: number | null;
  early: boolean;
  hitSite: SiteId | null;
  punished: boolean;
  stayed: boolean;
}

/** A zone that tells about site s: its area, or a lane-kind zone of a lane leading to s. */
function aboutSite(lookup: PlaceLookup, z: number, lane: number, s: SiteId): boolean {
  if (z < 0) return false;
  if (lookup.siteOfZone(z) === s) return true;
  const zone = lookup.zone(z);
  return lane >= 0 && lookup.k.lanes[lane]?.site === s && zone?.kind === 'lane';
}

export function siteInfo(ctx: AnalysisContext, g: RoundGrid, lookup: PlaceLookup, s: SiteId, hurts: readonly HurtRow[]): SiteInfo | null {
  const P = ctx.P;
  const minTs = STRATEGY_TUNING.rotations.infoMinTs;
  const plant = g.plantSite === s ? g.round.bomb.plantTick : null;
  const tSet = new Set(g.T);
  const ctSet = new Set(g.CT);
  let fight: number | null = null;
  for (const h of hurts) {
    if (h.round !== g.round.number || !h.enemy || h.hurt.tick < g.t0) continue;
    const a = h.hurt.attacker;
    const v = h.hurt.victim;
    const tSlot = tSet.has(a) && ctSet.has(v) ? a : tSet.has(v) && ctSet.has(a) ? v : -1;
    if (tSlot < 0) continue;
    const k = Math.max(0, sampleAt(g, h.hurt.tick) - 1);
    if (aboutSite(lookup, g.zone[k * P + tSlot] ?? Z_DEAD, g.lane[k * P + tSlot] ?? -1, s)) { fight = h.hurt.tick; break; }
  }
  for (let k = 0; k < g.ticks.length; k++) {
    const tick = g.ticks[k] ?? 0;
    if (plant !== null && tick >= plant) return { tick: plant, kind: 'plant', count: 0 };
    if (fight !== null && tick >= fight) return { tick: fight, kind: 'fight', count: 1 };
    let n = 0;
    let bomb = false;
    for (const p of g.T) {
      const o = k * P + p;
      if ((g.seen[o] ?? 0) === 0) continue;
      if (!aboutSite(lookup, g.zone[o] ?? Z_DEAD, g.lane[o] ?? -1, s)) continue;
      n++;
      if ((g.carrier[k] ?? -1) === p) bomb = true;
    }
    if (n >= minTs) return { tick, kind: 'seen', count: n };
    if (bomb) return { tick, kind: 'bomb', count: n };
  }
  return null;
}

export function buildRotations(ctx: AnalysisContext): RotationRow[] {
  const grid = ctx.table(STRAT_GRID);
  const lookup = grid.lookup;
  if (lookup === null) return [];
  const hits = new Map(ctx.table(STRAT_HITS).map((h) => [h.round, h]));
  const hurts = ctx.table(HURTS);
  const rate = ctx.raw.header.tickRate || 64;
  const tr = STRATEGY_TUNING.rotations;
  const P = ctx.P;
  const out: RotationRow[] = [];
  for (const g of grid.rounds) {
    const r = g.round;
    const info: Record<SiteId, SiteInfo | null> = { A: siteInfo(ctx, g, lookup, 'A', hurts), B: siteInfo(ctx, g, lookup, 'B', hurts) };
    const ks = sampleAt(g, Math.min(g.end, g.t0 + Math.round(STRATEGY_TUNING.setup.setupSec * rate)));
    const hit = hits.get(r.number);
    const hitSite = hit?.site ?? null;
    for (const q of g.CT) {
      const z0 = g.zone[ks * P + q] ?? Z_DEAD;
      if (z0 < 0) continue;
      const grp = lookup.zone(z0)?.group;
      if (grp !== 'A' && grp !== 'B') continue;
      const home: SiteId = grp;
      const other: SiteId = home === 'A' ? 'B' : 'A';
      let arriveK = -1;
      let leftK = -1;
      let viaT = false;
      for (let k = ks; k < g.ticks.length; k++) {
        const z = g.zone[k * P + q] ?? Z_DEAD;
        if (z === Z_DEAD) break;
        if (z >= 0 && lookup.defends(z, home)) { leftK = k; viaT = false; }
        else if (z >= 0 && lookup.zone(z)?.group === 'T') viaT = true;
        if (z >= 0 && lookup.defends(z, other) && !lookup.defends(z, home)) { arriveK = k; break; }
      }
      const maxK = Math.round((tr.rotateMaxSec * rate) / STRATEGY_TUNING.grid.sampleTicks);
      const rotated = arriveK >= 0 && leftK >= 0 && !viaT && arriveK - leftK <= maxK;
      if (!rotated) arriveK = -1;
      const leftTick = rotated && leftK >= 0 ? (g.ticks[leftK] ?? null) : null;
      const arriveTick = rotated ? (g.ticks[arriveK] ?? null) : null;
      const inf = info[other];
      const leftVsInfoSec = leftTick !== null && inf !== null ? Math.round(((leftTick - inf.tick) / rate) * 10) / 10 : null;
      const early = rotated && leftTick !== null && (inf === null || leftTick < inf.tick - Math.round(tr.earlySlackSec * rate));
      // Stayed: information on the other site, it was hit, and he was still home after the grace time with no T near.
      let stayed = false;
      if (inf !== null && hitSite === other && (!rotated || (leftTick !== null && leftTick > inf.tick + Math.round(tr.stayGraceSec * rate)))) {
        const kg = sampleAt(g, inf.tick + Math.round(tr.stayGraceSec * rate));
        const z = g.zone[kg * P + q] ?? Z_DEAD;
        if (z >= 0 && lookup.defends(z, home) && (g.ticks[kg] ?? 0) <= g.end) {
          let threat = false;
          for (const p of g.T) if (aboutSite(lookup, g.zone[kg * P + p] ?? Z_DEAD, g.lane[kg * P + p] ?? -1, home)) threat = true;
          stayed = !threat;
        }
      }
      out.push({
        round: r.number, slot: q, home, other, rotated, leftTick, arriveTick, info, leftVsInfoSec, early, hitSite,
        punished: early && hitSite === home && leftTick !== null && hit?.entryTick !== null && hit?.entryTick !== undefined
          && hit.entryTick >= leftTick && hit.entryTick - leftTick <= Math.round(tr.punishSec * rate),
        stayed,
      });
    }
  }
  return out;
}

export const STRAT_ROTATIONS: TableDef<RotationRow[]> = { id: 'strategy.rotations', build: buildRotations };
