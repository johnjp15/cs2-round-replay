/** movement area (K2): metrics, in a fixed order. Definitions: docs/coach/mechanics.md, "Metrics". */
import type { MetricDef } from '../types';
import { DEATHS_IN_HAND, RELOADS } from '../../derive/movement/index';
import { caughtOutDeaths } from '../../derive/movement/select';

export const MOVEMENT_METRICS: readonly MetricDef[] = [
  {
    id: 'move.reload.exposed_share', label: 'Reloads started with an enemy near or more than half a magazine left', unit: '%', better: 'lower', area: 'movement', minN: 3,
    compute: (ctx, p) => {
      const r = ctx.table(RELOADS).filter((x) => x.p === p);
      return r.length === 0 ? null : { value: r.filter((x) => x.exposed).length / r.length, n: r.length };
    },
  },
  {
    id: 'move.reload.deaths', label: 'Deaths while reloading', unit: 'count', better: 'lower', area: 'movement',
    compute: (ctx, p) => {
      const d = ctx.table(DEATHS_IN_HAND).filter((x) => x.victim === p);
      return { value: d.filter((x) => x.reloading).length, n: d.length };
    },
  },
  {
    id: 'move.caught_out.share', label: 'Deaths with the knife or a grenade in hand', unit: '%', better: 'lower', area: 'movement', minN: 3,
    compute: (ctx, p) => {
      const d = ctx.table(DEATHS_IN_HAND).filter((x) => x.victim === p);
      return d.length === 0 ? null : { value: caughtOutDeaths(ctx, p).length / d.length, n: d.length };
    },
  },
];
