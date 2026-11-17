/** Selections shared by the movement metrics and detectors. */
import type { AnalysisContext } from '../../analyze/context';
import { DEATHS_IN_HAND, type DeathInHand } from './reloads';
import { MOVEMENT_TUNING } from './tuning';

/** Deaths of `slot` with the knife or a grenade (or the bomb) in hand, not while throwing at the killer. */
export function caughtOutDeaths(ctx: AnalysisContext, slot: number): DeathInHand[] {
  const items = MOVEMENT_TUNING.caughtOut.items;
  return ctx.table(DEATHS_IN_HAND).filter((d) => d.victim === slot && d.attacker >= 0 && d.attacker !== slot && items.includes(d.weapon) && !d.throwingAtKiller);
}
