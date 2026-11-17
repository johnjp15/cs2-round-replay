/**
 * K6 `aim.placement`: where the crosshair was when an enemy first came into view (docs/coach/sight.md). The angle
 * from the view direction to the enemy's head at the observer's first sighting row of each duel; split vertical and
 * horizontal (signed: "your crosshair sits 3.1° low"), holding against peeking, and by place; plus the Leetify-style
 * figure (how far the view moved from the first sight to the first damaging shot).
 *
 * Also fills `MatchReport.charts['aim.placement']` (`placementChart`): where each enemy appeared relative to the
 * crosshair, in degrees right and up, by outcome, linked to the finding's evidence moment that shows it.
 */
import type { AnalysisContext } from '../../analyze/context';
import { median } from '../../derive/aim/select';
import type { FirstSight } from '../../derive/sight/firsts';
import { placementSights } from '../../derive/sight/select';
import { SIGHT_TUNING } from '../../derive/sight/tuning';
import type { ChartCategory, ChartPayload, Finding, MetricValue } from '../../model/report';
import { deg, plural, rankOf, roundClock, units } from '../../report/format';
import { confidence, isBelowMedian, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { who } from '../utility/evidence';
import { firstSightEvidence, offsetText } from './sight-evidence';
import { lobbyMedian } from './util';

const ID = 'aim.placement';
const t = SIGHT_TUNING.placement;

function rank(mv: MetricValue | null): string {
  if (mv === null || mv.lobbyRank < 1) return '';
  return rankOf(mv.lobbyRank, mv.lobby.filter((v) => Number.isFinite(v)).length);
}

/** "low" / "high" / "left" / "right" errors that are at least namedDeg in the median. */
function errorWords(xs: readonly FirstSight[]): { text: string; vertical: number; horizontal: number } {
  const up = median(xs.map((x) => x.up));
  const right = median(xs.map((x) => x.right));
  const parts: string[] = [];
  if (Math.abs(up) >= t.namedDeg) parts.push(`${deg(Math.abs(up))} ${up > 0 ? 'low' : 'high'}`);
  if (Math.abs(right) >= t.namedDeg) parts.push(`${deg(Math.abs(right))} ${right > 0 ? 'left of where they appear' : 'right of where they appear'}`);
  return { text: parts.join(' and '), vertical: up, horizontal: right };
}

/** The places with at least 3 first sights, worst median angle first. */
function worstPlaces(xs: readonly FirstSight[]): { place: string; n: number; med: number }[] {
  const by = new Map<string, number[]>();
  for (const x of xs) {
    if (x.place === '') continue;
    const l = by.get(x.place);
    if (l === undefined) by.set(x.place, [x.angle]);
    else l.push(x.angle);
  }
  return [...by].filter(([, a]) => a.length >= 3).map(([place, a]) => ({ place, n: a.length, med: median(a) })).sort((a, b) => b.med - a.med || (a.place < b.place ? -1 : 1));
}

function evidenceFor(ctx: AnalysisContext, slot: number, picks: readonly FirstSight[]): Finding['evidence'] {
  return picks.map((f) => firstSightEvidence(ctx, slot, f, who(ctx, slot, f.enemy), `${who(ctx, slot, f.enemy)} came into view ${deg(f.angle)} from your crosshair (${offsetText(f)}) at ${f.place || 'an unnamed spot'}, ${f.holding ? 'you holding' : 'you moving'}; ${f.outcome === 'won' ? 'you won the duel' : f.outcome === 'lost' ? 'you lost the duel' : f.outcome === 'no_shot' ? 'you did not shoot' : 'no kill between you'}`));
}

export const PLACEMENT: Detector = {
  id: ID,
  area: 'aim',
  scope: 'mechanics',
  needs: ['los'],
  run(ctx, slot, metric) {
    const mv = metric(`${ID}.angle_deg`);
    if (mv === null || !Number.isFinite(mv.value)) return [];
    const xs = placementSights(ctx, slot);
    const med = lobbyMedian(mv);
    const hold = xs.filter((x) => x.holding);
    const peek = xs.filter((x) => !x.holding);
    const err = errorWords(xs);
    const places = worstPlaces(xs);
    const mLeet = metric(`${ID}.leetify_deg`);
    const metrics = [mv, metric(`${ID}.vertical_deg`), metric(`${ID}.horizontal_deg`), metric(`${ID}.holding_deg`), metric(`${ID}.peeking_deg`), mLeet].filter((m): m is MetricValue => m !== null && Number.isFinite(m.value));
    const split = `holding ${hold.length > 0 ? deg(median(hold.map((x) => x.angle))) : '–'} (${hold.length}), peeking ${peek.length > 0 ? deg(median(peek.map((x) => x.angle))) : '–'} (${peek.length})`;
    const leet = mLeet !== null && Number.isFinite(mLeet.value) ? `; Leetify-style (view moved to the first hit) ${deg(mLeet.value)}` : '';
    const summary = `When an enemy came into view your crosshair was ${deg(mv.value)} from his head on median over ${plural(xs.length, 'first sight')} (lobby median ${deg(med)}${rank(mv) ? `, ${rank(mv)}` : ''}): ${split}${err.text ? `; it sits ${err.text}` : ''}${leet}.`;
    const rounds = roundsPlayedBy(ctx, slot);
    const conf = confidence(t.precision, xs.length, t.nScale);
    if (xs.length >= t.minN && isBelowMedian(mv) && Number.isFinite(med) && mv.value >= med + t.gapDeg) {
      const bad = xs.filter((x) => x.angle > med);
      const lostBad = bad.filter((x) => x.outcome === 'lost');
      const picks = pickClearest(bad, (x) => (x.outcome === 'lost' ? 1000 : 0) + Math.min(x.angle, 60) - x.dist / 1000, (x) => x.tick, (x) => x.round, 3);
      const where = places.slice(0, 2).filter((p) => p.med > med).map((p) => `${p.place} (${deg(p.med)} over ${p.n})`).join(' and ');
      return [makeFinding({
        id: `${ID}.off`, area: 'aim', scope: 'mechanics', polarity: 'fix',
        title: err.vertical >= t.namedDeg ? 'Raise your crosshair to head height' : err.vertical <= -t.namedDeg ? 'Lower your crosshair to head height' : 'Pre-aim where the enemy will appear',
        summary: `${summary}${where ? ` It is worst at ${where}.` : ''}`,
        why: `${plural(bad.length, 'enemy', 'enemies')} came into view farther from your crosshair than the lobby's median ${deg(med)}; you lost ${lostBad.length} of those ${plural(bad.length, 'duel')}. Every degree you still have to move after he appears is time he has to shoot first.`,
        advice: [
          { text: `${err.vertical >= t.namedDeg ? 'Keep the crosshair on the line where heads appear, not on the floor or the wall below it. ' : ''}Before you walk into an angle, put the crosshair on the spot an enemy's head would be and move along the wall with it, so he appears on it instead of beside it.`, drill: '10 minutes of prefire practice on this map (a prefire workshop map): clear each angle with the crosshair already on the head spot.' },
          ...(where ? [{ text: `Start at ${places[0]?.place ?? ''}: check where you look when you walk through it in the replay below.` }] : []),
        ],
        metrics, evidence: evidenceFor(ctx, slot, picks),
        instances: bad.length, opportunities: xs.length, rounds: bad.map((x) => x.round), roundsLost: 0,
        confidence: conf, impact: perMatch(lostBad.length * t.costPerDuel, rounds),
      })];
    }
    if (isStrength(mv, t.minN)) {
      const good = xs.filter((x) => x.angle <= med);
      const picks = pickClearest(good, (x) => (x.outcome === 'won' ? 100 : 0) - x.angle, (x) => x.tick, (x) => x.round, 2);
      return [makeFinding({
        id: `${ID}.sharp`, area: 'aim', scope: 'mechanics', polarity: 'strength',
        title: 'Your crosshair is where they appear', summary,
        why: 'Enemies appear on or near your crosshair, so your first shot needs almost no correction.',
        advice: [], metrics, evidence: evidenceFor(ctx, slot, picks),
        instances: good.length, opportunities: xs.length, rounds: good.map((x) => x.round),
        confidence: conf, impact: 0,
      })];
    }
    return [];
  },
  charts(ctx, slot, _metric, findings) {
    const c = placementChart(ctx, slot, findings);
    return c === null ? {} : { [ID]: c };
  },
};

const CATEGORIES: ChartCategory[] = [
  { key: 'won', label: 'you won the duel', role: 'good' },
  { key: 'lost', label: 'you lost the duel', role: 'bad' },
  { key: 'no_shot', label: 'you did not shoot', role: 'neutral' },
  { key: 'other', label: 'no kill between you', role: 'accent' },
];

/**
 * The placement scatter (`MatchReport.charts['aim.placement']`): x = degrees the enemy's head was right of the
 * crosshair at the first sight, y = degrees above it; one point per first sight, by outcome; points shown by the
 * finding's evidence link to it. Null without first sights.
 */
export function placementChart(ctx: AnalysisContext, slot: number, findings: readonly Finding[] = []): ChartPayload | null {
  const xs = placementSights(ctx, slot);
  if (xs.length === 0) return null;
  const f = findings.find((x) => x.id.startsWith(ID));
  return {
    kind: 'scatter', area: 'aim', title: 'Where enemies appeared relative to your crosshair',
    caption: 'Each dot is an enemy\'s head at the moment he first came into your view; the centre is your crosshair.',
    x: { label: 'right of the crosshair', unit: 'deg' }, y: { label: 'above the crosshair', unit: 'deg' },
    rings: [1, 3, 5], categories: CATEGORIES,
    points: xs.map((x) => {
      const ev = f === undefined ? -1 : f.evidence.findIndex((e) => e.focus === x.tick && e.players.includes(x.enemy));
      return {
        x: Math.round(x.right * 100) / 100, y: Math.round(x.up * 100) / 100, cat: x.outcome,
        label: `${roundClock(ctx.match, x.tick)}: ${who(ctx, slot, x.enemy)}, ${deg(x.angle)} off, ${units(x.dist)}, ${x.holding ? 'holding' : 'moving'}${x.place ? `, ${x.place}` : ''}`,
        ...(f !== undefined && ev >= 0 ? { link: { finding: f.id, evidence: ev } } : {}),
      };
    }),
  };
}
