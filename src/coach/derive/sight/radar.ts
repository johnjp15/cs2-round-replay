/**
 * K6: how the demo's radar flags relate to computed sight (docs/coach/sight.md, "Radar flags"). `spottedBy` (the
 * demo's `approximate_spotted_by`, bit q = slot q) on the target's row is the game's own "q has spotted him" state;
 * the game sense card reads it and needs to know its agreement with true sight and its lag.
 *
 * Over every live enemy pair-row (`SEE.eval`): the agreement of the radar bit with `seen` (in view and not blind) and
 * with `los` (any line of sight). Lags: for each sighting, the rows from its first row to the first row the radar bit
 * is set (searched from maxLagSec before to maxLagSec after; negative = the radar was first), and from its last row to
 * the first row the bit is clear again (only sightings the radar bit was on for).
 */
import type { AnalysisContext } from '../../analyze/context';
import { FLAG } from '../../model/raw';
import { median } from '../aim/select';
import { SEE, type SightTable } from './sightings';
import { SIGHT_TUNING } from './tuning';

export interface Confusion {
  /** Both on, sight only, radar only, neither. */
  both: number;
  sightOnly: number;
  radarOnly: number;
  neither: number;
}

export interface LagStats {
  n: number;
  /** Edges with no radar change inside the search window. */
  none: number;
  medianMs: number;
  p10Ms: number;
  p90Ms: number;
}

export interface RadarComparison {
  pairRows: number;
  seen: Confusion;
  los: Confusion;
  /** Rows the radar bit is set and the pair has line of sight but is not in view (radar without view). */
  radarLosNotInView: number;
  /** Per target row (some enemy pair live): the target's own `spotted` flag against "some enemy sees him" / "has line of sight". */
  targetRows: number;
  spottedSeen: Confusion;
  spottedLos: Confusion;
  /** Sightings of at least radar.longSightingSec, and how many of them the radar bit flagged within the window. */
  long: { n: number; flagged: number };
  start: LagStats;
  end: LagStats;
}

function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] as number;
}

function lagStats(lags: readonly number[], none: number, msPerRow: number): LagStats {
  return { n: lags.length, none, medianMs: median(lags) * msPerRow, p10Ms: quantile(lags, 0.1) * msPerRow, p90Ms: quantile(lags, 0.9) * msPerRow };
}

export function compareRadar(ctx: AnalysisContext, tab: SightTable): RadarComparison {
  const P = ctx.P;
  const T = ctx.raw.ticks;
  const seen: Confusion = { both: 0, sightOnly: 0, radarOnly: 0, neither: 0 };
  const los: Confusion = { both: 0, sightOnly: 0, radarOnly: 0, neither: 0 };
  let pairRows = 0;
  let radarLosNotInView = 0;
  let targetRows = 0;
  const spottedSeen: Confusion = { both: 0, sightOnly: 0, radarOnly: 0, neither: 0 };
  const spottedLos: Confusion = { both: 0, sightOnly: 0, radarOnly: 0, neither: 0 };
  const add = (c: Confusion, on: boolean, rb: boolean): void => {
    if (on && rb) c.both++;
    else if (on) c.sightOnly++;
    else if (rb) c.radarOnly++;
    else c.neither++;
  };
  const radar = (r: number, o: number, t: number): boolean => (((T.spottedBy[r * P + t] ?? 0) >> o) & 1) === 1;
  if (tab.available) {
    for (let r = 0; r < T.count; r++) {
      for (let t = 0; t < P; t++) {
        let live = false;
        let anySeen = false;
        let anyLos = false;
        for (let o = 0; o < P; o++) {
          const s = tab.state[(r * P + o) * P + t] ?? 0;
          if ((s & SEE.eval) === 0) continue;
          live = true;
          pairRows++;
          const rb = radar(r, o, t);
          const sn = (s & SEE.seen) !== 0;
          const sl = (s & SEE.los) !== 0;
          anySeen ||= sn;
          anyLos ||= sl;
          add(seen, sn, rb);
          add(los, sl, rb);
          if (rb && sl && (s & SEE.inView) === 0) radarLosNotInView++;
        }
        if (!live) continue;
        targetRows++;
        const spotted = ((T.flags[r * P + t] ?? 0) & FLAG.spotted) !== 0;
        add(spottedSeen, anySeen, spotted);
        add(spottedLos, anyLos, spotted);
      }
    }
  }
  const rate = ctx.raw.header.tickRate || 64;
  const maxLag = Math.round(SIGHT_TUNING.radar.maxLagSec * rate);
  const starts: number[] = [];
  const long: { n: number; flagged: number } = { n: 0, flagged: 0 };
  const longRows = Math.round(SIGHT_TUNING.radar.longSightingSec * rate);
  const ends: number[] = [];
  let noStart = 0;
  let noEnd = 0;
  for (const g of tab.sightings) {
    let found: number | null = null;
    if (radar(g.r0, g.obs, g.tgt)) {
      // Already on: how long before?
      let r = g.r0;
      while (r > g.r0 - maxLag && r > 0 && radar(r - 1, g.obs, g.tgt)) r--;
      found = r - g.r0;
    } else {
      for (let r = g.r0 + 1; r <= g.r0 + maxLag && r < T.count; r++) {
        if (radar(r, g.obs, g.tgt)) {
          found = r - g.r0;
          break;
        }
      }
    }
    if (g.r1 - g.r0 + 1 >= longRows) {
      long.n++;
      if (found !== null) long.flagged++;
    }
    if (found === null) noStart++;
    else starts.push(found);
    let on = false;
    for (let r = g.r0; r <= g.r1 && !on; r++) on = radar(r, g.obs, g.tgt);
    if (!on) continue;
    let off: number | null = null;
    for (let r = g.r1 + 1; r <= g.r1 + maxLag && r < T.count; r++) {
      if (!radar(r, g.obs, g.tgt)) {
        off = r - g.r1 - 1;
        break;
      }
    }
    if (off === null) noEnd++;
    else ends.push(off);
  }
  const msPerRow = 1000 / rate;
  return { pairRows, seen, los, radarLosNotInView, targetRows, spottedSeen, spottedLos, long, start: lagStats(starts, noStart, msPerRow), end: lagStats(ends, noEnd, msPerRow) };
}
