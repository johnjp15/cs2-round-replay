/**
 * `strat.rotate`: as CT, rotations that left the user's site before any information and the Ts then hit it, and
 * rounds where the information on the other site was there and he stayed. Definitions: docs/coach/strategy.md
 * (`strategy.rotations`).
 */
import type { AnalysisContext } from '../../analyze/context';
import { STRAT_ROTATIONS, type RotationRow } from '../../derive/strategy/rotations';
import type { ChartPayload, Evidence, Finding } from '../../model/report';
import { plural } from '../../report/format';
import { makeFinding, pickClearest } from '../common';
import { secToTicks } from '../../derive/positioning/grid';
import type { Detector } from '../types';
import { replayAt } from '../utility/evidence';
import { board, boardZones, lookupOf, markPlayers, patternConfidence, patternImpact, placeZones, sideRounds, sitePlaces, ST, type SideRound } from './common';

export function userRotations(ctx: AnalysisContext, slot: number): RotationRow[] {
  return ctx.table(STRAT_ROTATIONS).filter((r) => r.slot === slot);
}

function focusOf(ctx: AnalysisContext, r: RotationRow): number {
  if (r.punished || (r.rotated && r.early)) return r.leftTick ?? 0;
  const inf = r.info[r.other];
  return inf !== null ? inf.tick + secToTicks(ctx.raw, ST.rotations.stayGraceSec) : 0;
}

function evidenceFor(ctx: AnalysisContext, slot: number, r: RotationRow, sr: SideRound): Evidence {
  const lookup = lookupOf(ctx);
  const focus = focusOf(ctx, r);
  const t0 = focus - secToTicks(ctx.raw, 6);
  const t1 = focus + secToTicks(ctx.raw, 6);
  const stay = !r.punished;
  const site = stay ? r.other : r.home;
  const anns = [
    ...(lookup ? placeZones(ctx, sitePlaces(lookup, site), t0, t1, 'bad', stay ? `${r.other}: information` : `${r.home}: you left it`) : []),
    ...markPlayers(ctx, sr.g, focus, slot, sr.hit.committed, t0, t1),
  ];
  const inf = r.info[r.other];
  const caption = stay
    ? `Round ${r.round}: ${inf?.kind === 'plant' ? 'the bomb was down' : inf?.kind === 'fight' ? 'the fight was' : 'they were seen'} on ${r.other} and ${ST.rotations.stayGraceSec} s later you were still on ${r.home}; round ${sr.g.round.winnerSide === 'CT' ? 'won' : 'lost'}`
    : `Round ${r.round}: you left ${r.home} with no information on ${r.other}; they entered ${r.home} ${Math.round(((sr.hit.entryTick ?? 0) - (r.leftTick ?? 0)) / (ctx.raw.header.tickRate || 64))} s later`;
  return replayAt(ctx, r.round, focus, 6, 6, [slot, ...sr.hit.committed], anns, caption);
}

export const rotateDetector: Detector = {
  id: 'strat.rotate', area: 'strategy', scope: 'macro', needs: ['knowledge'],
  run(ctx, slot, metric) {
    const rounds = new Map(sideRounds(ctx, slot, 'CT').map((r) => [r.g.round.number, r]));
    const rows = userRotations(ctx, slot).filter((r) => rounds.has(r.round));
    const punished = rows.filter((r) => r.punished);
    const stayed = rows.filter((r) => r.stayed);
    if (punished.length + stayed.length < ST.detect.rotateMin) return [];
    const bad = [...punished, ...stayed];
    const lost = bad.filter((r) => rounds.get(r.round)?.g.round.winnerSide === 'T').length;
    const mv = metric('strat.rotate.mistake_share');
    const parts = [
      punished.length > 0 ? `${plural(punished.length, 'time')} you left your site before any information on the other one and they hit yours within ${ST.rotations.punishSec} s` : '',
      stayed.length > 0 ? `${plural(stayed.length, 'time')} the information on the other site was there (${stayed.map((r) => r.info[r.other]?.kind ?? '').filter((x) => x !== '').map((k) => (k === 'plant' ? 'a plant' : k === 'fight' ? 'a fight' : k === 'bomb' ? 'the bomb seen' : 'Ts seen')).join(', ')}) and you were still on yours ${ST.rotations.stayGraceSec} s later` : '',
    ].filter((x) => x !== '');
    const evid = pickClearest(bad, (r) => (rounds.get(r.round)?.g.round.winnerSide === 'T' ? 1 : 0), (r) => r.round, (r) => r.round, ST.detect.evidenceRounds);
    return [makeFinding({
      id: 'strat.rotate.timing', area: 'strategy', scope: 'macro', polarity: 'fix',
      title: 'Rotate on information, not on a feeling',
      summary: `In your ${rows.length} CT rounds as a site player, ${parts.join('; ')}; ${lost} of these ${bad.length} rounds were lost.`,
      why: 'Leaving early hands them an empty site; staying after the call leaves your team a player short in the fight that decides the round.',
      advice: [
        { text: 'Hold your site until there is a call: a plant, two or more seen, the bomb, or a fight on the other site. Then go at once, by the shortest safe path.' },
        { text: 'When the call comes and nothing is on your site, the first rotation is yours: say so and move; the anchor keeps the site.' },
      ],
      metrics: mv !== null && Number.isFinite(mv.value) ? [mv] : [],
      evidence: evid.map((r) => evidenceFor(ctx, slot, r, rounds.get(r.round) as SideRound)),
      instances: bad.length, opportunities: rows.length, rounds: bad.map((r) => r.round), roundsLost: lost,
      confidence: patternConfidence(rows.length), impact: patternImpact(ctx, slot, lost),
    })];
  },
  charts(ctx, slot, _metric, findings) {
    return rotateBoards(ctx, slot, findings);
  },
};

function rotateBoards(ctx: AnalysisContext, slot: number, findings: readonly Finding[]): Record<string, ChartPayload> {
  const f = findings.find((x) => x.id === 'strat.rotate.timing');
  const lookup = lookupOf(ctx);
  if (f === undefined || lookup === null) return {};
  const rows = new Map(userRotations(ctx, slot).map((r) => [r.round, r]));
  const boards = sideRounds(ctx, slot, 'CT').map((sr) => {
    const r = rows.get(sr.g.round.number);
    const ev = f.evidence.findIndex((e) => e.round === sr.g.round.number);
    const what = r === undefined ? 'not on a site' : r.punished ? `left ${r.home} early, ${r.home} hit` : r.stayed ? `stayed on ${r.home} after the ${r.other} call` : r.rotated ? `rotated ${r.home}→${r.other}` : `held ${r.home}`;
    const tick = r !== undefined && (r.punished || r.stayed) ? focusOf(ctx, r) : sr.hit.entryTick ?? sr.setup.setupTick;
    const zones = r !== undefined ? boardZones(ctx, sitePlaces(lookup, r.home), r.punished ? 'bad' : 'ct', r.home) : [];
    return board(ctx, sr.g, tick, slot, zones, `R${sr.g.round.number} · ${what} · ${sr.g.round.winnerSide === 'CT' ? 'won' : 'lost'}`,
      r !== undefined && (r.punished || r.stayed), ev >= 0 ? { finding: f.id, evidence: ev } : undefined);
  });
  return { 'strat.rotate': { kind: 'boards', area: 'strategy', title: 'Your rotations, per CT round', caption: 'Positions at the moment that decided the rotation; your starting site is drawn.', boards } };
}
