/** All metrics, joined by area in a fixed order (aim, movement, utility, positioning, economy, strategy). */
import type { MetricDef } from './types';
import { AIM_METRICS } from './aim/index';
import { MOVEMENT_METRICS } from './movement/index';
import { UTILITY_METRICS } from './utility/index';
import { POSITIONING_METRICS } from './positioning/index';
import { ECONOMY_METRICS } from './economy/index';
import { STRATEGY_METRICS } from './strategy/index';

export const ALL_METRICS: readonly MetricDef[] = [...AIM_METRICS, ...MOVEMENT_METRICS, ...UTILITY_METRICS, ...POSITIONING_METRICS, ...ECONOMY_METRICS, ...STRATEGY_METRICS];
