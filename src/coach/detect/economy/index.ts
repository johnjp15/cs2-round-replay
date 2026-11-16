/**
 * economy area (K4): detectors, in a fixed order: `eco.sync`, `eco.kit_armor`.
 * Definitions and thresholds: docs/coach/utility.md, data/coach/tuning/economy.json.
 */
import type { AnalysisContext } from '../../analyze/context';
import { BUYS, type BuyRow } from '../../derive/economy/buys';
import { itemPrice } from '../../derive/economy/prices';
import { ECONOMY_TUNING } from '../../derive/economy/tuning';
import { kitArmorStats, syncStats } from '../../metrics/economy/instances';
import type { Evidence } from '../../model/report';
import { plural } from '../../report/format';
import { confidence, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { at, dollars, label, present, rankText, replayAt, roundsLost } from '../utility/evidence';

const T = ECONOMY_TUNING;

function buyEvidence(ctx: AnalysisContext, user: number, b: BuyRow, text: string, caption: string, mates: number[] = []): Evidence {
  const r = ctx.match.rounds.find((x) => x.number === b.round);
  const focus = r?.freezeEndTick ?? r?.startTick ?? 0;
  const anns = [label(at(ctx, focus, user), text, focus - 640, focus + 640, 'bad')];
  for (const m of mates) {
    const mb = ctx.table(BUYS).find((x) => x.round === b.round && x.p === m);
    if (mb) anns.push(label(at(ctx, focus, m), `${mb.buyClass}, ${dollars(mb.equipAfterBuy)}`, focus - 640, focus + 640, 'teammate'));
  }
  return replayAt(ctx, b.round, focus, 10, 5, [user, ...mates], anns, caption);
}

const sync: Detector = {
  id: 'eco.sync', area: 'economy', scope: 'macro',
  run(ctx, slot, metric) {
    const s = syncStats(ctx, slot);
    if (s.instances.length < T.sync.minRounds) return [];
    const mv = metric('eco.sync.off_share');
    const forced = s.instances.filter((x) => x.kind === 'forced').length;
    const saved = s.instances.length - forced;
    const team = ctx.teamOf(slot);
    return [makeFinding({
      id: 'eco.sync.off', area: 'economy', scope: 'macro', polarity: 'fix',
      title: 'Buy with your team',
      summary: `In ${s.instances.length} of ${s.rounds.length} rounds your buy went against ${T.sync.minTeammates} or more teammates: ${[forced > 0 ? `${plural(forced, 'time')} you bought while they saved` : '', saved > 0 ? `${plural(saved, 'time')} you saved while they bought` : ''].filter((x) => x).join(', ')}${rankText(mv) ? ` (${rankText(mv)})` : ''}.`,
      why: 'A lone buy is wasted with four players on pistols, and a lone save leaves four rifles a player short; next round the money is out of step again.',
      advice: [{ text: 'Ask for the buy before the round ("full buy", "save") and follow the call even when your own money says otherwise; drop or ask for a weapon instead.' }],
      metrics: present(mv),
      evidence: pickClearest(s.instances, (x) => Math.abs(x.buy.equipAfterBuy - 2500), (x) => x.buy.round, (x) => x.buy.round, 3).map((x) => {
        const mates = (ctx.match.rounds.find((r) => r.number === x.buy.round)?.roster[team ?? 'A'] ?? []).filter((p) => p !== slot);
        return buyEvidence(ctx, slot, x.buy, `you: ${x.buy.buyClass}, ${dollars(x.buy.equipAfterBuy)}`,
          `Round ${x.buy.round}: you ${x.kind === 'forced' ? `bought (${dollars(x.buy.equipAfterBuy)})` : 'saved'} while ${x.kind === 'forced' ? x.ecoMates : x.buyMates} teammates ${x.kind === 'forced' ? 'saved' : 'bought'}`, mates);
      }),
      instances: s.instances.length, opportunities: s.rounds.length, rounds: s.instances.map((x) => x.buy.round),
      roundsLost: roundsLost(ctx, slot, s.instances.map((x) => x.buy.round)),
      confidence: confidence(T.scoring.precision, s.rounds.length, T.scoring.nScale),
      impact: perMatch(s.instances.length * T.scoring.impactSyncRound, roundsPlayedBy(ctx, slot)),
    })];
  },
};

const kitArmor: Detector = {
  id: 'eco.kit_armor', area: 'economy', scope: 'macro',
  run(ctx, slot, metric) {
    const s = kitArmorStats(ctx, slot);
    if (s.instances.length < T.kitArmor.minRounds) return [];
    const mv = metric('eco.kit_armor.miss_share');
    const kit = s.instances.filter((x) => x.noKit).length;
    const armor = s.instances.filter((x) => x.noArmor).length;
    const left = s.instances.filter((x) => x.leftover).length;
    const parts: string[] = [];
    if (kit > 0) parts.push(`${kit} as CT without a kit you could afford (${dollars(itemPrice('defuser'))})`);
    if (armor > 0) parts.push(`${armor} with a rifle and no armor`);
    if (left > 0) parts.push(`${left} full buys with over ${dollars(T.kitArmor.leftoverMin)} left and ${T.kitArmor.maxGrenadesLeftover} or fewer grenades`);
    const what = (x: (typeof s.instances)[number]): string => [x.noKit ? 'no kit' : '', x.noArmor ? 'no armor' : '', x.leftover ? `${x.buy.grenades.length} grenades` : ''].filter((t) => t).join(', ');
    return [makeFinding({
      id: 'eco.kit_armor.holes', area: 'economy', scope: 'macro', polarity: 'fix',
      title: 'Complete your loadout',
      summary: `${s.instances.length} of your ${s.gunRounds.length} gun rounds had a hole in the loadout: ${parts.join('; ')}${rankText(mv) ? ` (${rankText(mv)})` : ''}.`,
      why: 'No kit loses retakes on time, no armor turns body shots into kills, and money left in the bank does nothing this round.',
      advice: [{ text: 'Finish every gun buy in the same order: armor, gun, kit (CT), then grenades until the money or the slots run out.' }],
      metrics: present(mv),
      evidence: pickClearest(s.instances, (x) => x.buy.moneyLeft, (x) => x.buy.round, (x) => x.buy.round, 3).map((x) =>
        buyEvidence(ctx, slot, x.buy, `${x.buy.primary ?? ''}: ${what(x)}, ${dollars(x.buy.moneyLeft)} left`, `Round ${x.buy.round}: ${what(x)} with ${dollars(x.buy.moneyLeft)} left after the buy`)),
      instances: s.instances.length, opportunities: s.gunRounds.length, rounds: s.instances.map((x) => x.buy.round),
      roundsLost: roundsLost(ctx, slot, s.instances.map((x) => x.buy.round)),
      confidence: confidence(T.scoring.precision, s.gunRounds.length, T.scoring.nScale),
      impact: perMatch(s.instances.length * T.scoring.impactKitArmorRound, roundsPlayedBy(ctx, slot)),
    })];
  },
};

export const ECONOMY_DETECTORS: readonly Detector[] = [sync, kitArmor];
