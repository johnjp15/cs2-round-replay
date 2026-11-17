/** positioning area (K4): metrics, in a fixed order. Definitions: docs/coach/utility.md. */
import type { MetricDef } from '../types';
import { roundsPlayedBy } from '../../detect/common';
import { median } from '../utility/instances';
import { DEATH_CONTEXT_METRICS } from './death-context';
import { openingStats, tradeChances, untradeableStats } from './instances';

export const POSITIONING_METRICS: readonly MetricDef[] = [
  {
    id: 'pos.untradeable.share', label: 'Deaths with no teammate in trade range, untraded', unit: '%', better: 'lower', area: 'positioning',
    compute(ctx, slot) {
      const s = untradeableStats(ctx, slot);
      return s.deaths.length === 0 ? null : { value: s.instances.length / s.deaths.length, n: s.deaths.length };
    },
  },
  {
    id: 'pos.untradeable.nearest_median', label: 'Median distance to the nearest teammate at death', unit: 'units', better: 'lower', area: 'positioning',
    compute(ctx, slot) {
      const s = untradeableStats(ctx, slot);
      return s.nearest.length === 0 ? null : { value: median(s.nearest), n: s.nearest.length };
    },
  },
  {
    id: 'trade.missed.miss_share', label: 'Trade chances with no damage to the killer', unit: '%', better: 'lower', area: 'trading',
    compute(ctx, slot) {
      const c = tradeChances(ctx, slot);
      return c.length === 0 ? null : { value: c.filter((x) => x.missed).length / c.length, n: c.length };
    },
  },
  {
    id: 'trade.missed.success_share', label: 'Trade chances you traded', unit: '%', better: 'higher', area: 'trading',
    compute(ctx, slot) {
      const c = tradeChances(ctx, slot);
      return c.length === 0 ? null : { value: c.filter((x) => x.traded).length / c.length, n: c.length };
    },
  },
  {
    id: 'pos.opening.duels', label: 'Opening duels taken', unit: 'count', better: 'higher', area: 'positioning',
    compute(ctx, slot) {
      const s = openingStats(ctx, slot);
      return { value: s.duels.length, n: roundsPlayedBy(ctx, slot) };
    },
  },
  {
    id: 'pos.opening.win_rate', label: 'Opening duels won', unit: '%', better: 'higher', area: 'positioning',
    compute(ctx, slot) {
      const s = openingStats(ctx, slot);
      return s.duels.length === 0 ? null : { value: s.wins.length / s.duels.length, n: s.duels.length };
    },
  },
  {
    id: 'pos.opening.ct_push_deaths', label: 'First deaths as CT pushing early', unit: 'count', better: 'lower', area: 'positioning',
    compute(ctx, slot) {
      const s = openingStats(ctx, slot);
      return { value: s.pushDeaths.length, n: roundsPlayedBy(ctx, slot) };
    },
  },
  ...DEATH_CONTEXT_METRICS,
];
