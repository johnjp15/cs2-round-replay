/** All detectors, joined by area in a fixed order (aim, movement, utility, positioning, economy). */
import type { Detector } from './types';
import { AIM_DETECTORS } from './aim/index';
import { MOVEMENT_DETECTORS } from './movement/index';
import { UTILITY_DETECTORS } from './utility/index';
import { POSITIONING_DETECTORS } from './positioning/index';
import { ECONOMY_DETECTORS } from './economy/index';

export const ALL_DETECTORS: readonly Detector[] = [...AIM_DETECTORS, ...MOVEMENT_DETECTORS, ...UTILITY_DETECTORS, ...POSITIONING_DETECTORS, ...ECONOMY_DETECTORS];
