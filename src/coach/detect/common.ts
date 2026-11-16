/**
 * Helpers every detector uses: the sample-size confidence, the strength rule, the finding skeleton, evidence picking.
 *
 * **Impact scale** (comparable across detectors; K5 recalibrates, K9 replaces it with round-win probability): the
 * estimated number of fights the habit decided against the player, scaled to a 24-round match
 * (`perMatch(x, rounds)`). A fight is roughly 0.1–0.2 rounds of win probability, so an impact of 3 is "about three
 * duels a match", worth fixing; below 0.5 a finding is noise for the prioritizer.
 */
import type { AnalysisContext } from '../analyze/context';
import { REPORT_TUNING, type ReportTuning } from '../analyze/report-tuning';
import type { Evidence, Finding, FindingArea, FindingScope, MetricValue, Polarity } from '../model/report';

/** Rounds in a regulation match: the impact scale's reference length. */
export const IMPACT_ROUNDS = 24;

/** Sample-size factor in [0, 1): 1 − exp(−n / nScale). n = nScale gives 0.63, 3 × nScale 0.95. */
export function sampleFactor(n: number, nScale: number): number {
  if (!(n > 0) || !(nScale > 0)) return 0;
  return 1 - Math.exp(-n / nScale);
}

/** Confidence = the detector's precision (until K11 measures it: a constant per detector from its tuning) × sample factor. */
export function confidence(precision: number, n: number, nScale: number): number {
  return round3(Math.max(0, Math.min(1, precision)) * sampleFactor(n, nScale));
}

/** Count per `IMPACT_ROUNDS` rounds. */
export function perMatch(count: number, roundsPlayed: number): number {
  return roundsPlayed > 0 ? round3((count * IMPACT_ROUNDS) / roundsPlayed) : 0;
}

/** Rounds the slot was present in and that were played (the denominator for per-match scaling). */
export function roundsPlayedBy(ctx: AnalysisContext, slot: number): number {
  const mine = new Set(ctx.match.players[slot]?.rounds ?? []);
  return ctx.match.rounds.filter((r) => r.played && mine.has(r.number)).length;
}

/** Number of slots with a defined value of the metric. */
export function lobbySize(mv: MetricValue): number {
  return mv.lobby.filter((v) => Number.isFinite(v)).length;
}

/** The user is clearly good at it: rank ≤ strengthMaxRank among at least strengthMinLobby defined values, with n ≥ minN. */
export function isStrength(mv: MetricValue | null, minN: number, t: ReportTuning = REPORT_TUNING): boolean {
  if (mv === null || !Number.isFinite(mv.value) || mv.n < minN) return false;
  return mv.lobbyRank >= 1 && mv.lobbyRank <= t.confidence.strengthMaxRank && lobbySize(mv) >= t.confidence.strengthMinLobby;
}

/** The user ranks in the bottom half of the lobby (or the metric is worse than the lobby median). */
export function isBelowMedian(mv: MetricValue | null): boolean {
  if (mv === null || !Number.isFinite(mv.value) || mv.lobbyRank < 1) return false;
  return mv.lobbyRank > Math.ceil(lobbySize(mv) / 2);
}

export interface FindingInit {
  id: string;
  area: FindingArea;
  scope: FindingScope;
  polarity: Polarity;
  title: string;
  summary: string;
  why: string;
  advice: Finding['advice'];
  metrics: MetricValue[];
  evidence: Evidence[];
  instances: number;
  opportunities: number;
  rounds: number[];
  roundsLost?: number;
  confidence: number;
  impact: number;
}

export function makeFinding(f: FindingInit): Finding {
  const rounds = [...new Set(f.rounds)].sort((a, b) => a - b);
  return {
    id: f.id,
    area: f.area,
    scope: f.scope,
    polarity: f.polarity,
    title: f.title,
    summary: f.summary,
    why: f.why,
    advice: f.advice,
    metrics: f.metrics,
    evidence: f.evidence,
    stats: { instances: f.instances, opportunities: f.opportunities, rounds, roundsLost: f.roundsLost ?? 0, winProbLost: null },
    confidence: f.confidence,
    impact: round3(f.impact),
    priority: 0,
  };
}

/**
 * The clearest `k` items by `score` (higher first; ties by `key` ascending), at most one per round when there are
 * enough rounds, returned in time order (by `key`). Use it to pick evidence moments: not the first ones, the clearest.
 */
export function pickClearest<T>(items: readonly T[], score: (x: T) => number, key: (x: T) => number, roundOf: (x: T) => number, k: number): T[] {
  const sorted = [...items].sort((a, b) => score(b) - score(a) || key(a) - key(b));
  const out: T[] = [];
  const used = new Set<number>();
  for (const x of sorted) {
    if (out.length >= k) break;
    if (used.has(roundOf(x))) continue;
    used.add(roundOf(x));
    out.push(x);
  }
  for (const x of sorted) {
    if (out.length >= k) break;
    if (!out.includes(x)) out.push(x);
  }
  return out.sort((a, b) => key(a) - key(b));
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
