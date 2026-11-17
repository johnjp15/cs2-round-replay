/** utility area (K4): metrics, in a fixed order. Definitions: docs/coach/utility.md. */
import type { MetricDef } from '../types';
import { damageStats, flashStats, median, noUtilStats, unusedStats } from './instances';


export const UTILITY_METRICS: readonly MetricDef[] = [
  {
    id: 'util.flash.enemies_per_flash', label: 'Enemies blinded per flash (≥ 1.1 s)', unit: 'count', better: 'higher', area: 'utility',
    compute(ctx, slot) {
      const s = flashStats(ctx, slot);
      return s.flashes.length === 0 ? null : { value: s.enemyBlinds.length / s.flashes.length, n: s.flashes.length };
    },
  },
  {
    id: 'util.flash.blind_median', label: 'Median enemy blind time', unit: 'ms', better: 'higher', area: 'utility', minN: 3,
    compute(ctx, slot) {
      const s = flashStats(ctx, slot);
      return s.enemyBlinds.length === 0 ? null : { value: median(s.enemyBlinds) * 1000, n: s.enemyBlinds.length };
    },
  },
  {
    id: 'util.flash.team_per_flash', label: 'Teammates blinded per flash (≥ 1.1 s)', unit: 'count', better: 'lower', area: 'utility',
    compute(ctx, slot) {
      const s = flashStats(ctx, slot);
      return s.flashes.length === 0 ? null : { value: s.teammatesBlinded / s.flashes.length, n: s.flashes.length };
    },
  },
  {
    id: 'util.flash.self_share', label: 'Flashes that blinded yourself (≥ 1.1 s)', unit: '%', better: 'lower', area: 'utility',
    compute(ctx, slot) {
      const s = flashStats(ctx, slot);
      return s.flashes.length === 0 ? null : { value: s.selfBlinded / s.flashes.length, n: s.flashes.length };
    },
  },
  {
    id: 'util.flash.kill_share', label: 'Flashes that led to a kill', unit: '%', better: 'higher', area: 'utility',
    compute(ctx, slot) {
      const s = flashStats(ctx, slot);
      return s.flashes.length === 0 ? null : { value: s.ledToKill / s.flashes.length, n: s.flashes.length };
    },
  },
  {
    id: 'util.unused.grenades_per_round', label: 'Grenades unused at death or round end, per round', unit: 'per_round', better: 'lower', area: 'utility',
    compute(ctx, slot) {
      const s = unusedStats(ctx, slot);
      return s.rounds === 0 ? null : { value: (s.deathGrenades + s.endGrenades) / s.rounds, n: s.rounds };
    },
  },
  {
    id: 'util.unused.value_per_round', label: 'Dollars of grenades unused at death or round end, per round', unit: 'per_round', better: 'lower', area: 'utility',
    compute(ctx, slot) {
      const s = unusedStats(ctx, slot);
      return s.rounds === 0 ? null : { value: (s.deathValue + s.endValue) / s.rounds, n: s.rounds };
    },
  },
  {
    id: 'util.buy.no_util_share', label: 'Rifle rounds with no utility though affordable', unit: '%', better: 'lower', area: 'utility',
    compute(ctx, slot) {
      const s = noUtilStats(ctx, slot);
      return s.rifleRounds.length === 0 ? null : { value: s.instances.length / s.rifleRounds.length, n: s.rifleRounds.length };
    },
  },
  {
    id: 'util.damage.per_grenade', label: 'HE and fire damage per grenade', unit: 'count', better: 'higher', area: 'utility',
    compute(ctx, slot) {
      const s = damageStats(ctx, slot);
      return s.grenades.length === 0 ? null : { value: s.damage / s.grenades.length, n: s.grenades.length };
    },
  },
  {
    id: 'util.damage.wasted_fire_share', label: 'Fires no enemy touched or came near', unit: '%', better: 'lower', area: 'utility',
    compute(ctx, slot) {
      const s = damageStats(ctx, slot);
      return s.fires.length === 0 ? null : { value: s.wastedFires.length / s.fires.length, n: s.fires.length };
    },
  },
];
