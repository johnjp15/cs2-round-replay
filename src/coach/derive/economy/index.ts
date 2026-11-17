/** economy area (K4): derived tables. Tables are also imported directly by their users. */
import type { TableDef } from '../../analyze/context';
import { BUYS } from './buys';

export const ECONOMY_TABLES: readonly TableDef<unknown>[] = [BUYS];
