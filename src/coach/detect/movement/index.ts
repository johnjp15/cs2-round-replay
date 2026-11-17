/** movement area (K2): detectors, in a fixed order. */
import type { Detector } from '../types';
import { CAUGHT_OUT } from './caught-out';
import { RELOAD } from './reload';

export const MOVEMENT_DETECTORS: readonly Detector[] = [RELOAD, CAUGHT_OUT];
