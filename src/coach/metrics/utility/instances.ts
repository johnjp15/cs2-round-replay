/**
 * K4: the per-player instance lists behind the utility metrics and detectors (one definition, used by both).
 */
import type { AnalysisContext } from '../../analyze/context';
import { BUYS, type BuyRow, isRifle } from '../../derive/economy/buys';
import { grenadesOf, isGrenade, itemPrice } from '../../derive/economy/prices';
import { DEATHS, type DeathRow } from '../../derive/positioning/deaths';
import { alive, rowBefore } from '../../derive/positioning/grid';
import { THROWS, type Blinded, type Throw } from '../../derive/utility/throws';
import { UTILITY_TUNING } from '../../derive/utility/tuning';
import { roundsPlayedBy } from '../../detect/common';

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export interface FlashStats {
  flashes: Throw[];
  /** Flashes that blinded no enemy for minBlindSec or more. */
  noEnemy: Throw[];
  /** Counted enemy blinds (durations, seconds). */
  enemyBlinds: number[];
  teammatesBlinded: number;
  selfBlinded: number;
  ledToKill: number;
  /** Teammates (or the thrower) blinded ≥ minBlindSec who took enemy damage or died inside the window. */
  teamFights: { flash: Throw; blind: Blinded }[];
}

export function flashStats(ctx: AnalysisContext, slot: number): FlashStats {
  const flashes = ctx.table(THROWS).filter((t) => t.thrower === slot && t.type === 'flash' && t.detTick !== null);
  const s: FlashStats = { flashes, noEnemy: [], enemyBlinds: [], teammatesBlinded: 0, selfBlinded: 0, ledToKill: 0, teamFights: [] };
  for (const f of flashes) {
    if (f.enemiesBlinded === 0) s.noEnemy.push(f);
    s.teammatesBlinded += f.teammatesBlinded;
    if (f.selfBlinded) s.selfBlinded++;
    if (f.ledToKill) s.ledToKill++;
    for (const b of f.blinds) {
      if (!b.counts) continue;
      if (b.rel === 'enemy') s.enemyBlinds.push(b.duration);
      else if (b.fightTick !== null) s.teamFights.push({ flash: f, blind: b });
    }
  }
  return s;
}

export interface UnusedStats {
  rounds: number;
  deaths: DeathRow[];
  /** Grenades and value carried at death and, for survivors, at round end. */
  deathGrenades: number;
  deathValue: number;
  endGrenades: number;
  endValue: number;
  /** Deaths with at least minGrenades left in rounds the team lost. */
  lostDeaths: DeathRow[];
}

export function unusedStats(ctx: AnalysisContext, slot: number): UnusedStats {
  const { raw, match } = ctx;
  const deaths = ctx.table(DEATHS).filter((d) => d.victim === slot);
  const s: UnusedStats = { rounds: roundsPlayedBy(ctx, slot), deaths, deathGrenades: 0, deathValue: 0, endGrenades: 0, endValue: 0, lostDeaths: [] };
  for (const d of deaths) {
    s.deathGrenades += d.grenades.length;
    s.deathValue += d.grenadeValue;
    if (!d.roundWon && d.grenades.length >= UTILITY_TUNING.unused.minGrenades) s.lostDeaths.push(d);
  }
  for (const r of match.rounds) {
    if (!r.played) continue;
    const inv = raw.inventories.find((v) => v.at === 'round_end' && v.p === slot && v.tick === r.endTick);
    if (!inv || !alive(raw, rowBefore(raw, r.endTick + 1), slot)) continue;
    const g = grenadesOf(inv.items);
    s.endGrenades += g.grenades.length;
    s.endValue += g.value;
  }
  return s;
}

/** The cheapest of a flashbang and a smoke. */
export function cheapestUtility(): number {
  return Math.min(itemPrice('flashbang'), itemPrice('smokegrenade'));
}

export interface NoUtilStats {
  rifleRounds: BuyRow[];
  /** Rifle rounds with no grenade bought or carried and at least the cheapest utility left. */
  instances: BuyRow[];
}

export function noUtilStats(ctx: AnalysisContext, slot: number): NoUtilStats {
  const rifleRounds = ctx.table(BUYS).filter((b) => b.p === slot && isRifle(b.primary));
  const min = cheapestUtility();
  return { rifleRounds, instances: rifleRounds.filter((b) => !b.bought.some(isGrenade) && b.grenades.length === 0 && b.moneyLeft >= min) };
}

export interface DamageStats {
  /** HE and fire grenades that detonated. */
  grenades: Throw[];
  damage: number;
  fires: Throw[];
  /** Fires with no enemy damage, no enemy inside and none near, for their whole life. */
  wastedFires: Throw[];
}

export function damageStats(ctx: AnalysisContext, slot: number): DamageStats {
  const grenades = ctx.table(THROWS).filter((t) => t.thrower === slot && (t.type === 'he' || t.type === 'fire') && t.detTick !== null);
  const fires = grenades.filter((t) => t.type === 'fire');
  return {
    grenades, fires, damage: grenades.reduce((s, t) => s + t.enemyDamage, 0),
    wastedFires: fires.filter((t) => t.enemyDamage === 0 && t.fireEnemySec === 0 && t.fireNearSec === 0),
  };
}
