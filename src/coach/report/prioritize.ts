/**
 * The prioritizer (K5): which findings lead the report. docs/coach/report.md "Prioritizer".
 *
 *   priority = impact × confidence × fixability × recurrence
 *
 * - **impact** is on one scale for every detector: fights decided against the player per 24 rounds, counting only
 *   what he does beyond a typical player of this lobby. The aim detectors already measure their cost against the
 *   lobby median; for the count-based ones (`baseline.lobby` in the tuning) the detector's impact is multiplied by
 *   the **lobby excess** of the finding's key metric (its first): the part of the user's value beyond the median of
 *   the other players, 0 when he is at or better than it. A habit most of the lobby shares (more than half a
 *   magazine left at a reload) therefore costs little and cannot lead.
 * - **confidence** is the detector's (precision × sample factor) × an **instance factor** `1 − exp(−k / instanceScale)`
 *   on the number of instances `k`: a pattern seen twice is less certain than one seen eight times, however many
 *   chances it had.
 * - **fixability** is a constant per detector family (tuning): a counter-strafe habit is quick to fix, map sense slow.
 * - **recurrence** is 1 until match history exists; `opts.recurrence[family]` = how many earlier matches had it.
 *
 * Selection: a fix must have evidence, effective confidence ≥ `minConfidence`, impact ≥ `minImpact` and priority ≥
 * `minPriority` (the bar). Up to `maxFixes`: first the best of each scope (mechanics, micro, macro) that clears the
 * bar, then the rest by priority; never two of one **root family** (tuning `families`, else the detector id); shown
 * by priority. Findings of a detector whose measured precision is below `gate.minPrecision` become observations.
 * Strengths: up to `maxStrengths` by max(impact, strengthFloor) × confidence, one per root family.
 *
 * Pure and deterministic: ties by id. Idempotent: the detector's impact is kept in `scoring.rawImpact`.
 */
import { REPORT_TUNING, type ReportTuning } from '../analyze/report-tuning';
import type { Finding, FindingScope } from '../model/report';

export interface PrioritizeOptions {
  tuning?: ReportTuning;
  /** Rank direction of a metric id (from its definition); null when unknown. */
  better?: (metricId: string) => 'higher' | 'lower' | null;
  /** The user's slot (excluded from the lobby median). */
  user?: number;
  /** Earlier matches that had each root family (match history; absent = none). */
  recurrence?: Readonly<Record<string, number>>;
}

export interface Prioritized {
  topFixes: string[];
  strengths: string[];
}

const SCOPES: readonly FindingScope[] = ['mechanics', 'micro', 'macro'];

/** Detector id: the finding id up to the second dot (`aim.counter_strafe.early` → `aim.counter_strafe`). */
export function detectorOf(id: string): string {
  return id.split('.').slice(0, 2).join('.');
}

/** Root family of a finding: the tuning group whose member is the finding's detector (or a prefix of its id), else the detector id. */
export function rootFamily(id: string, t: ReportTuning = REPORT_TUNING): string {
  let best = '';
  let bestLen = -1;
  for (const name of Object.keys(t.families).sort()) {
    for (const prefix of t.families[name] ?? []) {
      if ((id === prefix || id.startsWith(`${prefix}.`)) && prefix.length > bestLen) {
        best = name;
        bestLen = prefix.length;
      }
    }
  }
  return bestLen >= 0 ? best : detectorOf(id);
}

/** The value of `table` for the longest key that is `id` or a dot-prefix of it, else `fallback`. */
function byPrefix(table: Readonly<Record<string, number>>, id: string, fallback: number): number {
  let best = fallback;
  let bestLen = -1;
  for (const k of Object.keys(table)) {
    if ((id === k || id.startsWith(`${k}.`)) && k.length > bestLen) {
      best = table[k] ?? fallback;
      bestLen = k.length;
    }
  }
  return best;
}

export function fixabilityOf(id: string, t: ReportTuning = REPORT_TUNING): number {
  return byPrefix(t.fixability, id, t.fixabilityDefault);
}

/** Measured precision of the finding's detector, or null when K11 has not measured it. */
export function measuredPrecision(id: string, t: ReportTuning = REPORT_TUNING): number | null {
  const v = byPrefix(t.gate.measured, id, NaN);
  return Number.isFinite(v) ? v : null;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/**
 * The part of the user's value beyond the lobby median of the others, as a share of his value (lower-is-better) or
 * of the median (higher-is-better), in [0, 1]. 1 when there is no baseline (fewer than `minLobby` others with a value,
 * or the direction is unknown).
 */
export function lobbyExcess(value: number, lobby: readonly number[], user: number, better: 'higher' | 'lower' | null, minLobby: number): number {
  if (better === null || !Number.isFinite(value)) return 1;
  const others = lobby.filter((v, i) => i !== user && Number.isFinite(v));
  if (others.length < minLobby) return 1;
  const m = median(others);
  let x: number;
  if (better === 'lower') x = value > 0 ? (value - m) / value : 0;
  else x = m > 0 ? (m - value) / m : 0;
  return Math.max(0, Math.min(1, x));
}

function usesLobbyBaseline(id: string, t: ReportTuning): boolean {
  return t.baseline.lobby.some((p) => id === p || id.startsWith(`${p}.`));
}

function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Score every finding (sets `impact`, `priority`, `scoring`, and `polarity` for gated ones); returns the chosen ids. */
export function prioritize(findings: Finding[], opts: PrioritizeOptions = {}): Prioritized {
  const t = opts.tuning ?? REPORT_TUNING;
  const p = t.prioritizer;
  const user = opts.user ?? -1;
  for (const f of findings) {
    const rawImpact = f.scoring?.rawImpact ?? f.impact;
    const polarity = f.scoring?.polarity ?? f.polarity;
    const family = rootFamily(f.id, t);
    const key = f.metrics[0];
    const excess = polarity === 'fix' && usesLobbyBaseline(f.id, t) && key !== undefined
      ? lobbyExcess(key.value, key.lobby, user, opts.better?.(key.id) ?? null, p.minLobby)
      : 1;
    const instanceFactor = 1 - Math.exp(-Math.max(0, f.stats.instances) / p.instanceScale);
    const conf = f.confidence * instanceFactor;
    const fixability = fixabilityOf(f.id, t);
    const recurrence = Math.min(p.recurrenceMax, 1 + p.recurrenceStep * (opts.recurrence?.[family] ?? 0));
    const measured = measuredPrecision(f.id, t);
    const gated = measured !== null && measured < t.gate.minPrecision && polarity !== 'observation';
    const impact = rawImpact * excess;
    const priority = polarity === 'strength'
      ? Math.max(rawImpact, p.strengthFloor) * conf
      : impact * conf * fixability * recurrence;
    f.impact = r4(impact);
    f.priority = r4(priority);
    f.polarity = gated ? 'observation' : polarity;
    f.scoring = {
      rawImpact, polarity, family, excess: r4(excess), confidence: r4(conf), fixability, recurrence, gated,
      bar: polarity === 'fix' && !gated && clearsBar(f, conf, p),
    };
  }
  const order = (a: Finding, b: Finding): number => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const cands = findings.filter((f) => f.polarity === 'fix' && f.scoring?.bar === true).sort(order);
  const chosen: Finding[] = [];
  const families = new Set<string>();
  const take = (f: Finding): void => {
    chosen.push(f);
    families.add(f.scoring?.family ?? f.id);
  };
  for (const scope of SCOPES) {
    if (chosen.length >= p.maxFixes) break;
    const best = cands.find((f) => f.scope === scope && !families.has(f.scoring?.family ?? f.id));
    if (best) take(best);
  }
  for (const f of cands) {
    if (chosen.length >= p.maxFixes) break;
    if (!chosen.includes(f) && !families.has(f.scoring?.family ?? f.id)) take(f);
  }
  const strengths: Finding[] = [];
  const sFam = new Set<string>();
  for (const f of findings.filter((x) => x.polarity === 'strength' && x.evidence.length > 0 && (x.scoring?.confidence ?? 0) >= p.minConfidence).sort(order)) {
    if (strengths.length >= p.maxStrengths) break;
    const fam = f.scoring?.family ?? f.id;
    if (sFam.has(fam)) continue;
    sFam.add(fam);
    strengths.push(f);
  }
  return { topFixes: chosen.sort(order).map((f) => f.id), strengths: strengths.map((f) => f.id) };
}

function clearsBar(f: Finding, conf: number, p: ReportTuning['prioritizer']): boolean {
  return f.evidence.length > 0 && conf >= p.minConfidence && f.impact >= p.minImpact && f.priority >= p.minPriority;
}
