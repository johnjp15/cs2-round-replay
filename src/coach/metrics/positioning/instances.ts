/**
 * K4: the per-player instance lists behind the positioning and trading metrics and detectors.
 */
import type { AnalysisContext } from '../../analyze/context';
import { DEATHS, type DeathRow, type TeammateAtDeath } from '../../derive/positioning/deaths';
import { OPENING, type OpeningRow } from '../../derive/positioning/opening';
import { POSITIONING_TUNING } from '../../derive/positioning/tuning';

export interface UntradeableStats {
  /** The player's deaths to an enemy, rounds where he was the last alive excluded. */
  deaths: DeathRow[];
  /** No living teammate within tradeDistance, and not traded. */
  instances: DeathRow[];
  /** Nearest-teammate distances of `deaths`. */
  nearest: number[];
}

export function untradeableStats(ctx: AnalysisContext, slot: number): UntradeableStats {
  const max = POSITIONING_TUNING.trades.tradeDistance;
  const deaths = ctx.table(DEATHS).filter((d) => d.victim === slot && d.byEnemy && d.aliveOwn > 1);
  return {
    deaths,
    instances: deaths.filter((d) => !d.traded && (d.nearest === null || d.nearest.dist > max)),
    nearest: deaths.flatMap((d) => (d.nearest ? [d.nearest.dist] : [])),
  };
}

export interface TradeChance {
  death: DeathRow;
  me: TeammateAtDeath;
  attempted: boolean;
  traded: boolean;
  /** Another teammate traded it (not a miss). */
  tradedByOther: boolean;
  missed: boolean;
}

/**
 * A teammate died to an enemy within tradeDistance of the player while the player was alive with a gun (and, with a
 * sight mesh, the killer came into his sight inside the window).
 */
export function tradeChances(ctx: AnalysisContext, slot: number): TradeChance[] {
  const max = POSITIONING_TUNING.trades.tradeDistance;
  const out: TradeChance[] = [];
  for (const d of ctx.table(DEATHS)) {
    if (d.victim === slot || !d.byEnemy || d.killer < 0) continue;
    const me = d.teammates.find((t) => t.p === slot);
    if (!me || me.dist > max || !me.hadGun) continue;
    if (me.sawKiller === false) continue;
    const attempted = me.damageToKiller > 0;
    const tradedByOther = d.traded && !me.killedKiller;
    out.push({ death: d, me, attempted, traded: me.killedKiller, tradedByOther, missed: !attempted && !tradedByOther });
  }
  return out;
}

export interface OpeningStats {
  duels: OpeningRow[];
  wins: OpeningRow[];
  /** First deaths as CT within earlySec of freeze end, pushed past pushProgress toward the T spawn. */
  pushDeaths: OpeningRow[];
}

export function openingStats(ctx: AnalysisContext, slot: number): OpeningStats {
  const t = POSITIONING_TUNING.opening;
  const duels = ctx.table(OPENING).filter((o) => o.attacker === slot || o.victim === slot);
  return {
    duels,
    wins: duels.filter((o) => o.attacker === slot),
    pushDeaths: duels.filter((o) => o.victim === slot && o.victimSide === 'CT' && o.clockSec <= t.earlySec && o.victimPush !== null && o.victimPush >= t.pushProgress),
  };
}
