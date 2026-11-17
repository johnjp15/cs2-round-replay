/**
 * utility area (K4): detectors, in a fixed order: `util.flash`, `util.unused`, `util.buy`, `util.damage`.
 * Definitions and thresholds: docs/coach/utility.md, data/coach/tuning/utility.json.
 */
import type { AnalysisContext } from '../../analyze/context';
import { itemPrice } from '../../derive/economy/prices';
import { secToTicks, type Vec3 } from '../../derive/positioning/grid';
import type { Throw } from '../../derive/utility/throws';
import { UTILITY_TUNING } from '../../derive/utility/tuning';
import {
  cheapestUtility, damageStats, flashStats, noUtilStats, unusedStats,
} from '../../metrics/utility/instances';
import type { Annotation, Evidence, Finding } from '../../model/report';
import { fixed, pct, plural, roundClock } from '../../report/format';
import { confidence, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { at, circle, dollars, label, line, present, rankText, replayAt, roleOf, roundsLost, secs, who } from './evidence';

const T = UTILITY_TUNING;

/** The flash (thrown → detonation) with a label per counted blind. */
function flashEvidence(ctx: AnalysisContext, user: number, f: Throw, caption: string, extra: Annotation[] = [], players: number[] = []): Evidence {
  const det = f.detTick as number;
  const t0 = f.throwTick ?? det - 64;
  const ann: Annotation[] = [];
  if (f.throwPos && f.detPos) ann.push(line(f.throwPos, f.detPos, t0, det, 'accent', 'flash', true));
  if (f.detPos) ann.push(circle(f.detPos, 48, det, det + 32, 'accent', 'flash'));
  for (const b of f.blinds) {
    if (!b.alive || b.duration < 0.3) continue;
    ann.push(label(at(ctx, det, b.victim), `${who(ctx, user, b.victim)} ${secs(b.duration)}`, det, det + secToTicks(ctx.raw, Math.min(b.duration, 3)), roleOf(ctx, user, b.victim)));
  }
  const blinded = f.blinds.filter((b) => b.alive && b.duration >= 0.3).map((b) => b.victim);
  return replayAt(ctx, f.round, det, Math.max(1, (det - t0) / 64 + 0.5), 3, [f.thrower, ...blinded, ...players], [...ann, ...extra], caption);
}

const flash: Detector = {
  id: 'util.flash', area: 'utility', scope: 'micro',
  run(ctx, slot, metric) {
    const s = flashStats(ctx, slot);
    const out: Finding[] = [];
    const n = s.flashes.length;
    const mEnemies = metric('util.flash.enemies_per_flash');
    const mTeam = metric('util.flash.team_per_flash');
    const mKill = metric('util.flash.kill_share');
    const mMedian = metric('util.flash.blind_median');
    const rounds = roundsPlayedBy(ctx, slot);
    if (n >= T.flash.minFlashes && s.noEnemy.length / n >= T.flash.noEnemyShare) {
      const teamOnly = s.noEnemy.filter((f) => f.teammatesBlinded > 0).length;
      const picks = pickClearest(s.noEnemy, (f) => -f.enemyBlindSec + f.teammatesBlinded, (f) => f.detTick as number, (f) => f.round, 3);
      out.push(makeFinding({
        id: 'util.flash.no_enemy', area: 'utility', scope: 'micro', polarity: 'fix',
        title: 'Throw flashes that blind someone',
        summary: `${s.noEnemy.length} of your ${n} flashes (${pct(s.noEnemy.length / n)}) blinded no enemy for ${secs(T.flash.minBlindSec)} or more${teamOnly > 0 ? ` (${teamOnly} of them blinded a teammate instead)` : ''}; you blind ${fixed(mEnemies?.value ?? 0, 2)} enemies per flash${rankText(mEnemies) ? ` (${rankText(mEnemies)})` : ''}.`,
        why: 'A flash that blinds nobody costs $200 and a grenade slot and gives the enemy a warning sound that you are coming.',
        advice: [
          { text: 'Pop-flash over the angle you are about to swing (bounce it off a wall or the ceiling so it bursts as it comes into view), and swing as it pops.', drill: 'Ten minutes on a flash-practice workshop map: learn two pop-flashes for each entry you take on this map.' },
          { text: 'Before you throw, name who it is for: the enemy holding the angle, not the area.' },
        ],
        metrics: present(mEnemies, mMedian, mKill),
        evidence: picks.map((f) => flashEvidence(ctx, slot, f, `${roundClock(ctx.match, f.detTick as number)}: your flash ${f.landPlace ? `at ${f.landPlace} ` : ''}blinded no enemy`)),
        instances: s.noEnemy.length, opportunities: n, rounds: s.noEnemy.map((f) => f.round),
        roundsLost: roundsLost(ctx, slot, s.noEnemy.map((f) => f.round)),
        confidence: confidence(T.scoring.precision, n, T.scoring.nScale),
        impact: perMatch(s.noEnemy.length * T.scoring.impactWastedFlash, rounds),
      }));
    }
    if (s.teamFights.length >= T.flash.minTeamFlashFights) {
      const picks = pickClearest(s.teamFights, (x) => x.blind.duration, (x) => x.blind.tick, (x) => x.flash.round, 3);
      out.push(makeFinding({
        id: 'util.flash.team', area: 'utility', scope: 'micro', polarity: 'fix',
        title: 'Stop flashing teammates into fights',
        summary: `${plural(s.teamFights.length, 'time')} your flash blinded ${s.teamFights.some((x) => x.blind.rel === 'self') ? 'you or a teammate' : 'a teammate'} for ${secs(T.flash.minBlindSec)} or more right before ${s.teamFights.length === 1 ? 'a fight' : 'their fights'}; you blind ${fixed(mTeam?.value ?? 0, 2)} teammates per flash${rankText(mTeam) ? ` (${rankText(mTeam)})` : ''}.`,
        why: 'A blinded teammate who takes a fight loses it: the flash hands the enemy the duel.',
        advice: [
          { text: 'Call your flashes ("flashing B short") and throw them over or behind the teammate who is about to peek, not into his view.' },
          { text: 'If a teammate is already peeking, flash for the next peek, not this one.' },
        ],
        metrics: present(mTeam, metric('util.flash.self_share')),
        evidence: picks.map((x) => {
          const fightAt = at(ctx, x.blind.fightTick as number, x.blind.victim);
          const ann = [label(fightAt, `${who(ctx, slot, x.blind.victim)} hit ${fixed(((x.blind.fightTick as number) - x.blind.tick) / 64, 1)} s after the flash`, x.blind.fightTick as number, (x.blind.fightTick as number) + 64, 'bad')];
          return flashEvidence(ctx, slot, x.flash, `${roundClock(ctx.match, x.blind.tick)}: your flash blinded ${who(ctx, slot, x.blind.victim)} for ${secs(x.blind.duration)} before a fight`, ann);
        }),
        instances: s.teamFights.length, opportunities: n, rounds: s.teamFights.map((x) => x.flash.round),
        roundsLost: roundsLost(ctx, slot, s.teamFights.map((x) => x.flash.round)),
        confidence: confidence(T.scoring.precision, s.teamFights.length, T.scoring.nScale),
        impact: perMatch(s.teamFights.length * T.scoring.impactTeamFlash, rounds),
      }));
    }
    if (n >= T.flash.minFlashes && (mEnemies?.value ?? 0) >= T.flash.strengthEnemiesPerFlash && isStrength(mEnemies, T.flash.minFlashes)) {
      const good = s.flashes.filter((f) => f.enemiesBlinded > 0);
      const picks = pickClearest(good, (f) => f.enemyBlindSec + (f.ledToKill ? 3 : 0), (f) => f.detTick as number, (f) => f.round, 2);
      out.push(makeFinding({
        id: 'util.flash.strength', area: 'utility', scope: 'micro', polarity: 'strength',
        title: 'Your flashes land',
        summary: `You blind ${fixed(mEnemies?.value ?? 0, 2)} enemies per flash (${rankText(mEnemies)}), and ${pct(s.ledToKill / n)} of your flashes led to a kill.`,
        why: 'Flashes that blind win the fights your team takes behind them.',
        advice: [{ text: 'Keep it up; teach the two you use most to a teammate so both entries get one.' }],
        metrics: present(mEnemies, mKill, mMedian),
        evidence: picks.map((f) => flashEvidence(ctx, slot, f, `${roundClock(ctx.match, f.detTick as number)}: your flash blinded ${plural(f.enemiesBlinded, 'enemy', 'enemies')}${f.ledToKill ? ' and led to a kill' : ''}`)),
        instances: good.length, opportunities: n, rounds: good.map((f) => f.round),
        confidence: confidence(T.scoring.precision, n, T.scoring.nScale), impact: 0,
      }));
    }
    return out;
  },
};

const unused: Detector = {
  id: 'util.unused', area: 'utility', scope: 'micro',
  run(ctx, slot, metric) {
    const s = unusedStats(ctx, slot);
    if (s.lostDeaths.length < T.unused.minDeaths) return [];
    const mv = metric('util.unused.value_per_round');
    const value = s.lostDeaths.reduce((a, d) => a + d.grenadeValue, 0);
    const picks = pickClearest(s.lostDeaths, (d) => d.grenadeValue, (d) => d.tick, (d) => d.round, 3);
    return [makeFinding({
      id: 'util.unused.death', area: 'utility', scope: 'micro', polarity: 'fix',
      title: 'Use your grenades before you die',
      summary: `You died ${plural(s.lostDeaths.length, 'time')} with ${T.unused.minGrenades} or more grenades left in rounds your team lost (${dollars(value)} unused); over the match ${dollars(mv?.value ?? 0)} of grenades a round went unused${rankText(mv) ? ` (${rankText(mv)})` : ''}.`,
      why: 'Grenades left on a dead player helped nobody; thrown, they could have delayed, damaged or blinded.',
      advice: [
        { text: 'When you hold an angle, throw your molotov or HE at the first sound of contact instead of waiting for the perfect moment.' },
        { text: 'Before a peek you might not survive, throw what you carry first.' },
      ],
      metrics: present(mv, metric('util.unused.grenades_per_round')),
      evidence: picks.map((d) => replayAt(ctx, d.round, d.tick, 6, 1, [slot, d.killer],
        [label(d.victimPos, `died with ${d.grenades.join(', ')} (${dollars(d.grenadeValue)})`, d.tick - 64, d.tick + 64, 'bad'),
          ...(d.killerPos ? [line(d.killerPos, d.victimPos, d.tick - 16, d.tick + 32, 'enemy')] : [])],
        `${roundClock(ctx.match, d.tick)}: you died with ${d.grenades.length} grenades (${dollars(d.grenadeValue)})`)),
      instances: s.lostDeaths.length, opportunities: s.deaths.length, rounds: s.lostDeaths.map((d) => d.round),
      roundsLost: s.lostDeaths.length,
      confidence: confidence(T.scoring.precision, s.deaths.length, T.scoring.nScale),
      impact: perMatch(s.lostDeaths.length * T.scoring.impactUnusedDeath, s.rounds),
    })];
  },
};

const buy: Detector = {
  id: 'util.buy', area: 'utility', scope: 'micro',
  run(ctx, slot, metric) {
    const s = noUtilStats(ctx, slot);
    if (s.instances.length < T.buy.minRounds) return [];
    const mv = metric('util.buy.no_util_share');
    const avgLeft = s.instances.reduce((a, b) => a + b.moneyLeft, 0) / s.instances.length;
    const picks = pickClearest(s.instances, (b) => b.moneyLeft, (b) => b.round, (b) => b.round, 3);
    return [makeFinding({
      id: 'util.buy.no_util', area: 'utility', scope: 'micro', polarity: 'fix',
      title: 'Buy utility with your rifle',
      summary: `In ${s.instances.length} of your ${s.rifleRounds.length} rifle rounds you bought no grenade though you had at least ${dollars(cheapestUtility())} left (${dollars(avgLeft)} on average)${rankText(mv) ? `; ${rankText(mv)} in the lobby` : ''}.`,
      why: 'A rifle round without a flash or smoke means taking every fight dry.',
      advice: [{ text: `Make a flash (${dollars(itemPrice('flashbang'))}) and a smoke (${dollars(itemPrice('smokegrenade'))}) part of every rifle buy; bind them next to your rifle in the buy menu.` }],
      metrics: present(mv),
      evidence: picks.map((b) => {
        const r = ctx.match.rounds.find((x) => x.number === b.round);
        const focus = r?.freezeEndTick ?? r?.startTick ?? 0;
        return replayAt(ctx, b.round, focus, 2, 10, [slot],
          [label(at(ctx, focus, slot), `${b.primary ?? 'rifle'}, no grenades, ${dollars(b.moneyLeft)} left`, focus - 128, focus + 640, 'bad')],
          `Round ${b.round}: ${b.primary ?? 'rifle'} with no grenades and ${dollars(b.moneyLeft)} left after the buy`);
      }),
      instances: s.instances.length, opportunities: s.rifleRounds.length, rounds: s.instances.map((b) => b.round),
      roundsLost: roundsLost(ctx, slot, s.instances.map((b) => b.round)),
      confidence: confidence(T.scoring.precision, s.rifleRounds.length, T.scoring.nScale),
      impact: perMatch(s.instances.length * T.scoring.impactNoUtilRound, roundsPlayedBy(ctx, slot)),
    })];
  },
};

function fireEvidence(ctx: AnalysisContext, user: number, f: Throw, caption: string): Evidence {
  const det = f.detTick as number;
  const end = f.endTick ?? det + secToTicks(ctx.raw, T.throws.fireDefaultSec);
  const ann: Annotation[] = [];
  if (f.throwPos && f.detPos) ann.push(line(f.throwPos, f.detPos, f.throwTick ?? det - 64, det, 'accent', 'molotov', true));
  if (f.detPos) {
    ann.push(circle(f.detPos, T.throws.fireRadius, det, end, 'accent', 'fire'));
    ann.push(circle(f.detPos, T.throws.fireNearRadius, det, end, 'neutral', 'no enemy came this close'));
  }
  return replayAt(ctx, f.round, det, 2, Math.max(2, (end - det) / 64), [user], ann, caption);
}

const damage: Detector = {
  id: 'util.damage', area: 'utility', scope: 'micro',
  run(ctx, slot, metric) {
    const s = damageStats(ctx, slot);
    const out: Finding[] = [];
    const mPer = metric('util.damage.per_grenade');
    const mWaste = metric('util.damage.wasted_fire_share');
    if (s.wastedFires.length >= T.damage.minFires && s.fires.length > 0 && s.wastedFires.length / s.fires.length >= T.damage.wastedFireShare) {
      const picks = pickClearest(s.wastedFires, (f) => f.lifetimeSec, (f) => f.detTick as number, (f) => f.round, 3);
      out.push(makeFinding({
        id: 'util.damage.wasted_fire', area: 'utility', scope: 'micro', polarity: 'fix',
        title: 'Throw fire where enemies are or will be',
        summary: `${s.wastedFires.length} of your ${s.fires.length} molotovs and incendiaries (${pct(s.wastedFires.length / s.fires.length)}) burned out with no enemy inside or within ${fixed(T.throws.fireNearRadius)} units of them.`,
        why: 'A fire nobody had to walk around denied nothing and cost $400–600.',
        advice: [{ text: 'Save the fire for the spot an enemy is holding or must cross (a site corner, a plant spot, a choke on a retake), and throw it when you hear them, not on a timer.' }],
        metrics: present(mWaste, mPer),
        evidence: picks.map((f) => fireEvidence(ctx, slot, f, `${roundClock(ctx.match, f.detTick as number)}: your fire ${f.landPlace ? `at ${f.landPlace} ` : ''}touched no enemy`)),
        instances: s.wastedFires.length, opportunities: s.fires.length, rounds: s.wastedFires.map((f) => f.round),
        roundsLost: roundsLost(ctx, slot, s.wastedFires.map((f) => f.round)),
        confidence: confidence(T.scoring.precision, s.fires.length, T.scoring.nScale),
        impact: perMatch(s.wastedFires.length * T.scoring.impactWastedFire, roundsPlayedBy(ctx, slot)),
      }));
    }
    if (s.grenades.length >= T.damage.minGrenades && (mPer?.value ?? 0) >= T.damage.strengthDamagePerGrenade && isStrength(mPer, T.damage.minGrenades)) {
      const hits = s.grenades.filter((g) => g.enemyDamage > 0);
      const picks = pickClearest(hits, (g) => g.enemyDamage, (g) => g.detTick as number, (g) => g.round, 2);
      out.push(makeFinding({
        id: 'util.damage.strength', area: 'utility', scope: 'micro', polarity: 'strength',
        title: 'Your HE and fire do damage',
        summary: `Your HE grenades and fires did ${fixed(mPer?.value ?? 0)} damage each (${rankText(mPer)}), ${s.damage} in all.`,
        why: 'Damage before the fight turns duels into one-shot kills for your team.',
        advice: [{ text: 'Keep throwing them at the first contact; they work.' }],
        metrics: present(mPer),
        evidence: picks.map((g) => {
          const det = g.detTick as number;
          const ann: Annotation[] = g.detPos ? [circle(g.detPos as Vec3, g.type === 'he' ? 350 : T.throws.fireRadius, det, det + 64, 'good', g.type === 'he' ? 'HE' : 'fire')] : [];
          for (const h of g.hits) if (h.enemy) ann.push(label(at(ctx, h.tick, h.victim), `${who(ctx, slot, h.victim)} −${h.removed}`, h.tick, h.tick + 64, 'enemy'));
          return replayAt(ctx, g.round, det, 2, 2, [slot, ...g.hits.map((h) => h.victim)], ann, `${roundClock(ctx.match, det)}: your ${g.type === 'he' ? 'HE' : 'fire'} did ${g.enemyDamage} damage`);
        }),
        instances: hits.length, opportunities: s.grenades.length, rounds: hits.map((g) => g.round),
        confidence: confidence(T.scoring.precision, s.grenades.length, T.scoring.nScale), impact: 0,
      }));
    }
    return out;
  },
};


export const UTILITY_DETECTORS: readonly Detector[] = [flash, unused, buy, damage];
