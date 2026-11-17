/** `aim.range_discipline`: sprays of six or more bullets beyond a long range that hit nothing after bullet four. */
import type { AnalysisContext } from '../../analyze/context';
import { SHOTS } from '../../derive/aim/shots';
import { longSprays } from '../../derive/aim/select';
import type { SprayRow } from '../../derive/aim/sprays';
import { AIM_TUNING } from '../../derive/aim/tuning';
import type { Finding, MetricValue } from '../../model/report';
import { pct, plural, roundClock, units, weaponName } from '../../report/format';
import { evidence, label, line } from '../annotate';
import { confidence, isBelowMedian, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';

const ID = 'aim.range_discipline';
const t = AIM_TUNING.rangeDiscipline;

function sprayEv(ctx: AnalysisContext, s: SprayRow, slot: number): Finding['evidence'][number] {
  const rate = ctx.raw.header.tickRate || 64;
  const { shots } = ctx.table(SHOTS);
  const first = s.bullets[0];
  const last = s.bullets[s.bullets.length - 1];
  const t0 = first?.tick ?? 0;
  const t1 = last?.tick ?? t0;
  const eye = shots[first?.shot ?? 0]?.eye ?? [0, 0, 0];
  const at = first?.at ?? eye;
  const after = s.bullets.filter((b) => b.n > t.afterBullet).length;
  const hitsAfter = s.bullets.filter((b) => b.n > t.afterBullet && b.hit).length;
  const text = `${s.bullets.length} bullets at ${units(s.dist)}, ${hitsAfter} of ${after} hit after bullet ${t.afterBullet}`;
  return evidence('spray', s.round, t0, rate * 2, t1 - t0 + rate, [slot, s.target], [
    line(eye, [at[0], at[1], at[2] + 48], t0 - rate, t1 + rate, 'bad', units(s.dist)),
    label(eye, text, t0, t1 + rate, 'bad'),
  ], `${roundClock(ctx.match, t0)}: ${text} (${weaponName(s.weapon)}); ${s.hits} hit in all`);
}

export const RANGE_DISCIPLINE: Detector = {
  id: ID,
  area: 'aim',
  scope: 'mechanics',
  run(ctx, slot, metric) {
    const mv = metric(`${ID}.wasted_share`);
    if (mv === null || !Number.isFinite(mv.value)) return [];
    const long = longSprays(ctx, slot);
    const wasted = long.filter((x) => x.wasted).map((x) => x.spray);
    const rounds = roundsPlayedBy(ctx, slot);
    const metrics: MetricValue[] = [mv];
    const conf = confidence(t.precision, long.length, t.nScale);
    if (wasted.length >= t.minInstances && (isBelowMedian(mv) || mv.value >= 0.5)) {
      const bulletsWasted = wasted.reduce((a, s) => a + s.bullets.filter((b) => b.n > t.afterBullet).length, 0);
      const ev = pickClearest(wasted, (s) => s.bullets.length + s.dist / 500, (s) => s.bullets[0]?.tick ?? 0, (s) => s.round, 3);
      return [makeFinding({
        id: `${ID}.long_sprays`, area: 'aim', scope: 'mechanics', polarity: 'fix',
        title: 'Burst or tap at long range',
        summary: `${wasted.length} of your ${plural(long.length, 'spray')} of ${t.minBullets}+ bullets beyond ${units(t.longUnits)} hit nothing after bullet ${t.afterBullet} (${pct(mv.value)}); ${bulletsWasted} bullets went nowhere.`,
        why: 'Past the first bullets the spread and recoil are wider than a body at that range; those bullets only tell the enemy where you are and empty your magazine.',
        advice: [{ text: `Beyond ${units(t.longUnits)} fire bursts of 2–3 bullets and let the recoil reset between them, or tap the head.`, drill: '5 minutes on a long-range bot map: 3-bullet bursts at 30+ m, wait for the crosshair to settle each time.' }],
        metrics, evidence: ev.map((s) => sprayEv(ctx, s, slot)),
        instances: wasted.length, opportunities: long.length, rounds: wasted.map((s) => s.round),
        confidence: conf, impact: perMatch(wasted.length * t.costPerSpray, rounds),
      })];
    }
    if (isStrength(mv, 3) && long.length - wasted.length > 0) {
      const good = long.filter((x) => !x.wasted).map((x) => x.spray);
      const ev = pickClearest(good, (s) => s.hits, (s) => s.bullets[0]?.tick ?? 0, (s) => s.round, 2);
      return [makeFinding({
        id: `${ID}.disciplined`, area: 'aim', scope: 'mechanics', polarity: 'strength',
        title: 'Disciplined at long range',
        summary: `Only ${wasted.length} of your ${plural(long.length, 'long spray')} beyond ${units(t.longUnits)} hit nothing after bullet ${t.afterBullet}.`,
        why: 'Your long sprays keep connecting.', advice: [], metrics, evidence: ev.map((s) => sprayEv(ctx, s, slot)),
        instances: good.length, opportunities: long.length, rounds: good.map((s) => s.round), confidence: conf, impact: perMatch(good.length * t.costPerSpray, rounds),
      })];
    }
    return [];
  },
};
