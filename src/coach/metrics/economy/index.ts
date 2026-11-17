/** economy area (K4): metrics, in a fixed order. Definitions: docs/coach/utility.md. */
import type { MetricDef } from '../types';
import { kitArmorStats, syncStats } from './instances';

export const ECONOMY_METRICS: readonly MetricDef[] = [
  {
    id: 'eco.sync.off_share', label: 'Rounds your buy went against three or more teammates', unit: '%', better: 'lower', area: 'economy',
    compute(ctx, slot) {
      const s = syncStats(ctx, slot);
      return s.rounds.length === 0 ? null : { value: s.instances.length / s.rounds.length, n: s.rounds.length };
    },
  },
  {
    id: 'eco.kit_armor.miss_share', label: 'Gun rounds with a kit, armor or utility hole', unit: '%', better: 'lower', area: 'economy',
    compute(ctx, slot) {
      const s = kitArmorStats(ctx, slot);
      return s.gunRounds.length === 0 ? null : { value: s.instances.length / s.gunRounds.length, n: s.gunRounds.length };
    },
  },
];
