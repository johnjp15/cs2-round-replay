/**
 * `aim.counter_strafe`: first bullets fired above 34 % of the weapon's max speed (CS2 adds movement inaccuracy only
 * above it), how many ms before the speed fell under it, how the player stopped, and what it cost in the game's own
 * inaccuracy against the same shot standing still. The headline share is the Leetify-comparable one (rifles, not
 * crouched) when the player has enough rifle first bullets, else every gun.
 */
import type { AnalysisContext } from '../../analyze/context';
import { firstBullets, mean, median, type FirstBullet } from '../../derive/aim/select';
import { AIM_TUNING } from '../../derive/aim/tuning';
import type { Finding, MetricValue } from '../../model/report';
import { fixed, ms, pct, plural, roundClock, times, units, weaponName } from '../../report/format';
import { evidence, label, line, path } from '../annotate';
import { confidence, isBelowMedian, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { lobbyMedian, rowFeet } from './util';

const ID = 'aim.counter_strafe';
const t = AIM_TUNING.counterStrafe;

const STOP_WORDS: Record<string, string> = {
  opposite: 'tapped the opposite key',
  coast: 'released the key and coasted',
  holding: 'were still holding the key',
  crouch: 'crouched to stop',
};

function duelEvidence(ctx: AnalysisContext, f: FirstBullet, slot: number): Finding['evidence'][number] {
  const s = f.shot;
  const rate = ctx.raw.header.tickRate || 64;
  const before = Math.round(rate * 2);
  const after = Math.round(rate);
  const win = Math.round((AIM_TUNING.shots.buttonWindowMs * rate) / 1000);
  const pts: [number, number, number][] = [];
  const ticks: number[] = [];
  for (let r = Math.max(0, s.row - win); r <= s.row; r += 4) {
    pts.push(rowFeet(ctx, r, slot));
    ticks.push(ctx.raw.ticks.tick[r] ?? 0);
  }
  const target = f.target.at ?? s.eye;
  const ratio = s.stillInaccuracy > 0 ? s.inaccuracy / s.stillInaccuracy : 1;
  const tag = `${fixed(s.speed)} u/s (${pct(s.speed / s.maxSpeed)} of max), ${times(ratio)} inaccuracy, ${s.hitEnemy ? 'hit' : 'missed'}`;
  return evidence('duel', s.round, s.tick, before, after, [slot, f.target.target], [
    path(pts, ticks, s.tick - before, s.tick + after, 'user', 'your last 300 ms'),
    line(s.eye, [target[0], target[1], target[2] + 48], s.tick - 8, s.tick + after, s.hitEnemy ? 'good' : 'bad', 'first bullet'),
    label(s.eye, tag, s.tick - 8, s.tick + after, 'bad'),
  ], `${roundClock(ctx.match, s.tick)}: first ${weaponName(s.weapon)} bullet at ${units(s.speed)}/s, ${ms(s.msToStop)} before you had stopped (${STOP_WORDS[s.stop] ?? s.stop}); ${times(ratio)} the standing inaccuracy, ${s.hitEnemy ? 'hit' : 'missed'}`);
}

export const COUNTER_STRAFE: Detector = {
  id: ID,
  area: 'aim',
  scope: 'mechanics',
  run(ctx, slot, metric) {
    const rifle = metric(`${ID}.early_share`);
    const all = metric(`${ID}.early_share_all`);
    const useRifle = rifle !== null && Number.isFinite(rifle.value) && rifle.n >= t.minN;
    const head: MetricValue | null = useRifle ? rifle : all;
    if (head === null || !Number.isFinite(head.value)) return [];
    const fb = firstBullets(ctx, slot, useRifle);
    const early = fb.filter((x) => x.shot.moving);
    const lateMs = median(early.map((x) => x.shot.msToStop));
    const cost = mean(early.filter((x) => x.shot.stillInaccuracy > 0).map((x) => x.shot.inaccuracy / x.shot.stillInaccuracy));
    const stops = fb.filter((x) => x.shot.stop !== 'standing');
    const byStop = (k: string): number => stops.filter((x) => x.shot.stop === k).length;
    const rounds = roundsPlayedBy(ctx, slot);
    const conf = confidence(t.precision, fb.length, t.nScale);
    const metrics = [head, metric(`${ID}.late_ms`), metric(`${ID}.cost_x`), metric(`${ID}.opposite_share`)].filter((m): m is MetricValue => m !== null);
    const set = useRifle ? 'first rifle bullets' : 'first bullets';
    const stopText = stops.length === 0 ? '' : ` Of ${plural(stops.length, 'stop')} before a first bullet you ${STOP_WORDS.opposite} ${byStop('opposite')} times, ${STOP_WORDS.coast} ${byStop('coast')}, ${STOP_WORDS.crouch} ${byStop('crouch')} and ${STOP_WORDS.holding} ${byStop('holding')}.`;
    const out: Finding[] = [];
    const med = lobbyMedian(head);
    if (head.value >= t.fixShare && isBelowMedian(head) && early.length > 0) {
      const ev = pickClearest(early, (x) => (x.shot.hitEnemy ? 0 : 2) + (x.shot.stillInaccuracy > 0 ? x.shot.inaccuracy / x.shot.stillInaccuracy : 1) / 5 + x.shot.msToStop / 200, (x) => x.shot.tick, (x) => x.shot.round, 3);
      const excess = Math.max(0, head.value - (Number.isFinite(med) ? med : 0)) * fb.length;
      out.push(makeFinding({
        id: `${ID}.early`, area: 'aim', scope: 'mechanics', polarity: 'fix',
        title: 'Stop before you shoot',
        summary: `You fired ${pct(head.value)} of your ${set} while still moving, a median of ${ms(lateMs)} before you had stopped; those shots carried ${times(cost)} the standing inaccuracy.`,
        why: `${plural(early.length, 'first bullet')} of ${fb.length} left with movement inaccuracy (lobby median ${pct(med)}); a moving first bullet hits far less often, and the first bullet decides most duels.${stopText}`,
        advice: [
          { text: byStop('holding') >= byStop('coast') ? 'Let go of the strafe key and tap the opposite one before you click; fire on the tap, not during the strafe.' : 'Tap the opposite key instead of coasting: coasting takes about 100 ms longer to get under the threshold.', drill: '10 minutes on a counter-strafe workshop map (e.g. aim_botz): strafe, tap the opposite key, one bullet at the head, repeat.' },
        ],
        metrics, evidence: ev.map((x) => duelEvidence(ctx, x, slot)),
        instances: early.length, opportunities: fb.length, rounds: early.map((x) => x.shot.round),
        confidence: conf, impact: perMatch(excess * t.costHit, rounds),
      }));
    } else if (isStrength(head, t.minN)) {
      const good = fb.filter((x) => !x.shot.moving && x.shot.stop === 'opposite' && x.shot.hitEnemy);
      if (good.length > 0) {
        const ev = pickClearest(good, (x) => x.shot.damage, (x) => x.shot.tick, (x) => x.shot.round, 2);
        out.push(makeFinding({
          id: `${ID}.clean`, area: 'aim', scope: 'mechanics', polarity: 'strength',
          title: 'Clean counter-strafes',
          summary: `Only ${pct(head.value)} of your ${set} left while moving (lobby median ${pct(med)}).`,
          why: 'Your first bullets fly with standing accuracy, so you win the duels your crosshair has already won.',
          advice: [], metrics, evidence: ev.map((x) => duelEvidence(ctx, x, slot)),
          instances: fb.length - early.length, opportunities: fb.length, rounds: good.map((x) => x.shot.round),
          confidence: conf, impact: perMatch(Math.max(0, (Number.isFinite(med) ? med : 0) - head.value) * fb.length * t.costHit, rounds),
        }));
      }
    }
    return out;
  },
};
