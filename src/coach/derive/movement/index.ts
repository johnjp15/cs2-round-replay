/** movement area (K2): derived tables. */
import type { TableDef } from '../../analyze/context';
import { DEATHS_IN_HAND, RELOADS } from './reloads';

export { DEATHS_IN_HAND, RELOADS } from './reloads';
export type { DeathInHand, ReloadRow } from './reloads';
export { speedAt, velocityDirAt } from './speed';

export const MOVEMENT_TABLES: readonly TableDef<unknown>[] = [RELOADS, DEATHS_IN_HAND];
