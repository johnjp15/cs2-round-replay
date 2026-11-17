/** K8: the strategy area's derived tables, in build order. */
import type { TableDef } from '../../analyze/context';
import { PLACE_BOXES } from './boxes';
import { STRAT_GRID } from './grid';
import { STRAT_HITS } from './hits';
import { STRAT_LANES } from './lanes';
import { STRAT_REPEATS } from './repeats';
import { STRAT_ROTATIONS } from './rotations';
import { STRAT_SETUPS } from './setups';

export const STRATEGY_TABLES: readonly TableDef<unknown>[] = [STRAT_GRID, STRAT_HITS, STRAT_LANES, STRAT_SETUPS, STRAT_ROTATIONS, STRAT_REPEATS, PLACE_BOXES];
