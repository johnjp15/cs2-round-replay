/**
 * strategy area (K8): detectors, in a fixed order: `strat.lane`, `strat.setup`, `strat.rotate`, `strat.t_side`,
 * `strat.opponent`. Definitions and thresholds: docs/coach/strategy.md, data/coach/tuning/strategy.json.
 */
import type { Detector } from '../types';
import { laneDetector } from './lane';
import { opponentDetector } from './opponent';
import { rotateDetector } from './rotate';
import { setupDetector } from './setup';
import { tSideDetector } from './t-side';

export const STRATEGY_DETECTORS: readonly Detector[] = [laneDetector, setupDetector, rotateDetector, tSideDetector, opponentDetector];
