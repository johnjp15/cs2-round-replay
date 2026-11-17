/**
 * K8 table `strategy.hits`: per played round, the site the Ts committed to, when, with how many, the utility that
 * landed there in the seconds before, the lanes they came through, each T's part, and the result.
 *
 * - The site: the plant's site when there was a plant; else the first site whose area held `hitMinTs` living Ts at
 *   once; else none ("no hit": the round ended before the Ts went in, or they died first).
 * - Entry: the first sample with `hitMinTs` Ts in that site's area (a lone planter: his first sample there).
 *   Committed: the Ts in the area at any sample from `commitWindowSec` before the entry to `commitWindowSec` after.
 * - Utility before: T grenades that landed (detonated) in the site's area or in a lane leading to it, from
 *   `utilWindowSec` before the entry to `utilAfterSec` after. "Behind utility": at least `utilMin`, one a smoke or flash.
 * - Roles: entry (first committed T in), second (the next within `secondSec`), support (the other committed Ts and
 *   the living Ts near the hit), lurk (alive at the entry, outside the site's area and its lanes, ≥ `lurkDistance`
 *   from the entry point), dead (died before the entry).
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import type { Side, TeamId } from '../../model/match';
import { THROWS, type ThrowType } from '../utility/throws';
import { STRAT_GRID, sampleAt, type RoundGrid } from './grid';
import type { PlaceLookup, SiteId } from './knowledge';
import { STRATEGY_TUNING } from './tuning';

export type HitRole = 'entry' | 'second' | 'support' | 'lurk' | 'dead';
export type Timing = 'fast' | 'default' | 'late';

export interface HitUtil {
  smoke: number;
  flash: number;
  he: number;
  fire: number;
  total: number;
  /** `utility.throws` ids, in time order. */
  throws: number[];
}

export interface HitRow {
  round: number;
  tTeam: TeamId;
  ctTeam: TeamId;
  site: SiteId | null;
  /** The first site whose area held hitMinTs Ts at once, and when (differs from `site` after a fake or a re-hit). */
  firstSite: SiteId | null;
  firstSiteTick: number | null;
  /** First sample with hitMinTs Ts in the area (null: no hit). */
  entryTick: number | null;
  /** Seconds from freeze end to the entry. */
  entrySec: number | null;
  timing: Timing | null;
  plantTick: number | null;
  plantSite: SiteId | null;
  /** Committed Ts (slots, by arrival). */
  committed: number[];
  /** Mean position of the committed Ts at the entry (x, y). */
  entryAt: [number, number] | null;
  util: HitUtil;
  behindUtil: boolean;
  /** Lane ids the committed Ts came through (each T's last lane before the area), sorted, unique. */
  lanes: string[];
  /** Role of every T of the round (slot → role), for slots in the T roster. */
  roles: Record<number, HitRole>;
  winnerSide: Side | null;
}

function inArea(lookup: PlaceLookup, z: number, s: SiteId): boolean {
  return z >= 0 && lookup.siteOfZone(z) === s;
}

/** A lane (by index) that leads to site `s`. */
function laneTo(lookup: PlaceLookup, lane: number, s: SiteId): boolean {
  return lane >= 0 && lookup.k.lanes[lane]?.site === s;
}

function countIn(g: RoundGrid, k: number, P: number, slots: readonly number[], lookup: PlaceLookup, s: SiteId): number {
  let n = 0;
  for (const p of slots) if (inArea(lookup, g.zone[k * P + p] ?? -9, s)) n++;
  return n;
}

const SITES: readonly SiteId[] = ['A', 'B'];

export function emptyUtil(): HitUtil {
  return { smoke: 0, flash: 0, he: 0, fire: 0, total: 0, throws: [] };
}

export function buildHits(ctx: AnalysisContext): HitRow[] {
  const grid = ctx.table(STRAT_GRID);
  const lookup = grid.lookup;
  if (lookup === null) return [];
  const t = STRATEGY_TUNING.hits;
  const P = ctx.P;
  const rate = ctx.raw.header.tickRate || 64;
  const throws = ctx.table(THROWS);
  const out: HitRow[] = [];
  for (const g of grid.rounds) {
    const r = g.round;
    const S = g.ticks.length;
    let site: SiteId | null = g.plantSite;
    let entryK = -1;
    const lastK = sampleAt(g, g.cap);
    if (site !== null) {
      for (let k = 0; k <= lastK && entryK < 0; k++) if (countIn(g, k, P, g.T, lookup, site) >= t.hitMinTs) entryK = k;
      if (entryK < 0) for (let k = 0; k <= lastK && entryK < 0; k++) if (countIn(g, k, P, g.T, lookup, site) >= 1) entryK = k;
    } else {
      for (let k = 0; k <= lastK && entryK < 0; k++) {
        for (const s of SITES) if (countIn(g, k, P, g.T, lookup, s) >= t.hitMinTs) { site = s; entryK = k; break; }
      }
    }
    let firstSite: SiteId | null = null;
    let firstSiteTick: number | null = null;
    for (let k = 0; k <= lastK && firstSite === null; k++) {
      for (const s of SITES) if (countIn(g, k, P, g.T, lookup, s) >= t.hitMinTs) { firstSite = s; firstSiteTick = g.ticks[k] ?? null; break; }
    }
    const roles: Record<number, HitRole> = {};
    const util = emptyUtil();
    let committed: number[] = [];
    let entryAt: [number, number] | null = null;
    const lanes = new Set<string>();
    let entryTick: number | null = null;
    if (site !== null && entryK >= 0) {
      entryTick = g.ticks[entryK] ?? null;
      const w = Math.round((t.commitWindowSec * rate) / STRATEGY_TUNING.grid.sampleTicks);
      const arrive = new Map<number, number>();
      for (let k = Math.max(0, entryK - w); k <= Math.min(S - 1, entryK + w); k++) {
        for (const p of g.T) if (!arrive.has(p) && inArea(lookup, g.zone[k * P + p] ?? -9, site)) arrive.set(p, k);
      }
      // Only Ts still in the area at or after the entry commit (a T who walked through earlier and left does not).
      for (const [p] of [...arrive]) {
        let ok = false;
        for (let k = entryK; k <= Math.min(S - 1, entryK + w); k++) if (inArea(lookup, g.zone[k * P + p] ?? -9, site)) { ok = true; break; }
        if (!ok) arrive.delete(p);
      }
      committed = [...arrive.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([p]) => p);
      // Lanes they came through: each committed T's last lane sample before his arrival.
      for (const p of committed) {
        const a = arrive.get(p) ?? 0;
        for (let k = a; k >= 0; k--) {
          const l = g.lane[k * P + p] ?? -1;
          if (l >= 0) { const id = lookup.k.lanes[l]?.id; if (id !== undefined) lanes.add(id); break; }
        }
      }
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const p of committed) {
        const k = arrive.get(p) ?? entryK;
        sx += g.x[k * P + p] ?? 0; sy += g.y[k * P + p] ?? 0; n++;
      }
      entryAt = n > 0 ? [Math.round(sx / n), Math.round(sy / n)] : null;
      // Roles.
      const first = committed[0];
      const firstK = first !== undefined ? (arrive.get(first) ?? entryK) : entryK;
      const secondW = Math.round((t.secondSec * rate) / STRATEGY_TUNING.grid.sampleTicks);
      committed.forEach((p, i) => {
        if (i === 0) roles[p] = 'entry';
        else if (i === 1 && (arrive.get(p) ?? 0) - firstK <= secondW) roles[p] = 'second';
        else roles[p] = 'support';
      });
      for (const p of g.T) {
        if (roles[p] !== undefined) continue;
        const z = g.zone[entryK * P + p] ?? -9;
        if (z === -9) { roles[p] = 'dead'; continue; }
        const l = g.lane[entryK * P + p] ?? -1;
        const far = entryAt === null ? true : Math.hypot((g.x[entryK * P + p] ?? 0) - entryAt[0], (g.y[entryK * P + p] ?? 0) - entryAt[1]) >= t.lurkDistance;
        roles[p] = !inArea(lookup, z, site) && !laneTo(lookup, l, site) && far ? 'lurk' : 'support';
      }
      // Utility on the site and its lanes before the entry.
      const from = (entryTick ?? 0) - Math.round(t.utilWindowSec * rate);
      const to = (entryTick ?? 0) + Math.round(t.utilAfterSec * rate);
      const tTeamSlots = new Set(g.T);
      const laneNames = new Set(lookup.k.lanes.filter((l) => l.site === site).flatMap((l) => l.places));
      const areaNames = new Set(lookup.k.sites.find((s) => s.id === site)?.zones.flatMap((z) => lookup.k.zones[lookup.zoneById(z)]?.places ?? []) ?? []);
      for (const th of throws) {
        if (th.round !== r.number || !tTeamSlots.has(th.thrower) || th.detTick === null) continue;
        if (th.detTick < from || th.detTick > to) continue;
        if (!areaNames.has(th.landPlace) && !laneNames.has(th.landPlace)) continue;
        addUtil(util, th.type, th.id);
      }
    } else {
      for (const p of g.T) roles[p] = g.zone[(S - 1) * P + p] === -9 ? 'dead' : 'support';
    }
    const behindUtil = util.total >= t.utilMin && util.smoke + util.flash > 0;
    const entrySec = entryTick === null ? null : Math.round(((entryTick - g.t0) / rate) * 10) / 10;
    const timing: Timing | null = entrySec === null ? null : entrySec <= t.fastSec ? 'fast' : entrySec >= t.lateSec ? 'late' : 'default';
    out.push({
      round: r.number, tTeam: r.sides.T, ctTeam: r.sides.CT, site, firstSite, firstSiteTick, entryTick, entrySec, timing,
      plantTick: r.bomb.plantTick, plantSite: g.plantSite, committed, entryAt, util, behindUtil, lanes: [...lanes].sort(), roles, winnerSide: r.winnerSide,
    });
  }
  return out;
}

function addUtil(u: HitUtil, type: ThrowType, id: number): void {
  if (type === 'decoy') return;
  u[type]++;
  u.total++;
  u.throws.push(id);
}

export const STRAT_HITS: TableDef<HitRow[]> = { id: 'strategy.hits', build: buildHits };
