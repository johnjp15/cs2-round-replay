/**
 * K6 `aim.habits`: counted habits with evidence (docs/coach/sight.md, "Habits"): bullets fired in the air at a target,
 * bullets fired while blind, moving while scoped with a sniper rifle with an enemy in sight, and re-peeking the same
 * angle within seconds of a missed sniper shot. A habit that recurs (habits.fixCount or more) is a fix; fewer are
 * observations, so the moments can still be watched.
 */
import type { AnalysisContext } from '../../analyze/context';
import type { ShotRow } from '../../derive/aim/shots';
import { TARGETS } from '../../derive/aim/targets';
import { HABITS, type Repeek, type ScopedRun } from '../../derive/sight/habits';
import { SIGHT_TUNING } from '../../derive/sight/tuning';
import type { Annotation, Evidence, Finding, MetricValue } from '../../model/report';
import { plural, roundClock, weaponName } from '../../report/format';
import { evidence, label, line, path } from '../annotate';
import { confidence, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { rankText, roundsLost, secs, who } from '../utility/evidence';
import { rowFeet } from './util';

const ID = 'aim.habits';
const h = SIGHT_TUNING.habits;

/** One shot per burst (the first of the habit's shots in it). */
function perBurst(xs: readonly ShotRow[]): ShotRow[] {
  const seen = new Set<number>();
  return xs.filter((s) => (seen.has(s.burst) ? false : (seen.add(s.burst), true)));
}

function shotEvidence(ctx: AnalysisContext, slot: number, s: ShotRow, text: string): Evidence {
  const rate = ctx.raw.header.tickRate || 64;
  const tg = ctx.table(TARGETS).rows[s.i];
  const ann: Annotation[] = [label(s.eye, text, s.tick - 8, s.tick + rate, 'bad')];
  if (tg !== undefined && tg.at !== null) ann.push(line(s.eye, [tg.at[0], tg.at[1], tg.at[2] + 48], s.tick - 8, s.tick + rate, s.hitEnemy ? 'good' : 'bad', s.hitEnemy ? 'hit' : 'missed'));
  const players = [slot, ...(tg !== undefined && tg.target >= 0 ? [tg.target] : [])];
  return evidence('replay', s.round, s.tick, rate * 3, rate * 2, players, ann, `${roundClock(ctx.match, s.tick)}: ${text}`);
}

function scopedEvidence(ctx: AnalysisContext, slot: number, r: ScopedRun): Evidence {
  const rate = ctx.raw.header.tickRate || 64;
  const pts: [number, number, number][] = [];
  const ticks: number[] = [];
  for (let k = r.r0; k <= r.r1; k += 4) {
    pts.push(rowFeet(ctx, k, slot));
    ticks.push(ctx.raw.ticks.tick[k] ?? 0);
  }
  const text = `scoped ${weaponName(r.weapon)} moving at up to ${r.peak} units/s (accurate below ${r.threshold}), ${who(ctx, slot, r.enemy)} in sight`;
  return evidence('replay', r.round, r.tick0, rate * 2, r.tick1 - r.tick0 + rate * 2, [slot, r.enemy], [
    path(pts, ticks, r.tick0, r.tick1 + rate, 'bad', 'scoped and moving'),
    label(rowFeet(ctx, r.r0, slot), text, r.tick0, r.tick1 + rate, 'bad'),
  ], `${roundClock(ctx.match, r.tick0)}: ${text}`);
}

function repeekEvidence(ctx: AnalysisContext, slot: number, x: Repeek): Evidence {
  const rate = ctx.raw.header.tickRate || 64;
  const s = ctx.raw.events.bullets[x.shot];
  const tg = ctx.table(TARGETS).rows[x.shot];
  const eye: [number, number, number] = s ? [s.x, s.y, s.z] : [0, 0, 0];
  const ann: Annotation[] = [];
  if (tg !== undefined && tg.at !== null) ann.push(line(eye, [tg.at[0], tg.at[1], tg.at[2] + 48], x.shotTick, x.backTick + rate, 'bad', 'missed shot'));
  const text = `re-peeked ${secs((x.backTick - x.shotTick) / rate)} after the miss; ${x.died ? `${who(ctx, slot, x.enemy)} killed you` : 'you survived'}`;
  ann.push(label(eye, text, x.backTick, x.backTick + rate, x.died ? 'bad' : 'neutral'));
  return evidence('replay', x.round, x.backTick, Math.max(rate * 2, x.backTick - x.shotTick + rate), rate * 2, [slot, x.enemy], ann, `${roundClock(ctx.match, x.shotTick)}: missed ${who(ctx, slot, x.enemy)} with the sniper rifle, ${text}`);
}

interface HabitSpec {
  key: 'airborne' | 'flashed' | 'scoped_moving' | 'repeek';
  metric: string;
  count: number;
  rounds: number[];
  roundsLost: number;
  title: string;
  summary: string;
  why: string;
  advice: Finding['advice'];
  evidence: Evidence[];
}

export const HABITS_DETECTOR: Detector = {
  id: ID,
  area: 'aim',
  scope: 'mechanics',
  needs: ['los'],
  run(ctx, slot, metric) {
    const tab = ctx.table(HABITS);
    if (!tab.available) return [];
    const played = roundsPlayedBy(ctx, slot);
    const specs: HabitSpec[] = [];
    const air = tab.airborne[slot] ?? [];
    if (air.length > 0) {
      const bursts = perBurst(air);
      const hits = air.filter((s) => s.hitEnemy).length;
      const mv = metric(`${ID}.airborne_bursts`);
      specs.push({
        key: 'airborne', metric: `${ID}.airborne_bursts`, count: bursts.length, rounds: air.map((s) => s.round), roundsLost: roundsLost(ctx, slot, air.map((s) => s.round)),
        title: 'Land before you shoot',
        summary: `You fired ${plural(air.length, 'bullet')} in the air at an enemy (${plural(bursts.length, 'time')}), ${hits} of them hit${rankText(mv) ? ` (${rankText(mv)})` : ''}.`,
        why: 'In the air every gun but a few scoped shots is wildly inaccurate; the jump also makes you easy to predict.',
        advice: [{ text: 'Jump to move or to peek for information, and shoot only once you have landed and stopped.' }],
        evidence: pickClearest(bursts, (s) => -s.speed, (s) => s.tick, (s) => s.round, 3).map((s) => shotEvidence(ctx, slot, s, `${weaponName(s.weapon)} fired in the air, ${s.hitEnemy ? 'hit' : 'missed'}`)),
      });
    }
    const fl = tab.flashed[slot] ?? [];
    if (fl.length > 0) {
      const bursts = perBurst(fl);
      const mv = metric(`${ID}.flashed_bursts`);
      specs.push({
        key: 'flashed', metric: `${ID}.flashed_bursts`, count: bursts.length, rounds: fl.map((s) => s.round), roundsLost: roundsLost(ctx, slot, fl.map((s) => s.round)),
        title: 'Don\'t shoot blind',
        summary: `You fired ${plural(fl.length, 'bullet')} while blind (${plural(bursts.length, 'burst')}), ${fl.filter((s) => s.hitEnemy).length} of them hit${rankText(mv) ? ` (${rankText(mv)})` : ''}.`,
        why: 'Shooting blind gives away where you are and empties the magazine you need when your sight comes back.',
        advice: [{ text: 'When you are flashed, turn away or fall back behind cover and listen; shoot only at a sound you are sure of, or a spot an enemy must cross.' }],
        evidence: pickClearest(bursts, (s) => s.burstLen, (s) => s.tick, (s) => s.round, 3).map((s) => shotEvidence(ctx, slot, s, `${weaponName(s.weapon)} fired while blind`)),
      });
    }
    const sc = tab.scopedMoving[slot] ?? [];
    if (sc.length > 0) {
      const mv = metric(`${ID}.scoped_moving`);
      specs.push({
        key: 'scoped_moving', metric: `${ID}.scoped_moving`, count: sc.length, rounds: sc.map((r) => r.round), roundsLost: roundsLost(ctx, slot, sc.map((r) => r.round)),
        title: 'Stop moving while scoped',
        summary: `${plural(sc.length, 'time')} you moved with the scope up above the accurate speed while an enemy was in sight${rankText(mv) ? ` (${rankText(mv)})` : ''}.`,
        why: 'A scoped sniper rifle is only accurate standing still; moving scoped is slow and inaccurate at the same time.',
        advice: [{ text: 'Unscope to reposition, or stand still while scoped; peek with a short strafe and stop before the shot.' }],
        evidence: pickClearest(sc, (r) => r.peak, (r) => r.tick0, (r) => r.round, 3).map((r) => scopedEvidence(ctx, slot, r)),
      });
    }
    const rp = tab.repeeks[slot] ?? [];
    if (rp.length > 0) {
      const mv = metric(`${ID}.sniper_repeeks`);
      const died = rp.filter((x) => x.died).length;
      specs.push({
        key: 'repeek', metric: `${ID}.sniper_repeeks`, count: rp.length, rounds: rp.map((x) => x.round), roundsLost: roundsLost(ctx, slot, rp.map((x) => x.round)),
        title: 'Don\'t re-peek after a missed sniper shot',
        summary: `${plural(rp.length, 'time')} you missed with the sniper rifle and showed yourself to the same enemy from the same spot within ${secs(h.repeekSec)}; he killed you ${plural(died, 'time')}${rankText(mv) ? ` (${rankText(mv)})` : ''}.`,
        why: 'After a miss the enemy knows exactly where you are and is aiming there.',
        advice: [{ text: 'After a missed shot, reposition: come back from another angle or let a teammate take the next peek.' }],
        evidence: pickClearest(rp, (x) => (x.died ? 10 : 0) - (x.backTick - x.shotTick) / 64, (x) => x.backTick, (x) => x.round, 3).map((x) => repeekEvidence(ctx, slot, x)),
      });
    }
    return specs.map((s) => {
      const mv = metric(s.metric);
      const fix = s.count >= h.fixCount;
      return makeFinding({
        id: `${ID}.${s.key}`, area: 'aim', scope: 'mechanics', polarity: fix ? 'fix' : 'observation',
        title: s.title, summary: s.summary, why: s.why, advice: s.advice,
        metrics: mv !== null && Number.isFinite(mv.value) ? [mv as MetricValue] : [],
        evidence: s.evidence, instances: s.count, opportunities: played, rounds: s.rounds, roundsLost: s.roundsLost,
        confidence: confidence(h.precision, s.count, h.nScale), impact: fix ? perMatch(s.count * h.costPerInstance, played) : 0,
      });
    });
  },
};
