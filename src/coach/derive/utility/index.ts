/** utility area (K4): derived tables. Tables are also imported directly by their users. */
import type { TableDef } from '../../analyze/context';
import { PLACE_INDEX } from './places';
import { THROWS } from './throws';

export const UTILITY_TABLES: readonly TableDef<unknown>[] = [PLACE_INDEX, THROWS];
