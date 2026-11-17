/** aim area (K2): detectors, in a fixed order. */
import type { Detector } from '../types';
import { COUNTER_STRAFE } from './counter-strafe';
import { FIRST_BULLET } from './first-bullet';
import { RANGE_DISCIPLINE } from './range-discipline';
import { SPRAY } from './spray';

export const AIM_DETECTORS: readonly Detector[] = [COUNTER_STRAFE, SPRAY, RANGE_DISCIPLINE, FIRST_BULLET];
