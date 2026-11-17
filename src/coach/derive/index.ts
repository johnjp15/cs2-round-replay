/** All derived tables by area, in a fixed order (tables build lazily; this list is for tools and tests). */
import type { TableDef } from '../analyze/context';
import { AIM_TABLES } from './aim/index';
import { MOVEMENT_TABLES } from './movement/index';
import { UTILITY_TABLES } from './utility/index';
import { POSITIONING_TABLES } from './positioning/index';
import { ECONOMY_TABLES } from './economy/index';
import { STRATEGY_TABLES } from './strategy/index';
import { HURTS } from './hurts';

export const ALL_TABLES: readonly TableDef<unknown>[] = [HURTS, ...AIM_TABLES, ...MOVEMENT_TABLES, ...UTILITY_TABLES, ...POSITIONING_TABLES, ...ECONOMY_TABLES, ...STRATEGY_TABLES];
