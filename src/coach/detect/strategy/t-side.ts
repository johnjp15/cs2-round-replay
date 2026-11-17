/**
 * `strat.t_side`: the user's team's site hits as T (site, timing, utility before the entry) with their results, and
 * the user's part in each (entry, second in, support, lurk, dead before the hit). A fix when the dry hits lose, a
 * strength when the hits behind utility win, an observation otherwise. Definitions: docs/coach/strategy.md
 * (`strategy.hits`).
 */
import type { AnalysisContext } from '../../analyze/context';
import type { HitRole } from '../../derive/strategy/hits';
import type { ChartPayload, Evidence, Finding } from '../../model/report';
import { plural } from '../../report/format';
import { makeFinding, pickClearest } from '../common';
import { secToTicks } from '../../derive/positioning/grid';
import type { Detector } from '../types';
import { replayAt } from '../utility/evidence';
import { board, boardZones, lookupOf, markPlayers, patternConfidence, patternImpact, placeZones, sideRounds, sitePlaces, ST, times, type SideRound } from './common';

const ROLE_TEXT: Record<HitRole, string> = { entry: 'entered first', second: 'went in second', support: 'came in behind', lurk: 'lurked', dead: 'were dead before the hit' };
const ROLES: readonly HitRole[] = ['entry', 'second', 'support', 'lurk', 'dead'];

function utilText(r: SideRound): string {
  const u = r.hit.util;
  const parts = [u.smoke > 0 ? plural(u.smoke, 'smoke') : '', u.flash > 0 ? plural(u.flash, 'flash', 'flashes') : '', u.he > 0 ? plural(u.he, 'HE') : '', u.fire > 0 ? plural(u.fire, 'molotov') : ''].filter((x) => x !== '');
  return parts.length > 0 ? parts.join(', ') : 'no utility';
}

function evidenceFor(ctx: AnalysisContext, slot: number, r: SideRound): Evidence {
  const lookup = lookupOf(ctx);
  const site = r.hit.site ?? 'A';
  const focus = r.hit.entryTick ?? r.setup.setupTick;
  const t0 = focus - secToTicks(ctx.raw, 6);
  const t1 = focus + secToTicks(ctx.raw, 6);
  const anns = [
    ...(lookup ? placeZones(ctx, sitePlaces(lookup, site), t0, t1, r.hit.behindUtil ? 'good' : 'bad', `${site}: ${utilText(r)} before the entry`) : []),
    ...markPlayers(ctx, r.g, focus, slot, r.hit.committed, t0, t1),
  ];
  const role = r.hit.roles[slot];
  const caption = `Round ${r.g.round.number}: ${site} hit with ${r.hit.committed.length} after ${Math.round(r.hit.entrySec ?? 0)} s, ${utilText(r)} before it; you ${role ? ROLE_TEXT[role] : 'were not there'}; round ${r.g.round.winnerSide === 'T' ? 'won' : 'lost'}`;
  return replayAt(ctx, r.g.round.number, focus, 6, 6, [slot, ...r.hit.committed], anns, caption);
}

export const tSideDetector: Detector = {
  id: 'strat.t_side', area: 'strategy', scope: 'macro', needs: ['knowledge'],
  run(ctx, slot, metric) {
    const all = sideRounds(ctx, slot, 'T');
    const hits = all.filter((r) => r.hit.site !== null);
    if (hits.length < ST.detect.tMinHits) return [];
    const dry = hits.filter((r) => !r.hit.behindUtil);
    const exec = hits.filter((r) => r.hit.behindUtil);
    const dw = dry.filter((r) => r.g.round.winnerSide === 'T').length;
    const ew = exec.filter((r) => r.g.round.winnerSide === 'T').length;
    const d = ST.detect;
    const fix = dry.length >= d.tMinDry && dw / dry.length <= d.tDryWinMax;
    const strength = !fix && exec.length >= d.tMinExec && ew / exec.length >= d.tExecWinMin;
    const polarity = fix ? 'fix' : strength ? 'strength' : 'observation';
    const sites = ['A', 'B'].map((s) => ({ s, n: hits.filter((r) => r.hit.site === s).length })).filter((x) => x.n > 0).map((x) => `${x.s} ${times(x.n)}`).join(', ');
    const timing = (['fast', 'default', 'late'] as const).map((t) => ({ t, n: hits.filter((r) => r.hit.timing === t).length })).filter((x) => x.n > 0)
      .map((x) => `${x.n} ${x.t === 'fast' ? `fast (by ${ST.hits.fastSec} s)` : x.t === 'late' ? `late (after ${ST.hits.lateSec} s)` : 'mid-round'}`).join(', ');
    const roleCount = ROLES.map((role) => ({ role, n: hits.filter((r) => r.hit.roles[slot] === role).length })).filter((x) => x.n > 0);
    const you = `You ${roleCount.map((x) => `${ROLE_TEXT[x.role]} ${times(x.n)}`).join(', ')}.`;
    const mine = hits.filter((r) => r.hit.roles[slot] === 'entry' || r.hit.roles[slot] === 'second');
    const mineWon = mine.filter((r) => r.g.round.winnerSide === 'T').length;
    const mv = metric('strat.t_side.util_share');
    const evid = pickClearest(fix ? dry : strength ? exec : hits,
      (r) => (r.hit.roles[slot] === 'entry' || r.hit.roles[slot] === 'second' ? 2 : 0) + (r.g.round.winnerSide === 'T' ? (fix ? 0 : 1) : (fix ? 1 : 0)),
      (r) => r.g.round.number, (r) => r.g.round.number, d.evidenceRounds);
    return [makeFinding({
      id: `strat.t_side.${polarity === 'fix' ? 'dry' : polarity === 'strength' ? 'executes' : 'hits'}`, area: 'strategy', scope: 'macro', polarity,
      title: fix ? 'Hit behind utility' : strength ? 'Your executes work' : 'How your T rounds went in',
      summary: `Your team hit a site in ${hits.length} of ${all.length} T rounds (${sites}; ${timing}): ${plural(dry.length, 'hit')} without a smoke or flash before the entry, ${dw} won; ${plural(exec.length, 'hit')} behind utility, ${ew} won. ${you}${mine.length > 0 ? ` The ${mine.length} where you were first or second in: ${mineWon} won.` : ''}`,
      why: fix
        ? `${dry.length - dw} of the ${dry.length} dry hits were lost: without a smoke or flash the first player in takes every angle at once.`
        : strength ? `${ew} of ${exec.length} hits behind utility won: keep doing it.` : `With ${hits.length} hits the split says little yet; it firms up across matches.`,
      advice: [
        { text: 'Before the entry, one smoke on the CT cross or rotation path and one flash over the entrance, thrown together; enter on the flash.' },
        { text: 'If the hit is fast, still bring one flash for the first player through.' },
      ],
      metrics: mv !== null && Number.isFinite(mv.value) ? [mv] : [],
      evidence: evid.map((r) => evidenceFor(ctx, slot, r)),
      instances: fix ? dry.length : strength ? exec.length : hits.length, opportunities: all.length,
      rounds: (fix ? dry : strength ? exec : hits).map((r) => r.g.round.number), roundsLost: hits.filter((r) => r.g.round.winnerSide !== 'T').length,
      confidence: patternConfidence(hits.length), impact: fix ? patternImpact(ctx, slot, dry.length - dw) : 0,
    })];
  },
  charts(ctx, slot, _metric, findings) {
    return tBoards(ctx, slot, findings);
  },
};

function tBoards(ctx: AnalysisContext, slot: number, findings: readonly Finding[]): Record<string, ChartPayload> {
  const f = findings.find((x) => x.id.startsWith('strat.t_side.'));
  const lookup = lookupOf(ctx);
  if (f === undefined || lookup === null) return {};
  const boards = sideRounds(ctx, slot, 'T').map((r) => {
    const site = r.hit.site;
    const ev = f.evidence.findIndex((e) => e.round === r.g.round.number);
    const role = r.hit.roles[slot];
    const zones = site !== null ? boardZones(ctx, sitePlaces(lookup, site), r.hit.behindUtil ? 'good' : 'bad', site) : [];
    const what = site === null ? 'no hit' : `${site} ${r.hit.timing ?? ''} hit, ${utilText(r)}`;
    return board(ctx, r.g, r.hit.entryTick ?? r.setup.setupTick, slot, zones,
      `R${r.g.round.number} · ${what} · you: ${role ?? '-'} · ${r.g.round.winnerSide === 'T' ? 'won' : 'lost'}`, false, ev >= 0 ? { finding: f.id, evidence: ev } : undefined);
  });
  return {
    'strat.t_side': {
      kind: 'boards', area: 'strategy', title: 'Your T-side hits, per round', caption: 'Positions at the entry; the site is green when the hit came behind a smoke or flash, red when dry.', boards,
      legend: [{ key: 'good', label: 'behind utility', role: 'good' }, { key: 'bad', label: 'dry', role: 'bad' }],
    },
  };
}
