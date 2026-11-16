/** K4: typed loader for data/coach/tuning/positioning.json (trades, deaths, opening duels). */
import json from '../../../../data/coach/tuning/positioning.json';
import { checkNumbers } from '../utility/tuning';

export interface PositioningTuning {
  trades: { windowSec: number; tradeDistance: number; losStepTicks: number };
  untradeable: { minInstances: number; share: number };
  missed: { minMissed: number; share: number };
  opening: { minDuels: number; maxWinRate: number; earlySec: number; pushProgress: number; minPushDeaths: number; strengthWinRate: number };
  clock: { roundSec: number };
  scoring: { nScale: number; precision: number; impactUntradeable: number; impactMissedTrade: number; impactOpeningLoss: number; impactPushDeath: number };
}

export function loadPositioningTuning(j: unknown): PositioningTuning {
  return checkNumbers<PositioningTuning>(j, {
    trades: ['windowSec', 'tradeDistance', 'losStepTicks'],
    untradeable: ['minInstances', 'share'],
    missed: ['minMissed', 'share'],
    opening: ['minDuels', 'maxWinRate', 'earlySec', 'pushProgress', 'minPushDeaths', 'strengthWinRate'],
    clock: ['roundSec'],
    scoring: ['nScale', 'precision', 'impactUntradeable', 'impactMissedTrade', 'impactOpeningLoss', 'impactPushDeath'],
  }, 'positioning');
}

export const POSITIONING_TUNING: PositioningTuning = loadPositioningTuning(json);
