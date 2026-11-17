/**
 * K6: the sight-based aim metrics (`aim.placement`, `aim.time_to_damage`, `aim.habits`), for every slot. Definitions:
 * docs/coach/sight.md. Every one is null without a sight mesh. They use the same selections as their detectors
 * (`src/coach/derive/sight/select.ts`).
 */
import type { MetricDef, MetricResult } from '../types';
import { median } from '../../derive/aim/select';
import { HABITS } from '../../derive/sight/habits';
import { damageSights, placementSights, sawFirstSights } from '../../derive/sight/select';
import { SIGHT_TUNING } from '../../derive/sight/tuning';
import { roundsPlayedBy } from '../../detect/common';
import type { AnalysisContext } from '../../analyze/context';

const med = (xs: readonly number[]): MetricResult | null => (xs.length === 0 ? null : { value: median(xs), n: xs.length });
const pl = SIGHT_TUNING.placement;
const tt = SIGHT_TUNING.timeToDamage;

function habitCount(ctx: AnalysisContext, slot: number, k: 'airborne' | 'flashed' | 'scopedMoving' | 'repeeks'): MetricResult | null {
  const h = ctx.table(HABITS);
  if (!h.available) return null;
  const n = roundsPlayedBy(ctx, slot);
  if (n === 0) return null;
  const list = h[k][slot] ?? [];
  // Shots count once per burst: a habit is a decision, not a bullet.
  const value = k === 'airborne' || k === 'flashed' ? new Set((list as readonly { burst: number }[]).map((s) => s.burst)).size : list.length;
  return { value, n };
}

export const SIGHT_AIM_METRICS: readonly MetricDef[] = [
  {
    id: 'aim.placement.angle_deg', label: 'Median angle from your crosshair to the enemy\'s head when he first came into view', unit: 'deg', better: 'lower', area: 'aim', minN: pl.minN,
    compute: (ctx, p) => med(placementSights(ctx, p).map((x) => x.angle)),
  },
  {
    id: 'aim.placement.vertical_deg', label: 'Vertical placement error at first sight (|median|; the finding gives the sign)', unit: 'deg', better: 'lower', area: 'aim', minN: pl.minN,
    compute: (ctx, p) => {
      const r = med(placementSights(ctx, p).map((x) => x.up));
      return r === null ? null : { value: Math.abs(r.value), n: r.n };
    },
  },
  {
    id: 'aim.placement.horizontal_deg', label: 'Horizontal placement error at first sight (|median|)', unit: 'deg', better: 'lower', area: 'aim', minN: pl.minN,
    compute: (ctx, p) => {
      const r = med(placementSights(ctx, p).map((x) => x.right));
      return r === null ? null : { value: Math.abs(r.value), n: r.n };
    },
  },
  {
    id: 'aim.placement.holding_deg', label: 'Median placement angle when you were holding still', unit: 'deg', better: 'lower', area: 'aim', minN: 4,
    compute: (ctx, p) => med(placementSights(ctx, p).filter((x) => x.holding).map((x) => x.angle)),
  },
  {
    id: 'aim.placement.peeking_deg', label: 'Median placement angle when you were moving (peeking)', unit: 'deg', better: 'lower', area: 'aim', minN: 4,
    compute: (ctx, p) => med(placementSights(ctx, p).filter((x) => !x.holding).map((x) => x.angle)),
  },
  {
    id: 'aim.placement.leetify_deg', label: 'Leetify-style: median angle your view moved from first sight to the first damaging shot', unit: 'deg', better: 'lower', area: 'aim', minN: 4,
    compute: (ctx, p) => med(placementSights(ctx, p).flatMap((x) => (x.moved === null ? [] : [x.moved]))),
  },
  {
    id: 'aim.time_to_damage.median_ms', label: 'Median time from first sight to your first damage on that enemy', unit: 'ms', better: 'lower', area: 'aim', minN: 4,
    compute: (ctx, p) => med(damageSights(ctx, p).map((x) => x.damageMs as number)),
  },
  {
    id: 'aim.time_to_damage.leetify_ms', label: 'Leetify-style: the same, dropping times of a second or more', unit: 'ms', better: 'lower', area: 'aim', minN: 4,
    compute: (ctx, p) => med(damageSights(ctx, p).map((x) => x.damageMs as number).filter((x) => x < tt.leetifyCapMs)),
  },
  {
    id: 'aim.time_to_damage.shot_ms', label: 'Median time from first sight to your first shot at that enemy', unit: 'ms', better: 'lower', area: 'aim', minN: 4,
    compute: (ctx, p) => med(placementSights(ctx, p).flatMap((x) => (x.shotMs === null ? [] : [x.shotMs]))),
  },
  {
    id: 'aim.time_to_damage.saw_first_lost_share', label: 'Duels you saw first by a clear margin and lost', unit: '%', better: 'lower', area: 'aim', minN: 3,
    compute: (ctx, p) => {
      const s = sawFirstSights(ctx, p);
      return s.length === 0 ? null : { value: s.filter((x) => x.outcome === 'lost').length / s.length, n: s.length };
    },
  },
  { id: 'aim.habits.airborne_bursts', label: 'Bursts fired in the air at a target', unit: 'count', better: 'lower', area: 'aim', compute: (ctx, p) => habitCount(ctx, p, 'airborne') },
  { id: 'aim.habits.flashed_bursts', label: 'Bursts fired while blind', unit: 'count', better: 'lower', area: 'aim', compute: (ctx, p) => habitCount(ctx, p, 'flashed') },
  { id: 'aim.habits.scoped_moving', label: 'Moving scoped with a sniper rifle while an enemy was in sight (runs)', unit: 'count', better: 'lower', area: 'aim', compute: (ctx, p) => habitCount(ctx, p, 'scopedMoving') },
  { id: 'aim.habits.sniper_repeeks', label: 'Re-peeks of the same angle within seconds of a missed sniper shot', unit: 'count', better: 'lower', area: 'aim', compute: (ctx, p) => habitCount(ctx, p, 'repeeks') },
];
