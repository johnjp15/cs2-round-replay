/**
 * K8: helpers shared by the strategy detectors and metrics: the user's rounds by side, zones drawn from the place
 * boxes, round boards, and the sample-size confidence of a pattern.
 */
import type { AnalysisContext } from '../../analyze/context';
import { boxPolygon, PLACE_BOXES } from '../../derive/strategy/boxes';
import { STRAT_GRID, Z_DEAD, sampleAt, type RoundGrid } from '../../derive/strategy/grid';
import { STRAT_HITS, type HitRow } from '../../derive/strategy/hits';
import type { KnowledgeLane, PlaceLookup, SiteId } from '../../derive/strategy/knowledge';
import { STRAT_LANES, type LaneRow } from '../../derive/strategy/lanes';
import { STRAT_SETUPS, type SetupRow } from '../../derive/strategy/setups';
import { STRATEGY_TUNING } from '../../derive/strategy/tuning';
import type { Side } from '../../model/match';
import type { Annotation, BoardDot, BoardZone, ColorRole, RoundBoard } from '../../model/report';
import { confidence, perMatch, roundsPlayedBy } from '../common';
import { roleOf } from '../utility/evidence';

export const ST = STRATEGY_TUNING;

export interface SideRound {
  g: RoundGrid;
  hit: HitRow;
  setup: SetupRow;
  lanes: LaneRow[];
}

/** The played rounds (with a strategy grid) in which the slot was on `side` and present, in order. */
export function sideRounds(ctx: AnalysisContext, slot: number, side: Side): SideRound[] {
  const grid = ctx.table(STRAT_GRID);
  if (grid.lookup === null) return [];
  const hits = new Map(ctx.table(STRAT_HITS).map((h) => [h.round, h]));
  const setups = new Map(ctx.table(STRAT_SETUPS).map((s) => [s.round, s]));
  const lanes = ctx.table(STRAT_LANES);
  const out: SideRound[] = [];
  for (const g of grid.rounds) {
    if (!g[side].includes(slot)) continue;
    const hit = hits.get(g.round.number);
    const setup = setups.get(g.round.number);
    if (hit === undefined || setup === undefined) continue;
    out.push({ g, hit, setup, lanes: lanes.filter((l) => l.round === g.round.number) });
  }
  return out;
}

export function lookupOf(ctx: AnalysisContext): PlaceLookup | null {
  return ctx.table(STRAT_GRID).lookup;
}

/** Zone annotations for a set of place names (one polygon per place box). */
export function placeZones(ctx: AnalysisContext, places: readonly string[], tick0: number, tick1: number, role: ColorRole, text?: string): Annotation[] {
  const boxes = ctx.table(PLACE_BOXES);
  const out: Annotation[] = [];
  for (const name of [...places].sort()) {
    const b = boxes.get(name);
    if (b === undefined) continue;
    out.push({ kind: 'zone', polygon: boxPolygon(b), tick0, tick1, role, ...(text !== undefined && out.length === 0 ? { label: text } : {}) });
  }
  return out;
}

export function boardZones(ctx: AnalysisContext, places: readonly string[], role: ColorRole, text?: string): BoardZone[] {
  const boxes = ctx.table(PLACE_BOXES);
  const out: BoardZone[] = [];
  for (const name of [...places].sort()) {
    const b = boxes.get(name);
    if (b === undefined) continue;
    out.push({ polygon: boxPolygon(b), role, ...(text !== undefined && out.length === 0 ? { label: text } : {}) });
  }
  return out;
}

/** The place names of a site's area. */
export function sitePlaces(lookup: PlaceLookup, s: SiteId): string[] {
  const site = lookup.k.sites.find((x) => x.id === s);
  if (site === undefined) return [];
  return site.zones.flatMap((z) => lookup.k.zones[lookup.zoneById(z)]?.places ?? []);
}

/** The living players as board dots at sample k: the user, his team and the enemy, by side colour. */
export function boardDots(ctx: AnalysisContext, g: RoundGrid, k: number, user: number): BoardDot[] {
  const P = ctx.P;
  const dots: BoardDot[] = [];
  for (const p of [...g.T, ...g.CT].sort((a, b) => a - b)) {
    const o = k * P + p;
    if ((g.zone[o] ?? Z_DEAD) === Z_DEAD) continue;
    const side = g.T.includes(p) ? 't' : 'ct';
    dots.push({ x: Math.round(g.x[o] ?? 0), y: Math.round(g.y[o] ?? 0), role: p === user ? 'user' : side, ...(p === user ? { label: 'you' } : {}) });
  }
  return dots;
}

export function board(ctx: AnalysisContext, g: RoundGrid, tick: number, user: number, zones: BoardZone[], caption: string, highlight: boolean, link?: { finding: string; evidence: number }): RoundBoard {
  return { round: g.round.number, caption, dots: boardDots(ctx, g, sampleAt(g, tick), user), zones, ...(highlight ? { highlight } : {}), ...(link ? { link } : {}) };
}

/** Circles on the user and labels on the given players at a tick (from the grid). */
export function markPlayers(ctx: AnalysisContext, g: RoundGrid, tick: number, user: number, players: readonly number[], tick0: number, tick1: number): Annotation[] {
  const P = ctx.P;
  const k = sampleAt(g, tick);
  const out: Annotation[] = [];
  for (const p of [...new Set([user, ...players])].sort((a, b) => a - b)) {
    const o = k * P + p;
    if ((g.zone[o] ?? Z_DEAD) === Z_DEAD) continue;
    const at: [number, number, number] = [Math.round(g.x[o] ?? 0), Math.round(g.y[o] ?? 0), 0];
    out.push({ kind: 'circle', center: at, radius: p === user ? 120 : 90, tick0, tick1, role: roleOf(ctx, user, p), ...(p === user ? { label: 'you' } : {}) });
  }
  return out;
}

export function laneOf(lookup: PlaceLookup, id: string): KnowledgeLane | null {
  return lookup.k.lanes.find((l) => l.id === id) ?? null;
}

/** The zone name of the slot at sample k ("dead", "unclassified" when unknown). */
export function zoneNameAt(lookup: PlaceLookup, g: RoundGrid, k: number, P: number, slot: number): string {
  const z = g.zone[k * P + slot] ?? Z_DEAD;
  if (z === Z_DEAD) return 'dead';
  if (z < 0) return 'unclassified';
  return lookup.zone(z)?.name ?? 'unclassified';
}

/** Group of the slot at sample k (null when dead or unclassified). */
export function groupAt(lookup: PlaceLookup, g: RoundGrid, k: number, P: number, slot: number): string | null {
  const z = g.zone[k * P + slot] ?? Z_DEAD;
  if (z < 0) return null;
  return lookup.zone(z)?.group ?? null;
}

/** "in Palace 3 times, in A site twice": the most common names first (ties by name). */
export function tally(names: readonly string[]): { name: string; n: number }[] {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** "in A site 3 times, dead once" from a tally of zone names. */
export function whereList(t: readonly { name: string; n: number }[]): string {
  return t.map((x) => (x.name === 'dead' ? `dead ${times(x.n)}` : `in ${x.name} ${times(x.n)}`)).join(', ');
}

export function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** Confidence of a pattern over `rounds` rounds (small samples by nature: the sample factor says so). */
export function patternConfidence(rounds: number): number {
  return confidence(ST.detect.precision, rounds, ST.detect.nScale);
}

/** Impact: rounds lost to the pattern, per 24 rounds, on the fights scale. */
export function patternImpact(ctx: AnalysisContext, slot: number, lost: number): number {
  return perMatch(lost * ST.detect.impactPerRound, roundsPlayedBy(ctx, slot));
}

export function won(r: SideRound, side: Side): boolean {
  return r.g.round.winnerSide === side;
}

export function secAfterFreeze(g: RoundGrid, tick: number, rate: number): number {
  return Math.round((tick - g.t0) / rate);
}
