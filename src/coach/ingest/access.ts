/**
 * Accessors over `RawDemo.ticks` restricted to a match's rounds. Pure functions; no copies of the grid except the
 * small per-round outputs.
 */
import type { AliveTimeline, Match, MatchRound, TeamId } from '../model/match';
import { FLAG, rowAtOrAfter } from '../model/raw';
import type { RawDemo } from '../model/raw';

/** The round containing a demo tick (start through end), or null (between rounds, warmup). */
export function roundAtTick(match: Match, tick: number): MatchRound | null {
  for (const r of match.rounds) if (tick >= r.startTick && tick <= r.endTick) return r;
  return null;
}

/** Rows [rowStart, rowEnd) of a round; with `live`, from the freeze end on (when the round has one). */
export function roundRows(raw: RawDemo, round: MatchRound, live = false): { rowStart: number; rowEnd: number } {
  if (live && round.freezeEndTick !== null) return { rowStart: rowAtOrAfter(raw.ticks, round.freezeEndTick), rowEnd: round.rowEnd };
  return { rowStart: round.rowStart, rowEnd: round.rowEnd };
}

/** Whether slot p is present and alive at row t. */
export function isAlive(raw: RawDemo, t: number, p: number): boolean {
  const i = t * raw.players.length + p;
  return raw.ticks.present[i] === 1 && ((raw.ticks.flags[i] ?? 0) & FLAG.alive) !== 0;
}

/** Alive players per team on every row of a round. */
export function aliveTimeline(raw: RawDemo, match: Match, round: MatchRound): AliveTimeline {
  const n = round.rowEnd - round.rowStart;
  const out: AliveTimeline = { tick: new Int32Array(n), alive: { A: new Uint8Array(n), B: new Uint8Array(n) } };
  const P = raw.players.length;
  const teamOf: TeamId[] = match.players.map((pl) => pl.team);
  for (let k = 0; k < n; k++) {
    const t = round.rowStart + k;
    out.tick[k] = raw.ticks.tick[t] ?? 0;
    for (let p = 0; p < P; p++) {
      if (!isAlive(raw, t, p)) continue;
      const tm = teamOf[p] ?? 'A';
      out.alive[tm][k] = (out.alive[tm][k] ?? 0) + 1;
    }
  }
  return out;
}

/** The rounds that count for per-round statistics. */
export function playedRounds(match: Match): MatchRound[] {
  return match.rounds.filter((r) => r.played);
}
