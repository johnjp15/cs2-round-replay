/**
 * Contract 3: `analyze(raw, match, { user, los? }) → MatchReport`.
 *
 * 1. Build the context (`createContext`).
 * 2. Compute every metric for every slot: the lobby values, and ranks (1 = best; ties share a rank, competition
 *    ranking 1, 2, 2, 4; `better` decides the direction; slots without a value get NaN and rank 0).
 * 3. Run every detector for the user (skipping those whose `needs` are missing).
 * 4. First prioritizer: `priority = impact × confidence`; fixes sorted by priority (then id); the top `maxFixes`, never
 *    two from the same detector family (the id up to the second dot) and never one without evidence; strengths = up to
 *    `maxStrengths` `strength` findings by priority. K5 replaces this.
 * 5. Fill `MatchReport`: match facts, the user's value of every metric (with the whole lobby), findings, top fixes,
 *    strengths, round summaries. `replay` stays empty here (K3's `src/coach/report/replay.ts`).
 *
 * Deterministic: lists in fixed orders, no Date / Math.random; the same input gives a byte-identical JSON.
 */
import type { LosWorld } from '../derive/los';
import { HURTS } from '../derive/hurts';
import { ALL_DETECTORS } from '../detect/index';
import type { Detector } from '../detect/types';
import { ALL_METRICS } from '../metrics/index';
import type { MetricDef } from '../metrics/types';
import type { Match, MatchRound } from '../model/match';
import type { RawDemo } from '../model/raw';
import { REPORT_FORMAT, type Finding, type MatchReport, type MetricValue, type RoundSummary } from '../model/report';
import type { CoachTuning } from '../tuning';
import { createContext, type AnalysisContext } from './context';
import { REPORT_TUNING, type ReportTuning } from './report-tuning';

export { createContext } from './context';
export type { AnalysisContext, TableDef } from './context';

export const COACH_VERSION = 'coach@0.2.0-k2';

export interface AnalyzeOptions {
  /** The user's slot. */
  user: number;
  los?: LosWorld | null;
  tuning?: CoachTuning;
  report?: ReportTuning;
  /** Override the metric and detector lists (tests). */
  metrics?: readonly MetricDef[];
  detectors?: readonly Detector[];
}

/** One metric for every slot. */
export interface LobbyMetric {
  def: MetricDef;
  values: number[];
  n: number[];
  ranks: number[];
}

/** Competition ranks (1 = best) of `values`; NaN gets rank 0. */
export function lobbyRanks(values: readonly number[], better: 'higher' | 'lower'): number[] {
  return values.map((v) => {
    if (!Number.isFinite(v)) return 0;
    let ahead = 0;
    for (const w of values) if (Number.isFinite(w) && (better === 'higher' ? w > v : w < v)) ahead++;
    return ahead + 1;
  });
}

export function computeLobby(ctx: AnalysisContext, defs: readonly MetricDef[]): LobbyMetric[] {
  const ids = new Set<string>();
  return defs.map((def) => {
    if (ids.has(def.id)) throw new Error(`analysis: metric ${def.id} defined twice`);
    ids.add(def.id);
    const values: number[] = [];
    const n: number[] = [];
    for (let p = 0; p < ctx.P; p++) {
      const r = def.compute(ctx, p);
      const ok = r !== null && Number.isFinite(r.value) && r.n >= (def.minN ?? 1);
      values.push(ok ? round6(r.value) : NaN);
      n.push(r === null ? 0 : r.n);
    }
    return { def, values, n, ranks: lobbyRanks(values, def.better) };
  });
}

/** The MetricValue of one slot. */
export function metricValueFor(m: LobbyMetric, slot: number): MetricValue {
  return { id: m.def.id, value: m.values[slot] ?? NaN, unit: m.def.unit, n: m.n[slot] ?? 0, lobbyRank: m.ranks[slot] ?? 0, lobby: [...m.values] };
}

/** Detector family: the id up to the second dot (`aim.counter_strafe.early` → `aim.counter_strafe`). */
export function family(id: string): string {
  const parts = id.split('.');
  return parts.slice(0, 2).join('.');
}

/** The first prioritizer (see the file comment). Sets `priority` on every finding; returns the chosen ids. */
export function prioritize(findings: Finding[], t: ReportTuning = REPORT_TUNING): { topFixes: string[]; strengths: string[] } {
  for (const f of findings) f.priority = round6(f.impact * f.confidence);
  const order = (a: Finding, b: Finding): number => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const eligible = (f: Finding): boolean => f.evidence.length > 0 && f.confidence >= t.prioritizer.minConfidence;
  const fixes = findings.filter((f) => f.polarity === 'fix' && eligible(f)).sort(order);
  const topFixes: string[] = [];
  const families = new Set<string>();
  for (const f of fixes) {
    if (topFixes.length >= t.prioritizer.maxFixes) break;
    if (families.has(family(f.id))) continue;
    families.add(family(f.id));
    topFixes.push(f.id);
  }
  const strengths = findings.filter((f) => f.polarity === 'strength' && eligible(f)).sort(order).slice(0, t.prioritizer.maxStrengths).map((f) => f.id);
  return { topFixes, strengths };
}

function publicRound(r: MatchRound): Omit<MatchRound, 'rowStart' | 'rowEnd' | 'refRow'> {
  return {
    index: r.index, number: r.number, played: r.played, kind: r.kind, startTick: r.startTick, freezeEndTick: r.freezeEndTick,
    endTick: r.endTick, officialEndTick: r.officialEndTick, sides: r.sides, winnerSide: r.winnerSide, winner: r.winner,
    reason: r.reason, reasonName: r.reasonName, scoreAfter: r.scoreAfter, bomb: r.bomb, economy: r.economy, roster: r.roster,
  };
}

function roundSummaries(ctx: AnalysisContext, user: number): RoundSummary[] {
  const hurts = ctx.table(HURTS);
  const team = ctx.teamOf(user);
  return ctx.match.rounds.map((r) => {
    const tags: string[] = [];
    if (r.kind !== 'regulation') tags.push(r.kind);
    if (!r.played) tags.push('not_played');
    if (team !== null && r.played) tags.push(r.economy[team].buy);
    if (team !== null) tags.push(r.sides.T === team ? 'T' : 'CT');
    if (r.bomb.plantTick !== null) tags.push('planted');
    if (r.bomb.defuseTick !== null) tags.push('defused');
    if (r.bomb.explodeTick !== null) tags.push('exploded');
    let kills = 0;
    let died = false;
    for (const k of ctx.raw.events.kills) {
      if (k.tick < r.startTick || k.tick > r.endTick) continue;
      if (k.victim === user) died = true;
      if (k.attacker === user && k.victim !== user && team !== null && ctx.teamOf(k.victim) !== team) kills++;
    }
    let damage = 0;
    for (const h of hurts) if (h.round === r.number && h.hurt.attacker === user && h.enemy) damage += h.damage;
    return { number: r.number, winner: r.winner, reasonName: r.reasonName, tags, user: { kills, died, damage } };
  });
}

export function analyze(raw: RawDemo, match: Match, opts: AnalyzeOptions): MatchReport {
  if (!(opts.user >= 0 && opts.user < raw.players.length)) throw new Error(`analysis: no player slot ${opts.user}`);
  const ctx = createContext(raw, match, { los: opts.los ?? null, ...(opts.tuning ? { tuning: opts.tuning } : {}) });
  const t = opts.report ?? REPORT_TUNING;
  const lobby = computeLobby(ctx, opts.metrics ?? ALL_METRICS);
  const byId = new Map(lobby.map((m) => [m.def.id, m]));
  const metric = (id: string): MetricValue | null => {
    const m = byId.get(id);
    return m === undefined ? null : metricValueFor(m, opts.user);
  };
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const d of opts.detectors ?? ALL_DETECTORS) {
    if (d.needs?.includes('los') === true && ctx.los === null) continue;
    if (d.needs?.includes('knowledge') === true) continue; // no map knowledge loader yet (K8)
    for (const f of d.run(ctx, opts.user, metric)) {
      if (!f.id.startsWith(d.id)) throw new Error(`analysis: finding ${f.id} does not start with its detector id ${d.id}`);
      if (seen.has(f.id)) throw new Error(`analysis: finding id ${f.id} used twice`);
      seen.add(f.id);
      findings.push(f);
    }
  }
  const { topFixes, strengths } = prioritize(findings, t);
  return {
    format: REPORT_FORMAT,
    match: {
      meta: match.meta,
      players: match.players,
      rounds: match.rounds.map(publicRound),
    },
    user: opts.user,
    metrics: lobby.map((m) => metricValueFor(m, opts.user)),
    findings,
    topFixes,
    strengths,
    rounds: roundSummaries(ctx, opts.user),
    replay: [],
    coachVersion: COACH_VERSION,
  };
}

/** The report as JSON (NaN → null, typed arrays → plain arrays). Byte-identical for the same input. */
export function reportJson(report: MatchReport, indent = 0): string {
  return JSON.stringify(report, (_k, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v), indent);
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
