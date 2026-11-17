/** aim area (K2): derived tables. */
import type { TableDef } from '../../analyze/context';
import { SHOTS } from './shots';
import { SPRAYS } from './sprays';
import { TARGETS } from './targets';

export { SHOTS, stopTechnique, wishDir } from './shots';
export type { BurstRow, ShotRow, ShotTables, StopTechnique } from './shots';
export { TARGETS } from './targets';
export type { TargetRow, TargetTables } from './targets';
export { SPRAYS } from './sprays';
export type { SprayBullet, SprayRow } from './sprays';

export const AIM_TABLES: readonly TableDef<unknown>[] = [SHOTS, TARGETS, SPRAYS];
