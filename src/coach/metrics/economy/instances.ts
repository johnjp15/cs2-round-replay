/**
 * K4: the per-player instance lists behind the economy metrics and detectors.
 */
import type { AnalysisContext } from '../../analyze/context';
import { BUYS, type BuyRow, isRifle } from '../../derive/economy/buys';
import { itemPrice } from '../../derive/economy/prices';
import { ECONOMY_TUNING } from '../../derive/economy/tuning';

export interface SyncRound {
  buy: BuyRow;
  /** Teammates on an eco and buying (force or full) that round. */
  ecoMates: number;
  buyMates: number;
  kind: 'forced' | 'saved';
}

export interface SyncStats {
  /** Non-pistol rounds of the player. */
  rounds: BuyRow[];
  instances: SyncRound[];
}

const buys = (c: string): boolean => c === 'force' || c === 'full';

export function syncStats(ctx: AnalysisContext, slot: number): SyncStats {
  const t = ECONOMY_TUNING.sync;
  const all = ctx.table(BUYS);
  const rounds = all.filter((b) => b.p === slot && b.buyClass !== 'pistol');
  const instances: SyncRound[] = [];
  for (const b of rounds) {
    const mates = all.filter((m) => m.round === b.round && m.team === b.team && m.p !== slot);
    const ecoMates = mates.filter((m) => m.buyClass === 'eco').length;
    const buyMates = mates.filter((m) => buys(m.buyClass)).length;
    if (buys(b.buyClass) && ecoMates >= t.minTeammates) instances.push({ buy: b, ecoMates, buyMates, kind: 'forced' });
    else if (b.buyClass === 'eco' && buyMates >= t.minTeammates) instances.push({ buy: b, ecoMates, buyMates, kind: 'saved' });
  }
  return { rounds, instances };
}

export interface LoadoutIssue {
  buy: BuyRow;
  noKit: boolean;
  noArmor: boolean;
  leftover: boolean;
}

export interface KitArmorStats {
  /** Rounds with a primary weapon after the buy. */
  gunRounds: BuyRow[];
  instances: LoadoutIssue[];
}

export function kitArmorStats(ctx: AnalysisContext, slot: number): KitArmorStats {
  const t = ECONOMY_TUNING.kitArmor;
  const gunRounds = ctx.table(BUYS).filter((b) => b.p === slot && b.primary !== null && b.buyClass !== 'pistol');
  const kit = itemPrice('defuser');
  const instances: LoadoutIssue[] = [];
  for (const b of gunRounds) {
    const issue: LoadoutIssue = {
      buy: b,
      noKit: b.side === 'CT' && !b.kit && b.moneyLeft >= kit,
      noArmor: isRifle(b.primary) && b.armor === 0,
      leftover: b.buyClass === 'full' && b.moneyLeft > t.leftoverMin && b.grenades.length <= t.maxGrenadesLeftover,
    };
    if (issue.noKit || issue.noArmor || issue.leftover) instances.push(issue);
  }
  return { gunRounds, instances };
}
