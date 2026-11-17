/** Small shared bits of the aim and movement detectors. */
import type { AnalysisContext } from '../../analyze/context';
import { median } from '../../derive/aim/select';
import type { MetricValue } from '../../model/report';

/** The lobby median of a metric (NaN when nobody has a value). */
export function lobbyMedian(mv: MetricValue): number {
  return median(mv.lobby);
}

/** Feet of slot p at row r. */
export function rowFeet(ctx: AnalysisContext, r: number, p: number): [number, number, number] {
  const T = ctx.raw.ticks;
  const i = r * ctx.P + p;
  return [T.x[i] ?? 0, T.y[i] ?? 0, T.z[i] ?? 0];
}
