/**
 * `strat.lane` (the "A Long" case): as CT, a lane the Ts took again and again with nobody contesting it in time, and
 * how those rounds ended, with the user's part (was he the player on that lane's site, and where he stood).
 * Definitions: docs/coach/strategy.md; thresholds: data/coach/tuning/strategy.json `detect.lane*`.
 */
import type { AnalysisContext } from '../../analyze/context';
import { sampleAt } from '../../derive/strategy/grid';
import type { KnowledgeLane, SiteId } from '../../derive/strategy/knowledge';
import type { LaneRow } from '../../derive/strategy/lanes';
import type { ChartPayload, Evidence, Finding } from '../../model/report';
import { plural } from '../../report/format';
import { makeFinding, pickClearest } from '../common';
import { secToTicks } from '../../derive/positioning/grid';
import type { Detector } from '../types';
import { replayAt } from '../utility/evidence';
import { board, boardZones, lookupOf, markPlayers, patternConfidence, patternImpact, placeZones, sideRounds, ST, tally, whereList, zoneNameAt, type SideRound } from './common';

export interface LaneStats {
  lane: KnowledgeLane;
  laneIndex: number;
  rounds: SideRound[];
  taken: SideRound[];
  open: SideRound[];
  /** Open rounds the Ts hit the lane's site through the lane and the CTs lost it or it was planted. */
  punished: SideRound[];
  openPlants: number;
  openLost: number;
}

function rowOf(r: SideRound, li: number): LaneRow | undefined {
  return r.lanes.find((l) => l.lane === li);
}

/** The key tick of a lane in a round: when the Ts were through (else the first T, else the setup time). */
export function laneTick(r: SideRound, li: number): number {
  const l = rowOf(r, li);
  return l?.throughTick ?? l?.firstTTick ?? r.setup.setupTick;
}

export function laneStats(ctx: AnalysisContext, slot: number): LaneStats[] {
  const lookup = lookupOf(ctx);
  if (lookup === null) return [];
  const rounds = sideRounds(ctx, slot, 'CT');
  return lookup.k.lanes.map((lane, li) => {
    const taken = rounds.filter((r) => rowOf(r, li)?.taken === true);
    const open = taken.filter((r) => rowOf(r, li)?.contested === false);
    const site = lane.site;
    const punished = open.filter((r) => site !== null && r.hit.site === site && r.hit.lanes.includes(lane.id) && (r.g.round.winnerSide === 'T' || r.g.plantSite === site));
    return {
      lane, laneIndex: li, rounds, taken, open, punished,
      openPlants: open.filter((r) => site !== null && r.g.plantSite === site).length,
      openLost: open.filter((r) => r.g.round.winnerSide === 'T').length,
    };
  });
}

function fires(s: LaneStats): boolean {
  const d = ST.detect;
  return s.lane.site !== null && s.taken.length >= d.laneMinTaken && s.open.length >= d.laneMinOpen
    && s.open.length / Math.max(1, s.taken.length) >= d.laneOpenShare && s.punished.length >= d.laneMinPunished;
}

/** The user's part in the open rounds: rounds he was on the lane's site side at setup, and where he stood then. */
function userPart(ctx: AnalysisContext, slot: number, s: LaneStats, site: SiteId): string {
  const lookup = lookupOf(ctx);
  if (lookup === null) return '';
  const P = ctx.P;
  const onSite: string[] = [];
  const elsewhere: string[] = [];
  for (const r of s.open) {
    const k = sampleAt(r.g, laneTick(r, s.laneIndex));
    const ks = sampleAt(r.g, r.setup.setupTick);
    const z = r.g.zone[ks * P + slot] ?? -9;
    const where = zoneNameAt(lookup, r.g, k, P, slot);
    if (z >= 0 && lookup.defends(z, site)) onSite.push(where);
    else elsewhere.push(zoneNameAt(lookup, r.g, ks, P, slot));
  }
  const n = s.open.length;
  if (onSite.length > 0) {
    const t = tally(onSite);
    const top = t[0];
    const stood = top === undefined ? '' : top.n === onSite.length ? (top.name === 'dead' ? 'were already dead each time' : `stood in ${top.name} each time`) : `were ${whereList(t)}`;
    return `You were the ${site} player in ${onSite.length} of them and ${stood} when they came through.`;
  }
  const t = tally(elsewhere);
  return `You played elsewhere in all ${n}: ${whereList(t)}.`;
}

function evidenceFor(ctx: AnalysisContext, slot: number, s: LaneStats, r: SideRound): Evidence {
  const li = s.laneIndex;
  const l = rowOf(r, li);
  const focus = laneTick(r, li);
  const t0 = focus - secToTicks(ctx.raw, 5);
  const t1 = focus + secToTicks(ctx.raw, 5);
  const anns = [
    ...placeZones(ctx, s.lane.places, t0, t1, 't', `${s.lane.name}: nobody contested`),
    ...markPlayers(ctx, r.g, focus, slot, l?.ts ?? [], t0, t1),
  ];
  const result = r.g.plantSite !== null ? `${r.g.plantSite} plant` : r.hit.site !== null ? `${r.hit.site} hit` : 'no plant';
  const outcome = r.g.round.winnerSide === 'CT' ? 'won' : 'lost';
  const caption = `Round ${r.g.round.number}: ${plural(l?.ts.length ?? 0, 'T')} walked through ${s.lane.name} untouched (first after ${Math.round(l?.firstTSec ?? 0)} s); ${result}, round ${outcome}`;
  return replayAt(ctx, r.g.round.number, focus, 5, 5, [slot, ...(l?.ts ?? [])], anns, caption);
}

export const laneDetector: Detector = {
  id: 'strat.lane', area: 'strategy', scope: 'macro', needs: ['knowledge'],
  run(ctx, slot, metric) {
    const all = laneStats(ctx, slot).filter(fires);
    if (all.length === 0) return [];
    const s = [...all].sort((a, b) => b.punished.length - a.punished.length || b.open.length - a.open.length || (a.lane.id < b.lane.id ? -1 : 1))[0] as LaneStats;
    const site = s.lane.site as SiteId;
    const n = s.rounds.length;
    const mv = metric('strat.lane.contest_share');
    const ends = [s.openPlants > 0 ? plural(s.openPlants, `${site} plant`) : '', `${s.openLost} lost`].filter((x) => x !== '').join(' and ');
    const evid = pickClearest(s.punished.length > 0 ? s.punished : s.open, (r) => (r.g.round.winnerSide === 'T' ? 2 : 0) + (r.g.plantSite === site ? 1 : 0), (r) => r.g.round.number, (r) => r.g.round.number, ST.detect.evidenceRounds);
    return [makeFinding({
      id: 'strat.lane.open', area: 'strategy', scope: 'macro', polarity: 'fix',
      title: `Contest ${s.lane.name} early`,
      summary: `They took ${s.lane.name} in ${s.taken.length} of your ${n} CT rounds, ${plural(s.open.length, 'time')} with nobody contesting it; those ${s.open.length} rounds ended in ${ends}. ${userPart(ctx, slot, s, site)}`,
      why: `${s.punished.length} of the ${s.open.length} open rounds went to ${site} through ${s.lane.name} and were lost or planted: an open lane gives them the site's entrance for free.`,
      advice: s.lane.counters.map((text) => ({ text })),
      metrics: mv !== null && Number.isFinite(mv.value) ? [mv] : [],
      evidence: evid.map((r) => evidenceFor(ctx, slot, s, r)),
      instances: s.open.length, opportunities: s.taken.length, rounds: s.open.map((r) => r.g.round.number),
      roundsLost: s.openLost, confidence: patternConfidence(n), impact: patternImpact(ctx, slot, s.punished.filter((r) => r.g.round.winnerSide === 'T').length),
    })];
  },
  charts(ctx, slot, _metric, findings) {
    return laneBoards(ctx, slot, findings);
  },
};

/** One board per CT round: every lane coloured by who held it (ct: contested, t: taken untouched), at the finding's lane tick. */
export function laneBoards(ctx: AnalysisContext, slot: number, findings: readonly Finding[]): Record<string, ChartPayload> {
  const f = findings.find((x) => x.id === 'strat.lane.open');
  const lookup = lookupOf(ctx);
  if (f === undefined || lookup === null) return {};
  const stats = laneStats(ctx, slot).filter(fires);
  const s = [...stats].sort((a, b) => b.punished.length - a.punished.length || b.open.length - a.open.length || (a.lane.id < b.lane.id ? -1 : 1))[0];
  if (s === undefined) return {};
  const boards = s.rounds.map((r) => {
    const l = rowOf(r, s.laneIndex);
    const role = l?.taken !== true ? 'neutral' : l.contested ? 'ct' : 't';
    const held = l?.taken !== true ? 'not taken' : l.contested ? 'contested' : 'taken untouched';
    const result = r.g.plantSite !== null ? `${r.g.plantSite} plant` : r.hit.site !== null ? `${r.hit.site} hit` : 'no hit';
    const evIndex = f.evidence.findIndex((e) => e.round === r.g.round.number);
    return board(ctx, r.g, laneTick(r, s.laneIndex), slot, boardZones(ctx, s.lane.places, role, s.lane.name),
      `R${r.g.round.number} · ${s.lane.name} ${held} · ${result} · ${r.g.round.winnerSide === 'CT' ? 'won' : 'lost'}`,
      s.punished.includes(r), evIndex >= 0 ? { finding: f.id, evidence: evIndex } : undefined);
  });
  return {
    'strat.lane': {
      kind: 'boards', area: 'strategy', title: `${s.lane.name} in your CT rounds`,
      caption: `Positions when the Ts were through ${s.lane.name} (or at ${ST.setup.setupSec} s when they never took it); the lane is amber when they took it untouched, blue when a CT contested it.`,
      boards,
      legend: [{ key: 't', label: 'taken untouched', role: 't' }, { key: 'ct', label: 'contested', role: 'ct' }, { key: 'neutral', label: 'not taken', role: 'neutral' }],
    },
  };
}
