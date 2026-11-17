/** positioning area (K4): derived tables. Tables are also imported directly by their users. */
import type { TableDef } from '../../analyze/context';
import { DEATHS } from './deaths';
import { OPENING } from './opening';
import { TRADES } from './trades';

export const POSITIONING_TABLES: readonly TableDef<unknown>[] = [TRADES, DEATHS, OPENING];
