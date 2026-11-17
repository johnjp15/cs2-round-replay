/** K4: typed loader for data/coach/tuning/economy.json (buys, economy detectors). */
import json from '../../../../data/coach/tuning/economy.json';
import { checkNumbers } from '../utility/tuning';

export interface EconomyTuning {
  buys: { buyTimeSec: number; maxGrenades: number };
  sync: { minTeammates: number; minRounds: number };
  kitArmor: { leftoverMin: number; maxGrenadesLeftover: number; minRounds: number };
  scoring: { nScale: number; precision: number; impactSyncRound: number; impactKitArmorRound: number };
}

export function loadEconomyTuning(j: unknown): EconomyTuning {
  return checkNumbers<EconomyTuning>(j, {
    buys: ['buyTimeSec', 'maxGrenades'],
    sync: ['minTeammates', 'minRounds'],
    kitArmor: ['leftoverMin', 'maxGrenadesLeftover', 'minRounds'],
    scoring: ['nScale', 'precision', 'impactSyncRound', 'impactKitArmorRound'],
  }, 'economy');
}

export const ECONOMY_TUNING: EconomyTuning = loadEconomyTuning(json);
