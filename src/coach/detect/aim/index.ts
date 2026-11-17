/** aim area (K2): detectors, in a fixed order. */
import type { Detector } from '../types';
import { COUNTER_STRAFE } from './counter-strafe';
import { FIRST_BULLET } from './first-bullet';
import { RANGE_DISCIPLINE } from './range-discipline';
import { SPRAY } from './spray';
import { HABITS_DETECTOR } from './habits';
import { PLACEMENT } from './placement';
import { TIME_TO_DAMAGE } from './time-to-damage';

export const AIM_DETECTORS: readonly Detector[] = [COUNTER_STRAFE, SPRAY, RANGE_DISCIPLINE, FIRST_BULLET, PLACEMENT, TIME_TO_DAMAGE, HABITS_DETECTOR];
