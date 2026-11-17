/** sight (K6): derived tables, in build order. docs/coach/sight.md. */
import type { TableDef } from '../../analyze/context';
import { DEATH_CONTEXT } from './death-context';
import { DUELS } from './duels';
import { FIRSTS } from './firsts';
import { HABITS } from './habits';
import { SIGHTINGS } from './sightings';

export { SEE, SIGHTINGS, buildSightings, seeAt, smokeDetonations, blindRows } from './sightings';
export type { Sighting, SightStats, SightTable, SightOptions } from './sightings';
export { DUELS, sideOf } from './duels';
export type { DuelRow, DuelSide, DuelTables } from './duels';
export { FIRSTS } from './firsts';
export type { FirstOutcome, FirstSight, FirstTables } from './firsts';
export { HABITS } from './habits';
export type { HabitTables, Repeek, ScopedRun } from './habits';
export { AVOIDABLE, DEATH_CONTEXT, DEATH_LABELS } from './death-context';
export type { DeathContext, DeathContextTables, DeathLabel } from './death-context';
export { compareRadar } from './radar';
export type { RadarComparison } from './radar';
export { SIGHT_TUNING } from './tuning';

export const SIGHT_TABLES: readonly TableDef<unknown>[] = [SIGHTINGS, DUELS, FIRSTS, HABITS, DEATH_CONTEXT];
