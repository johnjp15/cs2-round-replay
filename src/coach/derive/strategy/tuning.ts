/**
 * K8: typed loader for data/coach/tuning/strategy.json (strategy tables and detectors). Every number is checked.
 */
import json from '../../../../data/coach/tuning/strategy.json';
import { checkNumbers } from '../utility/tuning';

export interface StrategyTuning {
  grid: { sampleTicks: number };
  lanes: { takeMinTs: number; takeMinSec: number; checkpoint1Sec: number; checkpoint2Sec: number; checkpoint3Sec: number; contestSec: number; lookRange: number; lookStep: number };
  hits: {
    hitMinTs: number; commitWindowSec: number; utilWindowSec: number; utilAfterSec: number; utilMin: number;
    fastSec: number; lateSec: number; secondSec: number; lurkDistance: number;
  };
  setup: { setupSec: number };
  rotations: { infoMinTs: number; earlySlackSec: number; stayGraceSec: number; rotateMaxSec: number; punishSec: number };
  repeats: { minCount: number; minShare: number };
  detect: {
    laneMinTaken: number; laneMinOpen: number; laneOpenShare: number; laneMinPunished: number;
    setupLight: number; setupMinLight: number; setupMinLost: number; rotateMin: number;
    tMinHits: number; tMinDry: number; tDryWinMax: number; tMinExec: number; tExecWinMin: number;
    opponentMinRounds: number; nScale: number; precision: number; impactPerRound: number; evidenceRounds: number;
  };
}

export function loadStrategyTuning(j: unknown): StrategyTuning {
  return checkNumbers<StrategyTuning>(j, {
    grid: ['sampleTicks'],
    lanes: ['takeMinTs', 'takeMinSec', 'checkpoint1Sec', 'checkpoint2Sec', 'checkpoint3Sec', 'contestSec', 'lookRange', 'lookStep'],
    hits: ['hitMinTs', 'commitWindowSec', 'utilWindowSec', 'utilAfterSec', 'utilMin', 'fastSec', 'lateSec', 'secondSec', 'lurkDistance'],
    setup: ['setupSec'],
    rotations: ['infoMinTs', 'earlySlackSec', 'stayGraceSec', 'rotateMaxSec', 'punishSec'],
    repeats: ['minCount', 'minShare'],
    detect: [
      'laneMinTaken', 'laneMinOpen', 'laneOpenShare', 'laneMinPunished', 'setupLight', 'setupMinLight', 'setupMinLost', 'rotateMin',
      'tMinHits', 'tMinDry', 'tDryWinMax', 'tMinExec', 'tExecWinMin', 'opponentMinRounds', 'nScale', 'precision', 'impactPerRound', 'evidenceRounds',
    ],
  }, 'strategy');
}

export const STRATEGY_TUNING: StrategyTuning = loadStrategyTuning(json);

/** The lane checkpoints in seconds after freeze end. */
export function checkpoints(t: StrategyTuning = STRATEGY_TUNING): number[] {
  return [t.lanes.checkpoint1Sec, t.lanes.checkpoint2Sec, t.lanes.checkpoint3Sec];
}
