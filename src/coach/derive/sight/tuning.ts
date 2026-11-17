/** Typed loader for data/coach/tuning/sight.json (all sections but `los`, which `src/coach/derive/los.ts` reads). */
import json from '../../../../data/coach/tuning/sight.json';
import { numbers, section } from '../../analyze/area-tuning';

const F = 'data/coach/tuning/sight.json';

export interface SightTuning {
  sightings: { stepTicks: number; maxDistance: number; blindRemainingSec: number };
  duels: { mergeGapSec: number; preSec: number; postSec: number; holdSpeed: number; clearMarginMs: number };
  placement: { minN: number; gapDeg: number; namedDeg: number; maxDistance: number; nScale: number; precision: number; costPerDuel: number };
  timeToDamage: {
    leetifyCapMs: number; minN: number; gapMs: number; minSawFirstLost: number; sawFirstLostShare: number; nScale: number; precision: number;
    costSlow: number; costSawFirstLost: number;
  };
  habits: { scopedMinMs: number; repeekSec: number; repeekRadius: number; fixCount: number; nScale: number; precision: number; costPerInstance: number };
  deathContext: {
    lookbackSec: number; behindDeg: number; repeekSec: number; repeekRadius: number; hideSec: number; openSec: number; openMinMove: number;
    minDeaths: number; fixShare: number; nScale: number; precision: number; costPerDeath: number;
  };
  radar: { maxLagSec: number; longSightingSec: number };
}

export function loadSightTuning(j: unknown): SightTuning {
  const s = (k: string): Record<string, unknown> => section(j, k, F);
  const t: SightTuning = {
    sightings: numbers(s('sightings'), ['stepTicks', 'maxDistance', 'blindRemainingSec'], `${F} sightings`),
    duels: numbers(s('duels'), ['mergeGapSec', 'preSec', 'postSec', 'holdSpeed', 'clearMarginMs'], `${F} duels`),
    placement: numbers(s('placement'), ['minN', 'gapDeg', 'namedDeg', 'maxDistance', 'nScale', 'precision', 'costPerDuel'], `${F} placement`),
    timeToDamage: numbers(s('timeToDamage'), ['leetifyCapMs', 'minN', 'gapMs', 'minSawFirstLost', 'sawFirstLostShare', 'nScale', 'precision', 'costSlow', 'costSawFirstLost'], `${F} timeToDamage`),
    habits: numbers(s('habits'), ['scopedMinMs', 'repeekSec', 'repeekRadius', 'fixCount', 'nScale', 'precision', 'costPerInstance'], `${F} habits`),
    deathContext: numbers(s('deathContext'), ['lookbackSec', 'behindDeg', 'repeekSec', 'repeekRadius', 'hideSec', 'openSec', 'openMinMove', 'minDeaths', 'fixShare', 'nScale', 'precision', 'costPerDeath'], `${F} deathContext`),
    radar: numbers(s('radar'), ['maxLagSec', 'longSightingSec'], `${F} radar`),
  };
  if (!(t.sightings.stepTicks >= 1)) throw new Error(`${F}: sightings.stepTicks must be at least 1`);
  return t;
}

export const SIGHT_TUNING: SightTuning = loadSightTuning(json);
