/**
 * End-of-round summary types (B5). `summarize(model, log)` in src/core/summary.ts builds a `RoundSummary` from the
 * round data and a SessionLog: the result against the recording, a kill-by-kill comparison, the LIVE switches, one
 * player's stats and the bomb margin. Plain readonly data, no optional fields (absent = null), like the rest of the
 * contracts, so the C# port and the app's overlay read the same shape.
 */
import type { PlayerId, RoundEndReason, Score, Team, WeaponId } from './types';

/**
 * How a kill of the recording fared in this run, or a kill the recording doesn't have:
 * - `same`: the same killer killed the same victim within `SummaryOptions.sameTicks` of the recorded tick;
 * - `shifted`: the same killer and victim, earlier or later (`deltaTicks`);
 * - `missed`: it didn't happen (the victim survived, or someone else killed him: that death is a `new` row);
 * - `pending`: not yet: the log ends before its recorded tick (+ `sameTicks`) with killer and victim alive (the
 *   overlay opens 2 s after the round end, before the 69.4 s post-round kill);
 * - `new`: a death the recording doesn't have (`killer` null = the world: the bomb, fire without a thrower).
 */
export type KillStatus = 'same' | 'shifted' | 'missed' | 'pending' | 'new';

export const KILL_STATUSES = ['same', 'shifted', 'missed', 'pending', 'new'] as const;

export interface KillRow {
  readonly status: KillStatus;
  readonly killer: PlayerId | null;
  readonly victim: PlayerId;
  readonly weapon: WeaponId | null;
  readonly headshot: boolean;
  /** Recorded kill-feed tick; null for a new kill. */
  readonly recordedTick: number | null;
  /** Tick of the `death` event in this run; null when it didn't happen. */
  readonly runTick: number | null;
  /** runTick − recordedTick when both exist, else null. */
  readonly deltaTicks: number | null;
  /** The recorded kill came after the round end (sp4rtan's kill of cart at 69.4 s). */
  readonly postRound: boolean;
  /** Short text for the table: `same`, `+0.30 s`, `didn't happen: donk survived`, `new`. */
  readonly text: string;
}

/** One switch to LIVE (B4): who, when, the trigger (`status.trigger`) and the Core's reason text. */
export interface SwitchRow {
  readonly id: PlayerId;
  readonly tick: number;
  readonly trigger: string | null;
  /** From the Core's `<id> LIVE: <reason>; goal …` log line; '' if there was none. */
  readonly reason: string;
}

export interface RoundResult {
  /** null while the round is on (no `round_end` yet). */
  readonly winner: Team | null;
  readonly reason: RoundEndReason | null;
  /** Observe tick of the `round_end` event (the recording: the kill-feed / bomb tick). */
  readonly endTick: number | null;
  /** Score after the round (or now, while it is on). */
  readonly score: Score;
}

export interface BombSummary {
  readonly plantTick: number | null;
  readonly defuseTick: number | null;
  readonly explodeTick: number | null;
  /**
   * Seconds left on the bomb timer at the defuse (the recording: 0.72). Negative: the bomb exploded during a defuse
   * that needed that much longer. null: no defuse (or no plant).
   */
  readonly marginSec: number | null;
}

export interface PlayerStats {
  readonly id: PlayerId;
  /** The run's human played this pawn (else it is the default human, watched). */
  readonly human: boolean;
  readonly kills: number;
  /** HP removed from other pawns (`damage` events with this attacker; self-damage not counted). */
  readonly damageDealt: number;
  /** HP removed from this pawn, by anyone (the world and self included). */
  readonly damageTaken: number;
  /** Seconds alive in the log (ticks observed alive / 64). */
  readonly aliveSec: number;
  /** Tick of this pawn's `death` event, or null. */
  readonly deathTick: number | null;
  /** RMS 2D distance (units) from the recorded track, over the ticks alive with a recorded position; null if none. */
  readonly rmsFromRecording: number | null;
  /** Ticks that RMS is over. */
  readonly rmsTicks: number;
}

/**
 * - `tape`: the recorded result, and every recorded kill `same` (or still `pending`), nothing new;
 * - `same_result`: the recorded winner and reason, but kills differ;
 * - `changed`: another winner or reason;
 * - `unfinished`: no round end in the log yet.
 */
export type SummaryVerdict = 'tape' | 'same_result' | 'changed' | 'unfinished';

export interface RoundSummary {
  /** One line: "Played it like the tape: CT defuse, 0.72 s left", "You changed history: Ts win by elimination (recorded: CT defuse)". */
  readonly headline: string;
  readonly verdict: SummaryVerdict;
  readonly result: RoundResult;
  readonly recorded: RoundResult;
  readonly bomb: BombSummary;
  readonly recordedBomb: BombSummary;
  /** Recorded kills and new deaths, by time (recorded tick, else run tick). */
  readonly kills: readonly KillRow[];
  readonly switches: readonly SwitchRow[];
  readonly player: PlayerStats;
  /** Log lines summarized and the last observe tick. */
  readonly ticks: number;
  readonly lastTick: number;
}
