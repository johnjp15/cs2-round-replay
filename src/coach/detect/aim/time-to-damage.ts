/**
 * K6 `aim.time_to_damage`: first sight to first damage and to first shot, per duel (docs/coach/sight.md); and the
 * duels you saw first by a clear margin and still lost.
 */
import { damageSights, sawFirstSights } from '../../derive/sight/select';
import { SIGHT_TUNING } from '../../derive/sight/tuning';
import type { Finding, MetricValue } from '../../model/report';
import { ms, pct, plural } from '../../report/format';
import { confidence, isBelowMedian, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { rankText, roundsLost, who } from '../utility/evidence';
import { firstSightEvidence } from './sight-evidence';
import { lobbyMedian } from './util';

const ID = 'aim.time_to_damage';
const t = SIGHT_TUNING.timeToDamage;

export const TIME_TO_DAMAGE: Detector = {
  id: ID,
  area: 'aim',
  scope: 'mechanics',
  needs: ['los'],
  run(ctx, slot, metric) {
    const out: Finding[] = [];
    const mv = metric(`${ID}.median_ms`);
    const mLeet = metric(`${ID}.leetify_ms`);
    const mShot = metric(`${ID}.shot_ms`);
    const mLost = metric(`${ID}.saw_first_lost_share`);
    const metrics = [mv, mLeet, mShot, mLost].filter((m): m is MetricValue => m !== null && Number.isFinite(m.value));
    const xs = damageSights(ctx, slot);
    const rounds = roundsPlayedBy(ctx, slot);
    const sf = sawFirstSights(ctx, slot);
    const sfLost = sf.filter((x) => x.outcome === 'lost');
    const leet = mLeet !== null && Number.isFinite(mLeet.value) ? `, ${ms(mLeet.value)} without the times of a second or more (Leetify's way)` : '';
    const shot = mShot !== null && Number.isFinite(mShot.value) ? `; your first shot came after ${ms(mShot.value)}` : '';
    if (mv !== null && Number.isFinite(mv.value)) {
      const med = lobbyMedian(mv);
      const summary = `From first sight to your first damage took ${ms(mv.value)} on median over ${plural(xs.length, 'duel')}${leet} (lobby median ${ms(med)}${rankText(mv) ? `, ${rankText(mv)}` : ''})${shot}.`;
      const conf = confidence(t.precision, xs.length, t.nScale);
      if (xs.length >= t.minN && isBelowMedian(mv) && Number.isFinite(med) && mv.value >= med + t.gapMs) {
        const slow = xs.filter((x) => (x.damageMs as number) > med);
        const picks = pickClearest(slow, (x) => Math.min(x.damageMs as number, 2000) + (x.outcome === 'lost' ? 1000 : 0), (x) => x.tick, (x) => x.round, 3);
        const lostSlow = slow.filter((x) => x.outcome === 'lost').length;
        out.push(makeFinding({
          id: `${ID}.slow`, area: 'aim', scope: 'mechanics', polarity: 'fix',
          title: 'Hit sooner after you see them',
          summary,
          why: `In ${plural(slow.length, 'duel')} you needed longer than the lobby median to do damage, and lost ${lostSlow} of them; the enemy who hits first usually wins.`,
          advice: [
            { text: 'Have the crosshair at head height before the enemy appears, so the first shot needs no flick; then shoot as soon as he is on it.' },
            { text: 'Stop before you shoot: a counter-strafe tap costs less time than a missed moving shot.', drill: '10 minutes of reaction drills (a reaction-time workshop map, or aim_botz with bots on peek): the shot on the first frame the target is on the crosshair.' },
          ],
          metrics, evidence: picks.map((f) => firstSightEvidence(ctx, slot, f, who(ctx, slot, f.enemy), `${ms(f.damageMs as number)} from seeing ${who(ctx, slot, f.enemy)} to your first damage`)),
          instances: slow.length, opportunities: xs.length, rounds: slow.map((x) => x.round), roundsLost: roundsLost(ctx, slot, slow.map((x) => x.round)),
          confidence: conf, impact: perMatch(lostSlow * t.costSlow, rounds),
        }));
      } else if (isStrength(mv, t.minN)) {
        const fast = xs.filter((x) => (x.damageMs as number) <= med);
        const picks = pickClearest(fast, (x) => -(x.damageMs as number) + (x.outcome === 'won' ? 1000 : 0), (x) => x.tick, (x) => x.round, 2);
        out.push(makeFinding({
          id: `${ID}.fast`, area: 'aim', scope: 'mechanics', polarity: 'strength',
          title: 'You hit fast', summary, why: 'You do damage soon after an enemy appears, which wins the duels decided by the first hit.',
          advice: [], metrics, evidence: picks.map((f) => firstSightEvidence(ctx, slot, f, who(ctx, slot, f.enemy), `${ms(f.damageMs as number)} from seeing ${who(ctx, slot, f.enemy)} to your first damage`)),
          instances: fast.length, opportunities: xs.length, rounds: fast.map((x) => x.round), confidence: conf, impact: 0,
        }));
      }
    }
    if (sfLost.length >= t.minSawFirstLost && sf.length > 0 && sfLost.length / sf.length >= t.sawFirstLostShare) {
      const picks = pickClearest(sfLost, (x) => x.duel.tick1 - x.tick, (x) => x.tick, (x) => x.round, 3);
      const noShot = sfLost.filter((x) => x.shotMs === null).length;
      out.push(makeFinding({
        id: `${ID}.saw_first_lost`, area: 'aim', scope: 'mechanics', polarity: 'fix',
        title: 'Use the moment you see them first',
        summary: `You saw the enemy first by ${ms(SIGHT_TUNING.duels.clearMarginMs)} or more in ${plural(sf.length, 'duel')} and still lost ${sfLost.length} (${pct(sfLost.length / sf.length)}${rankText(mLost) ? `, ${rankText(mLost)}` : ''}); in ${noShot} of them you never shot at him.`,
        why: 'Seeing first is the biggest edge a duel offers; losing those is a fight given away.',
        advice: [{ text: 'When you see an enemy who has not seen you, shoot now or step out of his sight; do not wait for him to turn.' }],
        metrics: mLost !== null && Number.isFinite(mLost.value) ? [mLost] : [],
        evidence: picks.map((f) => firstSightEvidence(ctx, slot, f, who(ctx, slot, f.enemy), `you saw ${who(ctx, slot, f.enemy)} first and lost the duel`)),
        instances: sfLost.length, opportunities: sf.length, rounds: sfLost.map((x) => x.round), roundsLost: roundsLost(ctx, slot, sfLost.map((x) => x.round)),
        confidence: confidence(t.precision, sf.length, t.nScale), impact: perMatch(sfLost.length * t.costSawFirstLost, rounds),
      }));
    }
    return out;
  },
};
