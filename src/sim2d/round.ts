/**
 * Round rules of the 2D sim (CS2 bomb defusal): elimination, time-out and the round end, plus the round
 * clock for `Observe.round`. Pure functions over plain data; Sim2DHost owns the state and applies them
 * once per tick after the bomb (docs/combat.md, "Bomb and round rules").
 *
 * - All CTs dead → T win by `elimination`, also after the plant.
 * - All Ts dead → CT win by `elimination`, unless the bomb is planted and ticking (then the round goes on
 *   until the defuse or the explosion).
 * - The round clock reaches 0 → CT win by `time`, unless the bomb is planted.
 * - The bomb's own ends (`bomb_exploded`, `bomb_defused`) come from bomb.ts; `end_round` forces an end.
 * The first end wins: `round_end` is emitted once and the score counts it once. The 2D engine never starts
 * a next round: after the end the pawns keep moving, shooting and taking damage until the session stops.
 */
import { roundNumber, type RoundEndReason, type RoundPhase, type Score, type Team } from '../contracts/index';
import { TICKS_PER_SEC } from './movement';

/** Tolerance for "the tick has come" on fractional tick times (same as weapons.ts `reached`). */
const TICK_EPS = 1e-9;

/** The first integer tick at or after the fractional tick `t` (rounded to the log's 6 decimals first). */
export function dueTick(t: number): number {
  return Math.ceil(roundNumber(t) - TICK_EPS);
}

/** Ticks for a duration in seconds, from `start`: the tick the duration is over. */
export function ticksAfter(start: number, sec: number): number {
  return dueTick(start + sec * TICKS_PER_SEC);
}

export interface RoundEnd {
  readonly winner: Team;
  readonly reason: RoundEndReason;
}

/** The host's round state (plain data; snapshotted). */
export interface RoundState {
  /** Round clock at tick 0 (seconds); the round times out at `timeoutTick`. */
  readonly roundTimeSec: number;
  readonly timeoutTick: number;
  /** Current score (the win is added at the end tick). */
  readonly score: Score;
  readonly winner: Team | null;
  readonly reason: RoundEndReason | null;
  readonly endTick: number | null;
}

/** Alive and total pawns per side (the roster may lack a side: then that side is never "eliminated"). */
export interface TeamCounts {
  readonly ctTotal: number;
  readonly ctAlive: number;
  readonly tTotal: number;
  readonly tAlive: number;
}

export function freshRound(roundTimeSec: number, score: Score): RoundState {
  return {
    roundTimeSec,
    timeoutTick: ticksAfter(0, roundTimeSec),
    score: { ct: score.ct, t: score.t },
    winner: null,
    reason: null,
    endTick: null,
  };
}

export function isOver(r: RoundState): boolean {
  return r.winner !== null;
}

/**
 * The end the rules give at `tick`, or null. Checked after the bomb, so a bomb end on the same tick wins.
 * CTs are checked first: if the last T and the last CT die on the same tick, T win (as CS's
 * TeamExterminationCheck). `bombTicking` = planted, not yet defused or exploded.
 */
export function checkRoundEnd(r: RoundState, tick: number, counts: TeamCounts, bombTicking: boolean): RoundEnd | null {
  if (isOver(r)) return null;
  if (counts.ctTotal > 0 && counts.ctAlive === 0) return { winner: 'T', reason: 'elimination' };
  if (counts.tTotal > 0 && counts.tAlive === 0 && !bombTicking) return { winner: 'CT', reason: 'elimination' };
  if (!bombTicking && tick >= r.timeoutTick) return { winner: 'CT', reason: 'time' };
  return null;
}

/** The state after the round ends at `tick` (score + 1 for the winner). Throws if it already ended. */
export function endRound(r: RoundState, tick: number, end: RoundEnd): RoundState {
  if (isOver(r)) throw new Error('endRound: the round already ended');
  const score: Score = end.winner === 'CT' ? { ct: r.score.ct + 1, t: r.score.t } : { ct: r.score.ct, t: r.score.t + 1 };
  return { ...r, score, winner: end.winner, reason: end.reason, endTick: tick };
}

export function roundPhase(r: RoundState, bombTicking: boolean): RoundPhase {
  if (isOver(r)) return 'over';
  return bombTicking ? 'planted' : 'live';
}

/** What the round clock needs to know about the bomb. */
export interface BombClock {
  readonly state: 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';
  readonly explodeTick: number | null;
  /** Tick of the defuse (state defused). */
  readonly defusedTick: number | null;
}

/**
 * Seconds left, never negative, 6 decimals:
 * - bomb ticking (planted): the bomb timer, (explodeTick − tick) / 64, also after the round ended;
 * - defused: the bomb timer at the defuse (frozen);
 * - exploded: 0;
 * - otherwise the round clock, roundTimeSec − tick / 64, frozen at the end tick once the round is over.
 */
export function timeLeftSec(r: RoundState, tick: number, bomb: BombClock): number {
  let left: number;
  if (bomb.state === 'exploded') left = 0;
  else if (bomb.state === 'planted' && bomb.explodeTick !== null) left = (bomb.explodeTick - tick) / TICKS_PER_SEC;
  else if (bomb.state === 'defused' && bomb.explodeTick !== null && bomb.defusedTick !== null) left = (bomb.explodeTick - bomb.defusedTick) / TICKS_PER_SEC;
  else left = r.roundTimeSec - Math.min(tick, r.endTick ?? tick) / TICKS_PER_SEC;
  return roundNumber(Math.max(0, left));
}
