/**
 * K6 `pos.death_context`: every death by an enemy labelled from sight (docs/coach/sight.md, "Death context"): killed
 * by someone you had not seen (side or behind), seen by two or more enemies, after re-peeking the angle you had just
 * fought, while planting or defusing, in the open for the whole approach. The finding gives the shares and the two
 * labels that dominate, with the rounds lost.
 */
import type { AnalysisContext } from '../../analyze/context';
import { AVOIDABLE, DEATH_LABELS, type DeathContext, type DeathLabel } from '../../derive/sight/death-context';
import { SIGHT_TUNING } from '../../derive/sight/tuning';
import { rowBefore } from '../../derive/positioning/grid';
import { deathContexts } from '../../metrics/positioning/death-context';
import type { Annotation, Evidence, MetricValue } from '../../model/report';
import { pct, plural, roundClock, units } from '../../report/format';
import { confidence, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import { cone } from '../aim/sight-evidence';
import type { Detector } from '../types';
import { label, line, replayAt, roundsLost, who } from '../utility/evidence';

const ID = 'pos.death_context';
const c = SIGHT_TUNING.deathContext;

const NAME: Readonly<Record<DeathLabel, string>> = {
  unseen: 'by a killer you had not seen',
  crossfire: 'with two or more enemies seeing you',
  repeek: 'right after re-peeking the angle you had just fought',
  objective: 'while planting or defusing',
  open: 'in the open, seen for the whole approach',
};

const ADVICE: Readonly<Record<DeathLabel, string>> = {
  unseen: 'Clear one angle at a time and keep your back to a wall or a teammate; before you commit to a spot, check the radar for where enemies can still be.',
  crossfire: 'Take fights where only one enemy can see you: peek one angle at a time, and use a smoke or a flash to cut the second one off.',
  repeek: 'After a fight, move before you peek again: come back from a different spot, or wait for the enemy to come to you.',
  objective: 'Plant and defuse only when the angles onto you are cleared or smoked.',
  open: 'Cross open ground behind a smoke or while your team holds the angle, or take the longer route behind cover.',
};

function text(d: DeathContext): string {
  const where = d.direction === 'behind' ? 'from behind' : d.direction === 'side' ? 'from the side' : 'in front of you but out of sight';
  const through = `${d.through === 'smoke' ? ', through smoke' : d.through === 'wall' ? ', through a wall' : ''}${d.blind ? ', you were blind' : ''}`;
  const parts = d.labels.map((l) => (l === 'unseen' ? `killer unseen (${where}, ${Math.round(d.offDeg)}° off your view${through})` : l === 'crossfire' ? `seen by ${d.seenBy.length} enemies` : NAME[l]));
  return parts.join('; ');
}

function deathEvidence(ctx: AnalysisContext, slot: number, d: DeathContext): Evidence {
  const rate = ctx.raw.header.tickRate || 64;
  const x = d.death;
  const T = ctx.raw.ticks;
  const P = ctx.P;
  const r = rowBefore(ctx.raw, x.tick);
  const yaw = T.yaw[r * P + slot] ?? 0;
  const eye: [number, number, number] = [x.victimPos[0], x.victimPos[1], x.victimPos[2] + 64];
  const ann: Annotation[] = [cone(ctx, eye, yaw, 600, x.tick - rate, x.tick + rate, 'user', 'your view')];
  if (x.killerPos) ann.push(line([x.killerPos[0], x.killerPos[1], x.killerPos[2] + 64], eye, x.tick - rate, x.tick + rate, 'enemy', `${who(ctx, slot, x.killer)}, ${units(x.distance)}`));
  for (const q of d.seenBy) {
    if (q === x.killer) continue;
    const i = r * P + q;
    ann.push(line([T.x[i] ?? 0, T.y[i] ?? 0, (T.z[i] ?? 0) + 64], eye, x.tick - rate, x.tick + rate, 'enemy', `${who(ctx, slot, q)} also saw you`, true));
  }
  ann.push(label(eye, text(d), x.tick - rate, x.tick + rate, 'bad'));
  return replayAt(ctx, x.round, x.tick, 5, 2, [slot, x.killer, ...d.seenBy], ann, `${roundClock(ctx.match, x.tick)}: ${who(ctx, slot, x.killer)} killed you at ${x.victimPlace || 'an unnamed spot'}: ${text(d)}`);
}

export const DEATH_CONTEXT_DETECTOR: Detector = {
  id: ID,
  area: 'positioning',
  scope: 'micro',
  needs: ['los'],
  run(ctx, slot, metric) {
    const rows = deathContexts(ctx, slot);
    const n = rows.length;
    if (n === 0) return [];
    const counts = DEATH_LABELS.map((l) => ({ l, k: rows.filter((r) => r.labels.includes(l)).length })).filter((x) => x.k > 0);
    if (counts.length === 0) return [];
    const top = [...counts].sort((a, b) => b.k - a.k || DEATH_LABELS.indexOf(a.l) - DEATH_LABELS.indexOf(b.l)).slice(0, 2);
    const avoid = [...counts].filter((x) => AVOIDABLE.includes(x.l)).sort((a, b) => b.k - a.k || DEATH_LABELS.indexOf(a.l) - DEATH_LABELS.indexOf(b.l))[0];
    const metrics = DEATH_LABELS.map((l) => metric(`${ID}.${l}_share`)).filter((m): m is MetricValue => m !== null && Number.isFinite(m.value));
    const labelled = rows.filter((r) => top.some((t) => r.labels.includes(t.l)));
    const lost = roundsLost(ctx, slot, labelled.map((r) => r.death.round));
    const shares = counts.map((x) => `${NAME[x.l]} ${x.k} (${pct(x.k / n)})`).join(', ');
    const summary = `Of your ${plural(n, 'death')} to an enemy: ${shares}. ${top.length === 1 ? 'Those deaths came' : `The two that dominate, ${top.map((t) => `"${NAME[t.l]}"`).join(' and ')}, came`} in rounds your team lost ${lost} of ${new Set(labelled.map((r) => r.death.round)).size}.`;
    const fix = avoid !== undefined && n >= c.minDeaths && avoid.k / n >= c.fixShare;
    const focus = fix && avoid ? rows.filter((r) => r.labels.includes(avoid.l)) : labelled;
    const picks = pickClearest(focus, (r) => r.labels.length, (r) => r.death.tick, (r) => r.death.round, 3);
    return [makeFinding({
      id: fix ? `${ID}.${avoid?.l ?? 'mixed'}` : `${ID}.labels`, area: 'positioning', scope: 'micro', polarity: fix ? 'fix' : 'observation',
      title: fix && avoid ? ({ unseen: 'Stop dying to enemies you have not seen', crossfire: 'Take one enemy at a time', repeek: 'Don\'t re-peek the angle you just fought', objective: 'Clear the angles before the bomb', open: 'Don\'t cross open ground in sight' } as const)[avoid.l] : 'How your deaths happened',
      summary,
      why: fix && avoid ? `${plural(avoid.k, 'death')} of ${n} came ${NAME[avoid.l]}: each is a fight you could not win from where you stood.` : 'Each death is labelled from what you and the enemies could see in the seconds before it.',
      advice: (fix && avoid ? [avoid.l] : top.map((t) => t.l)).map((l) => ({ text: ADVICE[l] })),
      metrics, evidence: picks.map((r) => deathEvidence(ctx, slot, r)),
      instances: fix && avoid ? avoid.k : labelled.length, opportunities: n, rounds: focus.map((r) => r.death.round), roundsLost: lost,
      confidence: confidence(c.precision, n, c.nScale), impact: fix && avoid ? perMatch(avoid.k * c.costPerDeath, roundsPlayedBy(ctx, slot)) : 0,
    })];
  },
};
