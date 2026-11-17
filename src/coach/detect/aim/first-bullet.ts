/** `aim.first_bullet`: first-bullet hit rate, standing against moving, by distance band. */
import type { AnalysisContext } from '../../analyze/context';
import { firstBullets, type FirstBullet } from '../../derive/aim/select';
import { AIM_TUNING } from '../../derive/aim/tuning';
import type { Finding, MetricValue } from '../../model/report';
import { deg, pct, plural, roundClock, units, weaponName } from '../../report/format';
import { evidence, label, line } from '../annotate';
import { confidence, isBelowMedian, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { lobbyMedian } from './util';

const ID = 'aim.first_bullet';
const t = AIM_TUNING.firstBullet;

const rate = (xs: readonly FirstBullet[]): string => (xs.length === 0 ? '–' : `${pct(xs.filter((x) => x.shot.hitEnemy).length / xs.length)} of ${xs.length}`);

function duelEv(ctx: AnalysisContext, f: FirstBullet, slot: number): Finding['evidence'][number] {
  const r = ctx.raw.header.tickRate || 64;
  const s = f.shot;
  const at = f.target.at ?? s.eye;
  const text = `${s.hitEnemy ? 'hit' : 'missed'} at ${units(f.target.dist)}, ${deg(f.target.angle)} off, ${s.moving ? 'moving' : 'standing'}`;
  return evidence('duel', s.round, s.tick, r * 2, r, [slot, f.target.target], [
    line(s.eye, [at[0], at[1], at[2] + 48], s.tick - 8, s.tick + r, s.hitEnemy ? 'good' : 'bad', 'first bullet'),
    label(s.eye, text, s.tick - 8, s.tick + r, s.hitEnemy ? 'good' : 'bad'),
  ], `${roundClock(ctx.match, s.tick)}: first ${weaponName(s.weapon)} bullet ${text}`);
}

export const FIRST_BULLET: Detector = {
  id: ID,
  area: 'aim',
  scope: 'mechanics',
  run(ctx, slot, metric) {
    const mv = metric(`${ID}.hit_share`);
    if (mv === null || !Number.isFinite(mv.value)) return [];
    const fb = firstBullets(ctx, slot);
    const standing = fb.filter((x) => !x.shot.moving);
    const moving = fb.filter((x) => x.shot.moving);
    const bands = AIM_TUNING.bands.names.map((b) => `${b} ${rate(fb.filter((x) => x.band === b))}`).join(', ');
    const med = lobbyMedian(mv);
    const rounds = roundsPlayedBy(ctx, slot);
    const conf = confidence(t.precision, fb.length, t.nScale);
    const metrics = [mv, metric(`${ID}.hit_share_standing`), metric(`${ID}.hit_share_moving`)].filter((m): m is MetricValue => m !== null);
    const summary = `Your first bullets hit ${pct(mv.value)} (${plural(fb.length, 'first bullet')}, lobby median ${pct(med)}): standing ${rate(standing)}, moving ${rate(moving)}; by range ${bands}.`;
    if (isBelowMedian(mv) && Number.isFinite(med) && mv.value < med - t.gapToMedian) {
      const misses = standing.filter((x) => !x.shot.hitEnemy && x.target.how === 'aim');
      if (misses.length === 0) return [];
      const ev = pickClearest(misses, (x) => x.target.angle, (x) => x.shot.tick, (x) => x.shot.round, 3);
      const worstBand = AIM_TUNING.bands.names
        .map((b) => ({ b, xs: fb.filter((x) => x.band === b) }))
        .filter((g) => g.xs.length >= 5)
        .sort((a, b) => a.xs.filter((x) => x.shot.hitEnemy).length / a.xs.length - b.xs.filter((x) => x.shot.hitEnemy).length / b.xs.length)[0];
      return [makeFinding({
        id: `${ID}.low`, area: 'aim', scope: 'mechanics', polarity: 'fix',
        title: 'Make the first bullet count',
        summary,
        why: `The first bullet is the most accurate one you fire; ${plural(Math.round((med - mv.value) * fb.length), 'first bullet')} more would have hit at the lobby median rate.`,
        advice: [{ text: `Place the crosshair at head height before the peek and fire only when it is on the target${worstBand ? `; your ${worstBand.b}-range first bullets need it most` : ''}.`, drill: '10 minutes of one-tap drills on bots (e.g. aim_botz), standing, one bullet per bot.' }],
        metrics, evidence: ev.map((x) => duelEv(ctx, x, slot)),
        instances: fb.length - fb.filter((x) => x.shot.hitEnemy).length, opportunities: fb.length, rounds: misses.map((x) => x.shot.round),
        confidence: conf, impact: perMatch((med - mv.value) * fb.length * t.costPerMiss, rounds),
      })];
    }
    if (isStrength(mv, t.minN)) {
      const hits = fb.filter((x) => x.shot.hitEnemy);
      const ev = pickClearest(hits, (x) => x.target.dist, (x) => x.shot.tick, (x) => x.shot.round, 2);
      return [makeFinding({
        id: `${ID}.sharp`, area: 'aim', scope: 'mechanics', polarity: 'strength',
        title: 'Sharp first bullets', summary, why: 'Your first shots land, which wins duels before recoil matters.',
        advice: [], metrics, evidence: ev.map((x) => duelEv(ctx, x, slot)),
        instances: hits.length, opportunities: fb.length, rounds: hits.map((x) => x.shot.round),
        confidence: conf, impact: perMatch(Math.max(0, mv.value - (Number.isFinite(med) ? med : 0)) * fb.length * t.costPerMiss, rounds),
      })];
    }
    return [];
  },
};
