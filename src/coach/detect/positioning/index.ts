/**
 * positioning area (K4): detectors, in a fixed order: `pos.untradeable`, `trade.missed`, `pos.opening`.
 * Definitions and thresholds: docs/coach/utility.md, data/coach/tuning/positioning.json.
 */
import type { AnalysisContext } from '../../analyze/context';
import type { DeathRow } from '../../derive/positioning/deaths';
import type { OpeningRow } from '../../derive/positioning/opening';
import { POSITIONING_TUNING } from '../../derive/positioning/tuning';
import { openingStats, tradeChances, untradeableStats, type TradeChance } from '../../metrics/positioning/instances';
import { median } from '../../metrics/utility/instances';
import type { Annotation, Evidence, Finding } from '../../model/report';
import { pct, plural, roundClock, units } from '../../report/format';
import { confidence, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { DEATH_CONTEXT_DETECTOR } from './death-context';
import { circle, label, line, present, rankText, replayAt, roundsLost, who } from '../utility/evidence';

const T = POSITIONING_TUNING;

function deathEvidence(ctx: AnalysisContext, user: number, d: DeathRow, caption: string): Evidence {
  const ann: Annotation[] = [circle(d.victimPos, T.trades.tradeDistance, d.tick - 320, d.tick + 128, 'bad', 'trade range')];
  if (d.killerPos) ann.push(line(d.killerPos, d.victimPos, d.tick - 32, d.tick + 64, 'enemy', who(ctx, user, d.killer)));
  if (d.nearest) {
    const tm = d.teammates.find((t) => t.p === d.nearest?.p);
    if (tm) ann.push(line(d.victimPos, tm.pos, d.tick, d.tick + 128, 'teammate', `nearest teammate ${units(tm.dist)}`, true));
  }
  return replayAt(ctx, d.round, d.tick, 5, 2, [user, d.killer, ...(d.nearest ? [d.nearest.p] : [])], ann, caption);
}

const untradeable: Detector = {
  id: 'pos.untradeable', area: 'positioning', scope: 'micro',
  run(ctx, slot, metric) {
    const s = untradeableStats(ctx, slot);
    const n = s.deaths.length;
    if (s.instances.length < T.untradeable.minInstances || s.instances.length / n < T.untradeable.share) return [];
    const mv = metric('pos.untradeable.share');
    const mNear = metric('pos.untradeable.nearest_median');
    const lost = roundsLost(ctx, slot, s.instances.map((d) => d.round));
    const picks = pickClearest(s.instances, (d) => d.nearest?.dist ?? 99999, (d) => d.tick, (d) => d.round, 3);
    return [makeFinding({
      id: 'pos.untradeable.isolated', area: 'positioning', scope: 'micro', polarity: 'fix',
      title: 'Play where a teammate can trade you',
      summary: `${s.instances.length} of your ${n} deaths (${pct(s.instances.length / n)}) came with no teammate within ${units(T.trades.tradeDistance)} and went untraded; your team lost ${lost} of those ${plural(s.instances.length, 'round')}. At death your nearest teammate was ${units(median(s.nearest))} away on median${rankText(mNear) ? ` (${rankText(mNear)})` : ''}.`,
      why: 'A death nobody can trade is a free kill: your team is a player down with nothing back.',
      advice: [
        { text: 'Before you take a fight, check the radar: if no teammate could swing within a few seconds, fall back or wait for one.' },
        { text: 'When you lurk or hold alone, play for information and survival, not for the first duel.' },
      ],
      metrics: present(mv, mNear),
      evidence: picks.map((d) => deathEvidence(ctx, slot, d, `${roundClock(ctx.match, d.tick)}: ${who(ctx, slot, d.killer)} killed you at ${d.victimPlace || 'an unnamed spot'}; nearest teammate ${d.nearest ? units(d.nearest.dist) : 'none'}`)),
      instances: s.instances.length, opportunities: n, rounds: s.instances.map((d) => d.round), roundsLost: lost,
      confidence: confidence(T.scoring.precision, n, T.scoring.nScale),
      impact: perMatch(s.instances.length * T.scoring.impactUntradeable, roundsPlayedBy(ctx, slot)),
    })];
  },
};

function chanceEvidence(ctx: AnalysisContext, user: number, c: TradeChance, caption: string): Evidence {
  const d = c.death;
  const ann: Annotation[] = [circle(d.victimPos, T.trades.tradeDistance, d.tick - 64, d.tick + 320, 'neutral', 'trade range')];
  if (d.killerPos) ann.push(line(d.killerPos, d.victimPos, d.tick - 32, d.tick + 64, 'enemy', `${who(ctx, user, d.killer)} kills ${who(ctx, user, d.victim)}`));
  ann.push(label(c.me.pos, `you: ${units(c.me.dist)}, ${c.me.damageToKiller > 0 ? `${c.me.damageToKiller} damage` : 'no damage'} in ${T.trades.windowSec} s`, d.tick, d.tick + 320, c.missed ? 'bad' : 'good'));
  if (c.me.sawTick !== null && d.killerPos) ann.push(label(d.killerPos, 'in your sight', c.me.sawTick, c.me.sawTick + 64, 'accent'));
  return replayAt(ctx, d.round, d.tick, 2, T.trades.windowSec, [user, d.victim, d.killer], ann, caption);
}

const missed: Detector = {
  id: 'trade.missed', area: 'trading', scope: 'micro',
  run(ctx, slot, metric) {
    const chances = tradeChances(ctx, slot);
    const misses = chances.filter((c) => c.missed);
    const attempts = chances.filter((c) => c.attempted).length;
    const trades = chances.filter((c) => c.traded).length;
    const out: Finding[] = [];
    const mMiss = metric('trade.missed.miss_share');
    const mSucc = metric('trade.missed.success_share');
    const sight = ctx.los !== null ? ', his killer came into your sight,' : '';
    if (misses.length >= T.missed.minMissed && misses.length / chances.length >= T.missed.share) {
      const picks = pickClearest(misses, (c) => -c.me.dist, (c) => c.death.tick, (c) => c.death.round, 3);
      out.push(makeFinding({
        id: 'trade.missed.no_damage', area: 'trading', scope: 'micro', polarity: 'fix',
        title: 'Trade your teammates',
        summary: `${plural(misses.length, 'time')} a teammate died within ${units(T.trades.tradeDistance)} of you${sight} and you did no damage to his killer within ${T.trades.windowSec} s: ${plural(chances.length, 'chance')}, ${plural(attempts, 'attempt')}, ${plural(trades, 'trade')}${rankText(mMiss) ? ` (${rankText(mMiss)})` : ''}.`,
        why: 'An untraded teammate puts your team a player down; a trade inside five seconds gives the kill straight back.',
        advice: [
          { text: 'When a teammate near you takes a fight, pre-aim where his opponent must be and swing the moment you hear the shots.' },
          { text: 'Play one step behind your entry, not on the other side of the site.' },
        ],
        metrics: present(mMiss, mSucc),
        evidence: picks.map((c) => chanceEvidence(ctx, slot, c, `${roundClock(ctx.match, c.death.tick)}: ${who(ctx, slot, c.death.victim)} died ${units(c.me.dist)} from you; no damage to ${who(ctx, slot, c.death.killer)}`)),
        instances: misses.length, opportunities: chances.length, rounds: misses.map((c) => c.death.round),
        roundsLost: roundsLost(ctx, slot, misses.map((c) => c.death.round)),
        confidence: confidence(T.scoring.precision, chances.length, T.scoring.nScale),
        impact: perMatch(misses.length * T.scoring.impactMissedTrade, roundsPlayedBy(ctx, slot)),
      }));
    }
    if (trades >= 2 && isStrength(mSucc, 3)) {
      const good = chances.filter((c) => c.traded);
      out.push(makeFinding({
        id: 'trade.missed.strength', area: 'trading', scope: 'micro', polarity: 'strength',
        title: 'You trade your teammates',
        summary: `You traded ${trades} of ${chances.length} teammates who died near you (${pct(trades / chances.length)}, ${rankText(mSucc)}).`,
        why: 'Quick trades keep fights even.',
        advice: [{ text: 'Keep playing close to your entry.' }],
        metrics: present(mSucc),
        evidence: pickClearest(good, (c) => -c.me.dist, (c) => c.death.tick, (c) => c.death.round, 2).map((c) => chanceEvidence(ctx, slot, c, `${roundClock(ctx.match, c.death.tick)}: you traded ${who(ctx, slot, c.death.victim)}`)),
        instances: trades, opportunities: chances.length, rounds: good.map((c) => c.death.round),
        confidence: confidence(T.scoring.precision, chances.length, T.scoring.nScale), impact: 0,
      }));
    }
    return out;
  },
};

function openingEvidence(ctx: AnalysisContext, user: number, o: OpeningRow, caption: string): Evidence {
  return replayAt(ctx, o.round, o.tick, 5, 2, [o.attacker, o.victim], [
    line(o.attackerPos, o.victimPos, o.tick - 32, o.tick + 64, o.attacker === user ? 'good' : 'bad', o.weapon),
    label(o.victimPos, `${who(ctx, user, o.victim)} first death${o.victimPlace ? `, ${o.victimPlace}` : ''}`, o.tick, o.tick + 128, 'neutral'),
  ], caption);
}

function topPlaces(rows: readonly OpeningRow[], slot: number): string {
  const count = new Map<string, number>();
  for (const o of rows) {
    const p = o.attacker === slot ? o.attackerPlace : o.victimPlace;
    if (p) count.set(p, (count.get(p) ?? 0) + 1);
  }
  const list = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2);
  return list.map(([p, k]) => `${p} (${k})`).join(', ');
}

const opening: Detector = {
  id: 'pos.opening', area: 'positioning', scope: 'micro',
  run(ctx, slot, metric) {
    const s = openingStats(ctx, slot);
    const n = s.duels.length;
    const out: Finding[] = [];
    const mWin = metric('pos.opening.win_rate');
    const mDuels = metric('pos.opening.duels');
    const rounds = roundsPlayedBy(ctx, slot);
    const bySide = (side: 'T' | 'CT'): string => {
      const d = s.duels.filter((o) => (o.attacker === slot ? o.attackerSide : o.victimSide) === side);
      return `${d.filter((o) => o.attacker === slot).length}/${d.length} as ${side}`;
    };
    const losses = s.duels.filter((o) => o.victim === slot);
    if (n >= T.opening.minDuels && s.wins.length / n <= T.opening.maxWinRate) {
      out.push(makeFinding({
        id: 'pos.opening.losing', area: 'positioning', scope: 'micro', polarity: 'fix',
        title: 'Stop taking opening duels you lose',
        summary: `You were in ${n} of ${rounds} rounds' opening duels and won ${s.wins.length} (${pct(s.wins.length / n)}; ${bySide('T')}, ${bySide('CT')}); most at ${topPlaces(s.duels, slot) || 'unnamed spots'}.`,
        why: 'Losing the first duel puts your team into a 4-on-5 for the rest of the round.',
        advice: [
          { text: 'Let a teammate with a flash take first contact, or take it with utility of your own; when you do peek first, peek with a plan to fall back.' },
          { text: 'Change the angle you hold or the timing you peek at the places listed above: they are being pre-aimed.' },
        ],
        metrics: present(mWin, mDuels),
        evidence: pickClearest(losses, (o) => -o.clockSec, (o) => o.tick, (o) => o.round, 3).map((o) => openingEvidence(ctx, slot, o, `${roundClock(ctx.match, o.tick)}: you died first to ${who(ctx, slot, o.attacker)}${o.victimPlace ? ` at ${o.victimPlace}` : ''}`)),
        instances: losses.length, opportunities: n, rounds: losses.map((o) => o.round), roundsLost: roundsLost(ctx, slot, losses.map((o) => o.round)),
        confidence: confidence(T.scoring.precision, n, T.scoring.nScale),
        impact: perMatch(Math.max(0, losses.length - n / 2) * T.scoring.impactOpeningLoss, rounds),
      }));
    }
    if (s.pushDeaths.length >= T.opening.minPushDeaths) {
      out.push(makeFinding({
        id: 'pos.opening.ct_push', area: 'positioning', scope: 'micro', polarity: 'fix',
        title: 'Don\'t die first pushing as CT',
        summary: `${plural(s.pushDeaths.length, 'time')} you died first as CT in the first ${T.opening.earlySec} s, closer to the T spawn than to your own (${s.pushDeaths.map((o) => o.victimPlace || '?').join(', ')}).`,
        why: 'An early CT death away from the site leaves that site a player short before the Ts have even committed.',
        advice: [{ text: 'Take early map control only with a teammate or utility, and fall back to your site once you have seen what you wanted to see.' }],
        metrics: present(metric('pos.opening.ct_push_deaths'), mWin),
        evidence: pickClearest(s.pushDeaths, (o) => o.victimPush ?? 0, (o) => o.tick, (o) => o.round, 3).map((o) => openingEvidence(ctx, slot, o, `${roundClock(ctx.match, o.tick)}: first death of the round, pushed ${pct(o.victimPush ?? 0)} of the way to the T spawn`)),
        instances: s.pushDeaths.length, opportunities: n, rounds: s.pushDeaths.map((o) => o.round), roundsLost: roundsLost(ctx, slot, s.pushDeaths.map((o) => o.round)),
        confidence: confidence(T.scoring.precision, s.pushDeaths.length, T.scoring.nScale),
        impact: perMatch(s.pushDeaths.length * T.scoring.impactPushDeath, rounds),
      }));
    }
    if (n >= T.opening.minDuels && s.wins.length / n >= T.opening.strengthWinRate && isStrength(mWin, T.opening.minDuels)) {
      out.push(makeFinding({
        id: 'pos.opening.strength', area: 'positioning', scope: 'micro', polarity: 'strength',
        title: 'You win the opening duels',
        summary: `You won ${s.wins.length} of ${n} opening duels (${pct(s.wins.length / n)}, ${rankText(mWin)}; ${bySide('T')}, ${bySide('CT')}).`,
        why: 'The first kill decides most rounds.',
        advice: [{ text: 'Keep taking them, and call the kill so your team can use the advantage.' }],
        metrics: present(mWin, mDuels),
        evidence: pickClearest(s.wins, (o) => o.clockSec, (o) => o.tick, (o) => o.round, 2).map((o) => openingEvidence(ctx, slot, o, `${roundClock(ctx.match, o.tick)}: your opening kill on ${who(ctx, slot, o.victim)}`)),
        instances: s.wins.length, opportunities: n, rounds: s.wins.map((o) => o.round),
        confidence: confidence(T.scoring.precision, n, T.scoring.nScale), impact: 0,
      }));
    }
    return out;
  },
};

export const POSITIONING_DETECTORS: readonly Detector[] = [untradeable, missed, opening, DEATH_CONTEXT_DETECTOR];
