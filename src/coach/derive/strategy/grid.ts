/**
 * K8 table `strategy.grid`: every played round from freeze end to its end, sampled every `grid.sampleTicks` ticks,
 * with each player's zone and lane (from the map knowledge and the demo's place names), whether an enemy has him on
 * the radar (`spotted_by` holds an enemy slot), his position, and who carries the bomb.
 *
 * Zone codes: ≥ 0 a zone index of the knowledge file; `Z_DEAD` dead or absent; `Z_NONE` alive with no place name;
 * `Z_UNKNOWN` a place name the file does not know (unclassified, never guessed).
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import type { MatchRound, Side } from '../../model/match';
import { FLAG, TEAM_CT, TEAM_T, rowAtOrAfter } from '../../model/raw';
import { knowledgeFor, PlaceLookup, type SiteId } from './knowledge';
import { STRATEGY_TUNING } from './tuning';

export const Z_DEAD = -9;
export const Z_NONE = -1;
export const Z_UNKNOWN = -2;

export interface RoundGrid {
  round: MatchRound;
  /** Freeze end tick (sample 0) and the round's end. */
  t0: number;
  end: number;
  /** The plant tick, or the end: lane takes and site hits are read before it. */
  cap: number;
  /** [S] demo tick and row of each sample. */
  ticks: number[];
  rows: number[];
  /** [S × P] zone code (see the file comment), lane index (−1 none), spotted by an enemy (0/1), x, y. */
  zone: Int16Array;
  lane: Int16Array;
  seen: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  /** [S] slot of the bomb carrier (−1: dropped, planted or unknown). */
  carrier: Int8Array;
  /** Slots of each side in this round (the roster at freeze end). */
  T: number[];
  CT: number[];
  /** The site the bomb was planted at (from the planter's place, else the knowledge file's site ids), or null. */
  plantSite: SiteId | null;
}

export interface StrategyGrid {
  lookup: PlaceLookup | null;
  rounds: RoundGrid[];
  /** Live player-samples per unclassified place name (sorted by name). */
  unknown: { name: string; samples: number }[];
}

export function sideOfSlot(g: RoundGrid, p: number): Side | null {
  if (g.T.includes(p)) return 'T';
  if (g.CT.includes(p)) return 'CT';
  return null;
}

/** Sample index at or after `tick` (clamped to the last sample). */
export function sampleAt(g: RoundGrid, tick: number): number {
  let lo = 0;
  let hi = g.ticks.length - 1;
  if (hi < 0) return 0;
  if (tick <= (g.ticks[0] ?? 0)) return 0;
  if (tick >= (g.ticks[hi] ?? 0)) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((g.ticks[mid] ?? 0) < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildRound(ctx: AnalysisContext, r: MatchRound, lookup: PlaceLookup, unknownCount: Map<string, number>): RoundGrid | null {
  const { raw } = ctx;
  if (!r.played || r.freezeEndTick === null) return null;
  const P = ctx.P;
  const step = Math.max(1, Math.round(STRATEGY_TUNING.grid.sampleTicks));
  const t0 = r.freezeEndTick;
  const end = r.endTick;
  const ticks: number[] = [];
  const rows: number[] = [];
  for (let tick = t0; tick <= end; tick += step) {
    const row = Math.min(raw.ticks.count - 1, rowAtOrAfter(raw.ticks, tick));
    ticks.push(tick);
    rows.push(row);
  }
  const S = ticks.length;
  const zone = new Int16Array(S * P).fill(Z_DEAD);
  const lane = new Int16Array(S * P).fill(-1);
  const seen = new Uint8Array(S * P);
  const x = new Float32Array(S * P);
  const y = new Float32Array(S * P);
  const T = [...r.roster[r.sides.T]];
  const CT = [...r.roster[r.sides.CT]];
  const enemyMask = new Uint16Array(P);
  for (const p of T) for (const q of CT) if (q < 16) enemyMask[p] = (enemyMask[p] ?? 0) | (1 << q);
  for (const p of CT) for (const q of T) if (q < 16) enemyMask[p] = (enemyMask[p] ?? 0) | (1 << q);
  for (let k = 0; k < S; k++) {
    const row = rows[k] ?? 0;
    for (let p = 0; p < P; p++) {
      const i = row * P + p;
      const o = k * P + p;
      const team = raw.ticks.team[i] ?? 0;
      if (raw.ticks.present[i] !== 1 || ((raw.ticks.flags[i] ?? 0) & FLAG.alive) === 0 || (team !== TEAM_T && team !== TEAM_CT)) continue;
      const place = raw.ticks.place[i] ?? 0;
      const z = lookup.zoneOfPlace[place] ?? Z_NONE;
      zone[o] = z;
      lane[o] = lookup.laneOfPlace[place] ?? -1;
      if (z === Z_UNKNOWN) {
        const name = raw.names.places[place] ?? '';
        unknownCount.set(name, (unknownCount.get(name) ?? 0) + 1);
      }
      seen[o] = ((raw.ticks.spottedBy[i] ?? 0) & (enemyMask[p] ?? 0)) !== 0 ? 1 : 0;
      x[o] = raw.ticks.x[i] ?? 0;
      y[o] = raw.ticks.y[i] ?? 0;
    }
  }
  // Bomb carrier: the T with c4 at freeze end, then pickups and drops; nobody after the plant.
  const carrier = new Int8Array(S).fill(-1);
  let who = -1;
  for (const inv of raw.inventories) if (inv.at === 'freeze_end' && inv.tick === t0 && inv.items.includes('c4')) who = inv.p;
  const evs = raw.events.bomb.filter((b) => b.tick > t0 && b.tick <= end && (b.kind === 'pickup' || b.kind === 'dropped' || b.kind === 'planted'));
  let e = 0;
  for (let k = 0; k < S; k++) {
    const tick = ticks[k] ?? 0;
    while (e < evs.length && (evs[e]?.tick ?? 0) <= tick) {
      const b = evs[e];
      if (b !== undefined) who = b.kind === 'pickup' ? b.p : -1;
      e++;
    }
    carrier[k] = who;
  }
  const g: RoundGrid = {
    round: r, t0, end, cap: r.bomb.plantTick ?? end, ticks, rows, zone, lane, seen, x, y, carrier, T, CT, plantSite: null,
  };
  g.plantSite = plantSiteOf(ctx, g, lookup);
  return g;
}

/** The site of the round's plant: the planter's zone at the plant, else the file's site-id table, else null. */
export function plantSiteOf(ctx: AnalysisContext, g: RoundGrid, lookup: PlaceLookup): SiteId | null {
  const b = g.round.bomb;
  if (b.plantTick === null) return null;
  const { raw } = ctx;
  if (b.planter >= 0) {
    const row = Math.max(0, rowAtOrAfter(raw.ticks, b.plantTick) - 1);
    const place = raw.ticks.place[row * ctx.P + b.planter] ?? 0;
    const z = lookup.zoneOfPlace[place] ?? Z_NONE;
    if (z >= 0) {
      const s = lookup.siteOfZone(z) ?? lookup.zone(z)?.site ?? null;
      if (s !== null) return s;
    }
  }
  for (const c of lookup.k.checkedAgainst) {
    const s = c.siteIds[String(b.site)];
    if (s !== undefined) return s;
  }
  return null;
}

export function buildGrid(ctx: AnalysisContext): StrategyGrid {
  const k = knowledgeFor(ctx.match.meta.map);
  if (k === null) return { lookup: null, rounds: [], unknown: [] };
  const lookup = new PlaceLookup(k, ctx.raw.names.places);
  const unknownCount = new Map<string, number>();
  const rounds: RoundGrid[] = [];
  for (const r of ctx.match.rounds) {
    const g = buildRound(ctx, r, lookup, unknownCount);
    if (g !== null) rounds.push(g);
  }
  const unknown = [...unknownCount.entries()].map(([name, samples]) => ({ name, samples })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { lookup, rounds, unknown };
}

export const STRAT_GRID: TableDef<StrategyGrid> = { id: 'strategy.grid', build: buildGrid };
