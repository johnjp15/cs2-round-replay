/**
 * `strat.setup`: as CT, the site the Ts hit against how the user's team was set up, and where the user was.
 * A fix when the Ts kept entering a site with at most `setupLight` CTs on it and those rounds were lost; an
 * observation with the setup counts otherwise. Definitions: docs/coach/strategy.md.
 */
import type { AnalysisContext } from '../../analyze/context';
import { sampleAt } from '../../derive/strategy/grid';
import type { SiteId } from '../../derive/strategy/knowledge';
import type { ChartPayload, Evidence, Finding } from '../../model/report';
import { plural } from '../../report/format';
import { makeFinding, pickClearest } from '../common';
import { secToTicks } from '../../derive/positioning/grid';
import type { Detector } from '../types';
import { replayAt } from '../utility/evidence';
import { board, boardZones, lookupOf, markPlayers, patternConfidence, patternImpact, placeZones, sitePlaces, sideRounds, ST, tally, times, whereList, zoneNameAt, type SideRound } from './common';

function entryTick(r: SideRound): number {
  return r.hit.entryTick ?? r.setup.setupTick;
}

function evidenceFor(ctx: AnalysisContext, slot: number, r: SideRound): Evidence {
  const lookup = lookupOf(ctx);
  const site = r.hit.site as SiteId;
  const focus = entryTick(r);
  const t0 = focus - secToTicks(ctx.raw, 5);
  const t1 = focus + secToTicks(ctx.raw, 5);
  const n = r.setup.onHitSiteAtSetup ?? 0;
  const anns = [
    ...(lookup ? placeZones(ctx, sitePlaces(lookup, site), t0, t1, 'bad', `${site}: ${n} CT${n === 1 ? '' : 's'} set up here`) : []),
    ...markPlayers(ctx, r.g, focus, slot, r.hit.committed, t0, t1),
  ];
  const caption = `Round ${r.g.round.number}: ${plural(r.hit.committed.length, 'T')} entered ${site} after ${Math.round(r.hit.entrySec ?? 0)} s; your setup had ${n} CT${n === 1 ? '' : 's'} there (${r.setup.label}); round ${r.g.round.winnerSide === 'CT' ? 'won' : 'lost'}`;
  return replayAt(ctx, r.g.round.number, focus, 5, 5, [slot, ...r.hit.committed], anns, caption);
}

function hitRounds(ctx: AnalysisContext, slot: number): { all: SideRound[]; hits: SideRound[]; light: SideRound[] } {
  const all = sideRounds(ctx, slot, 'CT');
  const hits = all.filter((r) => r.hit.site !== null && r.setup.onHitSiteAtSetup !== null);
  const light = hits.filter((r) => (r.setup.onHitSiteAtSetup ?? 0) <= ST.detect.setupLight);
  return { all, hits, light };
}

export const setupDetector: Detector = {
  id: 'strat.setup', area: 'strategy', scope: 'macro', needs: ['knowledge'],
  run(ctx, slot, metric) {
    const lookup = lookupOf(ctx);
    if (lookup === null) return [];
    const { all, hits, light } = hitRounds(ctx, slot);
    if (hits.length < ST.detect.setupMinLight) return [];
    const P = ctx.P;
    const lost = light.filter((r) => r.g.round.winnerSide === 'T');
    const bySite = tally(hits.map((r) => r.hit.site as string));
    const top = tally(light.map((r) => r.hit.site as string))[0] ?? bySite[0];
    const topAll = bySite.find((x) => x.name === top?.name);
    const where = tally(light.map((r) => zoneNameAt(lookup, r.g, sampleAt(r.g, r.setup.setupTick), P, slot)));
    const onIt = light.filter((r) => { const z = r.g.zone[sampleAt(r.g, r.setup.setupTick) * P + slot] ?? -9; return z >= 0 && lookup.defends(z, r.hit.site as SiteId); }).length;
    const mv = metric('strat.setup.on_hit_share');
    const sites = bySite.map((x) => `${x.name} ${times(x.n)}`).join(' and ');
    const fix = light.length >= ST.detect.setupMinLight && lost.length >= ST.detect.setupMinLost;
    const youText = light.length === 0 ? '' : `In those ${light.length} rounds you set up ${whereList(where)}${onIt > 0 ? ` (on the hit site ${times(onIt)})` : ''}.`;
    const evid = pickClearest(fix ? lost : hits, (r) => (r.g.round.winnerSide === 'T' ? 2 : 0) - (r.setup.onHitSiteAtSetup ?? 0), (r) => r.g.round.number, (r) => r.g.round.number, ST.detect.evidenceRounds);
    const summary = `They hit ${sites} in your ${all.length} CT rounds; ${light.length} of the ${hits.length} hits went to a site your setup had at most ${plural(ST.detect.setupLight, 'CT')} on at ${ST.setup.setupSec} s, and you lost ${lost.length} of those ${light.length}. ${youText}`;
    return [makeFinding({
      id: fix ? 'strat.setup.light' : 'strat.setup.pattern', area: 'strategy', scope: 'macro', polarity: fix ? 'fix' : 'observation',
      title: fix ? `Put two on ${top?.name ?? 'the site'} against this team` : 'Your setups against their hits',
      summary,
      why: fix
        ? `${lost.length} rounds were lost to a hit on a site set up with at most ${plural(ST.detect.setupLight, 'defender')}: the help had to rotate in after the Ts were on it.`
        : 'Their hits mostly met a full site: the setup was not where these rounds were lost.',
      advice: [
        { text: `They hit ${top?.name ?? ''} ${times(topAll?.n ?? 0)} in ${hits.length} hits, ${times(top?.n ?? 0)} when it was light: set up two players there and one who can rotate in ten seconds.` },
        { text: 'If you anchor a site alone, play for time: hold a fall-back angle, call the count and wait for the rotation instead of taking the first duel.' },
      ],
      metrics: mv !== null && Number.isFinite(mv.value) ? [mv] : [],
      evidence: evid.map((r) => evidenceFor(ctx, slot, r)),
      instances: light.length, opportunities: hits.length, rounds: light.map((r) => r.g.round.number),
      roundsLost: lost.length, confidence: patternConfidence(all.length),
      impact: fix ? patternImpact(ctx, slot, lost.length) : 0,
    })];
  },
  charts(ctx, slot, _metric, findings) {
    return setupBoards(ctx, slot, findings);
  },
};

function setupBoards(ctx: AnalysisContext, slot: number, findings: readonly Finding[]): Record<string, ChartPayload> {
  const f = findings.find((x) => x.id.startsWith('strat.setup.'));
  const lookup = lookupOf(ctx);
  if (f === undefined || lookup === null) return {};
  const { all } = hitRounds(ctx, slot);
  const boards = all.map((r) => {
    const site = r.hit.site;
    const n = r.setup.onHitSiteAtSetup;
    const light = n !== null && n <= ST.detect.setupLight;
    const zones = site !== null ? boardZones(ctx, sitePlaces(lookup, site), light ? 'bad' : 'ct', `${site} (${n ?? 0} CT)`) : [];
    const ev = f.evidence.findIndex((e) => e.round === r.g.round.number);
    const result = site === null ? 'no hit' : `${site} hit with ${r.hit.committed.length}`;
    return board(ctx, r.g, site !== null ? entryTick(r) : r.setup.setupTick, slot, zones,
      `R${r.g.round.number} · ${r.setup.label} · ${result} · ${r.g.round.winnerSide === 'CT' ? 'won' : 'lost'}`, light && r.g.round.winnerSide === 'T',
      ev >= 0 ? { finding: f.id, evidence: ev } : undefined);
  });
  return {
    'strat.setup': {
      kind: 'boards', area: 'strategy', title: 'Your setup against their hit, per CT round',
      caption: `Positions at the Ts' entry (or at ${ST.setup.setupSec} s when there was no hit); the hit site is red when your setup had at most ${ST.detect.setupLight} CT on it at ${ST.setup.setupSec} s.`,
      boards,
      legend: [{ key: 'bad', label: 'hit site, light', role: 'bad' }, { key: 'ct', label: 'hit site, defended', role: 'ct' }],
    },
  };
}
