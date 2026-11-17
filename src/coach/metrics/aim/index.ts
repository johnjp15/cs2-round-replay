/**
 * aim area (K2): metrics, in a fixed order. Definitions: docs/coach/mechanics.md, "Metrics". Every metric uses the
 * same selections as its detector (`src/coach/derive/aim/select.ts`).
 */
import type { MetricDef, MetricResult } from '../types';
import { firstBullets, longSprays, mean, median, spraysOf } from '../../derive/aim/select';
import { AIM_TUNING } from '../../derive/aim/tuning';
import { SIGHT_AIM_METRICS } from './sight';

const share = (k: number, n: number): MetricResult | null => (n === 0 ? null : { value: k / n, n });

const cs = AIM_TUNING.counterStrafe;

export const AIM_METRICS: readonly MetricDef[] = [
  {
    id: 'aim.counter_strafe.early_share', label: 'First rifle bullets fired while moving (Leetify-comparable: rifles, not crouched)',
    unit: '%', better: 'lower', area: 'aim', minN: cs.minN,
    compute: (ctx, p) => {
      const f = firstBullets(ctx, p, true);
      return share(f.filter((x) => x.shot.moving).length, f.length);
    },
  },
  {
    id: 'aim.counter_strafe.early_share_all', label: 'First bullets fired while moving (every gun)', unit: '%', better: 'lower', area: 'aim', minN: cs.minN,
    compute: (ctx, p) => {
      const f = firstBullets(ctx, p);
      return share(f.filter((x) => x.shot.moving).length, f.length);
    },
  },
  {
    id: 'aim.counter_strafe.late_ms', label: 'Median ms from a moving first bullet until the speed fell under the threshold', unit: 'ms', better: 'lower', area: 'aim', minN: 3,
    compute: (ctx, p) => {
      const e = firstBullets(ctx, p).filter((x) => x.shot.moving);
      return e.length === 0 ? null : { value: median(e.map((x) => x.shot.msToStop)), n: e.length };
    },
  },
  {
    id: 'aim.counter_strafe.cost_x', label: 'Inaccuracy of moving first bullets against the same shot standing (mean ratio)', unit: 'x', better: 'lower', area: 'aim', minN: 3,
    compute: (ctx, p) => {
      const e = firstBullets(ctx, p).filter((x) => x.shot.moving && x.shot.stillInaccuracy > 0);
      return e.length === 0 ? null : { value: mean(e.map((x) => x.shot.inaccuracy / x.shot.stillInaccuracy)), n: e.length };
    },
  },
  {
    id: 'aim.counter_strafe.opposite_share', label: 'Stops before a first bullet made with the opposite key', unit: '%', better: 'higher', area: 'aim', minN: 5,
    compute: (ctx, p) => {
      const f = firstBullets(ctx, p).filter((x) => x.shot.stop !== 'standing');
      return share(f.filter((x) => x.shot.stop === 'opposite').length, f.length);
    },
  },
  {
    id: 'aim.spray.on_target_share', label: 'Spray bullets (from bullet 2) whose compensated aim crossed the target', unit: '%', better: 'higher', area: 'aim', minN: 10,
    compute: (ctx, p) => {
      const b = spraysOf(ctx, p).flatMap((s) => s.bullets.filter((x) => x.n >= AIM_TUNING.spray.bulletFrom));
      return share(b.filter((x) => x.onTarget).length, b.length);
    },
  },
  {
    id: 'aim.spray.vertical_drift_deg', label: 'Vertical drift of the compensated aim over bullets 4+ (|median|, degrees)', unit: 'deg', better: 'lower', area: 'aim', minN: 10,
    compute: (ctx, p) => {
      const b = spraysOf(ctx, p).flatMap((s) => s.bullets.filter((x) => x.n >= 4));
      return b.length === 0 ? null : { value: Math.abs(median(b.map((x) => x.up))), n: b.length };
    },
  },
  {
    id: 'aim.spray.horizontal_drift_deg', label: 'Horizontal drift of the compensated aim over bullets 4+ (|median|, degrees)', unit: 'deg', better: 'lower', area: 'aim', minN: 10,
    compute: (ctx, p) => {
      const b = spraysOf(ctx, p).flatMap((s) => s.bullets.filter((x) => x.n >= 4));
      return b.length === 0 ? null : { value: Math.abs(median(b.map((x) => x.right))), n: b.length };
    },
  },
  {
    id: 'aim.spray.hit_share', label: 'Spray bullets (from bullet 2) that hit the target', unit: '%', better: 'higher', area: 'aim', minN: 10,
    compute: (ctx, p) => {
      const b = spraysOf(ctx, p).flatMap((s) => s.bullets.filter((x) => x.n >= AIM_TUNING.spray.bulletFrom));
      return share(b.filter((x) => x.hit).length, b.length);
    },
  },
  {
    id: 'aim.range_discipline.wasted_share', label: 'Long sprays at long range that hit nothing after bullet 4', unit: '%', better: 'lower', area: 'aim', minN: 1,
    compute: (ctx, p) => {
      const l = longSprays(ctx, p);
      return share(l.filter((x) => x.wasted).length, l.length);
    },
  },
  {
    id: 'aim.first_bullet.hit_share', label: 'First bullets that hit', unit: '%', better: 'higher', area: 'aim', minN: AIM_TUNING.firstBullet.minN,
    compute: (ctx, p) => {
      const f = firstBullets(ctx, p);
      return share(f.filter((x) => x.shot.hitEnemy).length, f.length);
    },
  },
  {
    id: 'aim.first_bullet.hit_share_standing', label: 'First bullets that hit, fired standing (below the threshold)', unit: '%', better: 'higher', area: 'aim', minN: 5,
    compute: (ctx, p) => {
      const f = firstBullets(ctx, p).filter((x) => !x.shot.moving);
      return share(f.filter((x) => x.shot.hitEnemy).length, f.length);
    },
  },
  {
    id: 'aim.first_bullet.hit_share_moving', label: 'First bullets that hit, fired moving', unit: '%', better: 'higher', area: 'aim', minN: 5,
    compute: (ctx, p) => {
      const f = firstBullets(ctx, p).filter((x) => x.shot.moving);
      return share(f.filter((x) => x.shot.hitEnemy).length, f.length);
    },
  },
  ...SIGHT_AIM_METRICS,
];
