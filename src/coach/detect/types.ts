/**
 * Contract 3: a detector. Runs for the user's slot after every metric is computed; `metric(id)` gives the user's
 * value of any metric with its lobby rank. Returns findings (fixes, strengths, observations), each with evidence.
 * Shared helpers for confidence, strengths and finding skeletons are in `./common.ts`.
 */
import type { AnalysisContext } from '../analyze/context';
import type { Finding, FindingArea, FindingScope, MetricValue } from '../model/report';

export type DetectorNeed = 'los' | 'knowledge';

export interface Detector {
  /** `<area>.<name>`, e.g. `aim.counter_strafe`; its findings' ids start with it. */
  readonly id: string;
  readonly area: FindingArea;
  readonly scope: FindingScope;
  /** What the detector cannot run without; it is skipped when a need is missing. */
  readonly needs?: readonly DetectorNeed[];
  run(ctx: AnalysisContext, slot: number, metric: (id: string) => MetricValue | null): Finding[];
}
