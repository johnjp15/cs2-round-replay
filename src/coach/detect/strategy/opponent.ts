/**
 * `strat.opponent`: what the other team kept doing in a half (`strategy.repeats`) and whether the user's team
 * answered it.
 * - User on CT: the Ts' most repeated site or lane of their hits (`site:*`, `via:*`). Answered, in each repeat after
 *   the second: at least two CTs on that site at the entry (site), or the lane contested (lane).
 * - User on T: the CTs' most repeated light site at setup time (`light:*`). Answered: the user's team hit that site.
 * A fix when the later repeats went mostly unanswered and at least two of them were lost; an observation otherwise.
 */
import type { AnalysisContext } from '../../analyze/context';
import { STRAT_REPEATS, type Repeat } from '../../derive/strategy/repeats';
import type { Side } from '../../model/match';
import type { Evidence } from '../../model/report';
import { makeFinding, pickClearest } from '../common';
import type { Detector } from '../types';
import { replayAt } from '../utility/evidence';
import { laneOf, lookupOf, markPlayers, patternConfidence, patternImpact, placeZones, sideRounds, sitePlaces, ST, type SideRound } from './common';

interface Pick {
  side: Side;
  rep: Repeat;
  half: number[];
}

function choose(ctx: AnalysisContext, slot: number): Pick | null {
  const team = ctx.teamOf(slot);
  if (team === null) return null;
  let best: Pick | null = null;
  for (const h of ctx.table(STRAT_REPEATS)) {
    if (h.team === team || h.rounds.length < ST.detect.opponentMinRounds) continue;
    const mySide: Side = h.side === 'T' ? 'CT' : 'T';
    const keys = h.choices.filter((c) => c.repeats && (mySide === 'CT' ? c.key.startsWith('site:') || c.key.startsWith('via:') : c.key.startsWith('light:')));
    const top = keys[0];
    if (top === undefined) continue;
    if (best === null || top.count > best.rep.count || (top.count === best.rep.count && top.streak > best.rep.streak)) best = { side: mySide, rep: top, half: h.rounds };
  }
  return best;
}

function answered(ctx: AnalysisContext, p: Pick, r: SideRound): boolean {
  const [kind, value] = p.rep.key.split(':') as [string, string];
  if (kind === 'site') return (r.setup.onHitSiteAtEntry ?? 0) >= 2;
  if (kind === 'via') return r.lanes.find((l) => l.laneId === value)?.contested === true;
  if (kind === 'light') return r.hit.site === value;
  void ctx;
  return false;
}

function what(ctx: AnalysisContext, key: string): { text: string; places: string[] } {
  const lookup = lookupOf(ctx);
  const [kind, value] = key.split(':') as [string, string];
  if (lookup === null) return { text: key, places: [] };
  if (kind === 'site') return { text: `hit ${value}`, places: sitePlaces(lookup, value as 'A' | 'B') };
  if (kind === 'via') { const l = laneOf(lookup, value); return { text: `came through ${l?.name ?? value}`, places: l?.places ?? [] }; }
  return { text: `left ${value} light (at most ${ST.detect.setupLight} CT at ${ST.setup.setupSec} s)`, places: sitePlaces(lookup, value as 'A' | 'B') };
}

export const opponentDetector: Detector = {
  id: 'strat.opponent', area: 'strategy', scope: 'macro', needs: ['knowledge'],
  run(ctx, slot) {
    const p = choose(ctx, slot);
    if (p === null) return [];
    const rounds = new Map(sideRounds(ctx, slot, p.side).map((r) => [r.g.round.number, r]));
    const occ = p.rep.rounds.map((n) => rounds.get(n)).filter((r): r is SideRound => r !== undefined);
    const later = occ.slice(2);
    const ans = later.filter((r) => answered(ctx, p, r));
    const lostLater = later.filter((r) => r.g.round.winnerSide !== p.side && !answered(ctx, p, r)).length;
    const won = (r: SideRound): boolean => r.g.round.winnerSide === p.side;
    const w = what(ctx, p.rep.key);
    const fix = later.length >= 2 && ans.length * 2 < later.length && lostLater >= 2;
    const kind = p.rep.key.split(':')[0];
    const answerText = kind === 'light'
      ? `your team hit it in ${occ.filter((r) => answered(ctx, p, r)).length} of those rounds (${occ.filter((r) => answered(ctx, p, r) && won(r)).length} won) and went elsewhere in ${occ.filter((r) => !answered(ctx, p, r)).length} (${occ.filter((r) => !answered(ctx, p, r) && won(r)).length} won)`
      : `after the second time, your team answered it in ${ans.length} of the ${later.length} repeats (${kind === 'site' ? 'two or more CTs on the site at the entry' : 'the lane contested'}); you won ${occ.filter(won).length} of the ${occ.length} rounds`;
    const evid = pickClearest(later.length > 0 ? later : occ, (r) => (answered(ctx, p, r) ? 0 : 1) + (won(r) ? 0 : 1), (r) => r.g.round.number, (r) => r.g.round.number, ST.detect.evidenceRounds);
    const evidence: Evidence[] = evid.map((r) => {
      const focus = p.side === 'CT' ? r.hit.entryTick ?? r.setup.setupTick : r.setup.setupTick;
      const t0 = focus - 5 * 64;
      const t1 = focus + 5 * 64;
      return replayAt(ctx, r.g.round.number, focus, 5, 5, [slot, ...(p.side === 'CT' ? r.hit.committed : [])],
        [...placeZones(ctx, w.places, t0, t1, answered(ctx, p, r) ? 'good' : 'bad', w.text), ...markPlayers(ctx, r.g, focus, slot, p.side === 'CT' ? r.hit.committed : [], t0, t1)],
        `Round ${r.g.round.number}: they ${w.text}${p.side === 'CT' ? ` (setup ${r.setup.label})` : ''}; ${answered(ctx, p, r) ? 'answered' : 'not answered'}; round ${won(r) ? 'won' : 'lost'}`);
    });
    return [makeFinding({
      id: fix ? 'strat.opponent.unanswered' : 'strat.opponent.habit', area: 'strategy', scope: 'macro', polarity: fix ? 'fix' : 'observation',
      title: fix ? 'Adjust to what they repeat' : 'What the other team repeated',
      summary: `They ${w.text} in ${p.rep.count} of the ${p.half.length} rounds of the half (${p.rep.streak} in a row at most); ${answerText}.`,
      why: fix ? `${lostLater} of the unanswered repeats were lost: the same plan worked again because nothing changed.` : 'A habit like this is the cheapest read in the match: call it after the second time.',
      advice: [{ text: p.side === 'CT'
        ? 'After the second repeat, change one thing: stack the site they keep hitting, or contest the lane they keep using with one player and a grenade.'
        : 'When they keep a site light, hit it fast before they adjust, and save the slow default for the rounds after they stack it.' }],
      metrics: [],
      evidence,
      instances: p.rep.count, opportunities: p.half.length, rounds: p.rep.rounds, roundsLost: occ.filter((r) => !won(r)).length,
      confidence: patternConfidence(p.half.length), impact: fix ? patternImpact(ctx, slot, lostLater) : 0,
    })];
  },
};
