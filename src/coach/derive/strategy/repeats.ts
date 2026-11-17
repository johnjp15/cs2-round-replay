/**
 * K8 table `strategy.repeats`: per half (a run of consecutive played rounds with the same sides) and team, what the
 * team did again and again. As T: the site hit, each lane taken, the timing, rushes without utility. As CT: the
 * setup label, a light site, each lane contested. A choice repeats when it happened in at least `minCount` rounds and in at least
 * `minShare` of the half; `streak` is its longest run of consecutive rounds.
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import type { Side, TeamId } from '../../model/match';
import { STRAT_GRID } from './grid';
import { STRAT_HITS } from './hits';
import { STRAT_LANES } from './lanes';
import { STRAT_SETUPS } from './setups';
import { STRATEGY_TUNING } from './tuning';

export interface Repeat {
  /**
   * What repeated. As T: `site:A` (the hit), `via:palace` (a lane the hit came through), `lane:palace` (taken at all),
   * `timing:fast`, `dry` (a hit without utility). As CT: `setup:2 A, 1 mid, 2 B`, `light:B` (at most `setupLight` CTs
   * defending B at setup time), `contest:palace`, `open:palace` (taken, not contested), `quiet:palace` (not taken).
   */
  key: string;
  count: number;
  /** Rounds of the half it happened in (ascending). */
  rounds: number[];
  streak: number;
  /** count ≥ minCount and count / half rounds ≥ minShare. */
  repeats: boolean;
}

export interface HalfRepeats {
  half: number;
  team: TeamId;
  side: Side;
  rounds: number[];
  choices: Repeat[];
}

/** Count each key over the half's rounds (in order) with its longest streak. */
export function repeatsOf(rounds: readonly number[], keysOf: (round: number) => string[]): Repeat[] {
  const t = STRATEGY_TUNING.repeats;
  const by = new Map<string, number[]>();
  for (const r of rounds) for (const k of [...new Set(keysOf(r))]) {
    const l = by.get(k);
    if (l) l.push(r);
    else by.set(k, [r]);
  }
  const out: Repeat[] = [];
  for (const [key, rs] of by) {
    let streak = 0;
    let run = 0;
    for (const r of rounds) {
      run = rs.includes(r) ? run + 1 : 0;
      streak = Math.max(streak, run);
    }
    out.push({ key, count: rs.length, rounds: rs, streak, repeats: rs.length >= t.minCount && rs.length / Math.max(1, rounds.length) >= t.minShare });
  }
  return out.sort((a, b) => b.count - a.count || b.streak - a.streak || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The halves: runs of consecutive played rounds (with a grid) that have the same T team. */
export function halvesOf(ctx: AnalysisContext): { half: number; T: TeamId; CT: TeamId; rounds: number[] }[] {
  const grid = ctx.table(STRAT_GRID);
  const out: { half: number; T: TeamId; CT: TeamId; rounds: number[] }[] = [];
  for (const g of grid.rounds) {
    const last = out[out.length - 1];
    if (last !== undefined && last.T === g.round.sides.T) last.rounds.push(g.round.number);
    else out.push({ half: out.length + 1, T: g.round.sides.T, CT: g.round.sides.CT, rounds: [g.round.number] });
  }
  return out;
}

export function buildRepeats(ctx: AnalysisContext): HalfRepeats[] {
  const hits = new Map(ctx.table(STRAT_HITS).map((h) => [h.round, h]));
  const lanes = ctx.table(STRAT_LANES);
  const setups = new Map(ctx.table(STRAT_SETUPS).map((s) => [s.round, s]));
  const out: HalfRepeats[] = [];
  for (const h of halvesOf(ctx)) {
    const tKeys = (r: number): string[] => {
      const hit = hits.get(r);
      const keys: string[] = [];
      if (hit?.site) keys.push(`site:${hit.site}`);
      if (hit?.timing) keys.push(`timing:${hit.timing}`);
      if (hit?.site && !hit.behindUtil) keys.push('dry');
      for (const l of hit?.lanes ?? []) keys.push(`via:${l}`);
      for (const l of lanes) if (l.round === r && l.taken) keys.push(`lane:${l.laneId}`);
      return keys;
    };
    const ctKeys = (r: number): string[] => {
      const keys: string[] = [];
      const s = setups.get(r);
      if (s) {
        keys.push(`setup:${s.label}`);
        for (const site of ['A', 'B'] as const) if (s.defendersAtSetup[site] <= STRATEGY_TUNING.detect.setupLight) keys.push(`light:${site}`);
      }
      for (const l of lanes) if (l.round === r) keys.push(l.contested ? `contest:${l.laneId}` : l.taken ? `open:${l.laneId}` : `quiet:${l.laneId}`);
      return keys;
    };
    out.push({ half: h.half, team: h.T, side: 'T', rounds: h.rounds, choices: repeatsOf(h.rounds, tKeys) });
    out.push({ half: h.half, team: h.CT, side: 'CT', rounds: h.rounds, choices: repeatsOf(h.rounds, ctKeys) });
  }
  return out;
}

export const STRAT_REPEATS: TableDef<HalfRepeats[]> = { id: 'strategy.repeats', build: buildRepeats };
