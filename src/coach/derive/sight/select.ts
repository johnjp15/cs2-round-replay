/**
 * Selections over the sight tables that the sight metrics and detectors share, so a metric and the finding built on it
 * count exactly the same moments.
 */
import type { AnalysisContext } from '../../analyze/context';
import { FIRSTS, type FirstSight } from './firsts';
import { SIGHT_TUNING } from './tuning';

/** First sights that count for crosshair placement: within placement.maxDistance. */
export function placementSights(ctx: AnalysisContext, slot: number): FirstSight[] {
  const f = ctx.table(FIRSTS);
  if (!f.available) return [];
  return (f.bySlot[slot] ?? []).filter((x) => x.dist <= SIGHT_TUNING.placement.maxDistance);
}

/** First sights followed by the player's damage on that enemy (time to damage). */
export function damageSights(ctx: AnalysisContext, slot: number): FirstSight[] {
  return placementSights(ctx, slot).filter((x) => x.damageMs !== null);
}

/** Duels where the player saw the enemy first by a clear margin. */
export function sawFirstSights(ctx: AnalysisContext, slot: number): FirstSight[] {
  return placementSights(ctx, slot).filter((x) => x.sawFirst);
}
