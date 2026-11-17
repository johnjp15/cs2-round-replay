/**
 * Contract 3: a metric. Computed for every slot (that gives the lobby ranks); `better` decides the rank direction.
 * `compute` returns null where the metric is undefined for the slot (too few samples, never held a rifle, …); such a
 * slot gets NaN in `MetricValue.lobby` (null in JSON) and no rank.
 */
import type { AnalysisContext } from '../analyze/context';
import type { FindingArea } from '../model/report';

export interface MetricResult {
  value: number;
  /** Sample size behind the value. */
  n: number;
}

export interface MetricDef {
  /** `<detector id>.<name>`, e.g. `aim.counter_strafe.early_share`. Unique. */
  readonly id: string;
  readonly label: string;
  /** `%` (value is a 0–1 share), `ms`, `deg`, `count`, `per_round`, `$/round`, `x`, `units`; shown by `metricValue` (report/format.ts). */
  readonly unit: string;
  readonly better: 'higher' | 'lower';
  readonly area: FindingArea;
  /** A slot with fewer samples than this gets no value (default 1). */
  readonly minN?: number;
  compute(ctx: AnalysisContext, slot: number): MetricResult | null;
}
