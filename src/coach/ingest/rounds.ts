/**
 * Round segmentation: the flow events of a RawDemo → round segments (start, freeze end, end, official end, result).
 *
 * Rules (each pinned by a test in tests/coach/rounds.test.ts):
 * - Only events at or after the live start (`liveRange`) count, so warmup rounds and anything before the last
 *   `begin_new_match` (a knife round before the match, an earlier restart) are gone.
 * - A round starts at the live start or at a `round_start`; it ends at its first `round_end`.
 * - A `round_start` that arrives while the current round has a freeze end but no end means the round was restarted
 *   (mp_restartgame, a technical pause that resets the round): the unfinished round is dropped and noted.
 * - `round_officially_ended` belongs to the latest ended round that has none yet (it shares a tick with the next
 *   `round_start`, so event order within a tick does not matter).
 * - A round with an end but no freeze end (a surrender vote passed during freeze time) is kept as not played.
 * - A round the demo cuts off (no end) is kept as not played, with no winner, ending at the last row.
 */
import { liveRange } from '../model/raw';
import type { RawRoundEvent } from '../model/raw';

export interface RoundSegment {
  startTick: number;
  freezeEndTick: number | null;
  endTick: number | null;
  officialEndTick: number | null;
  /** total_rounds_played at the start. */
  roundsPlayedAtStart: number;
  /** Winning team number (2/3) or 0. */
  winnerTeamNum: number;
  reason: number;
  message: string;
}

export interface Segmentation {
  segments: RoundSegment[];
  liveStart: number;
  liveEnd: number;
  hasMatchStart: boolean;
  notes: string[];
}

export function segmentRounds(events: readonly RawRoundEvent[], firstTick: number, lastTick: number, roundsPlayedAtFirstRow: number): Segmentation {
  const range = liveRange(events, firstTick, lastTick);
  const notes: string[] = [];
  const segments: RoundSegment[] = [];
  const hasMatchStart = events.some((e) => e.kind === 'match_start');
  const fresh = (tick: number, rp: number): RoundSegment => ({
    startTick: tick, freezeEndTick: null, endTick: null, officialEndTick: null, roundsPlayedAtStart: rp,
    winnerTeamNum: 0, reason: 0, message: '',
  });
  let cur = fresh(range.start, hasMatchStart ? 0 : roundsPlayedAtFirstRow);
  const live = events.filter((e) => e.tick >= range.start && !e.warmup);
  for (const e of live) {
    switch (e.kind) {
      case 'start':
        if (cur.endTick !== null) {
          segments.push(cur);
          cur = fresh(e.tick, e.roundsPlayed);
        } else if (cur.freezeEndTick !== null) {
          notes.push(`round starting at tick ${cur.startTick} was restarted at tick ${e.tick} before it ended; dropped`);
          cur = fresh(e.tick, e.roundsPlayed);
        } else {
          // Still in freeze time (or the live start itself): this start is the real start of the same round.
          cur.startTick = Math.max(cur.startTick, e.tick);
          cur.roundsPlayedAtStart = e.roundsPlayed;
        }
        break;
      case 'freeze_end':
        if (cur.endTick === null && cur.freezeEndTick === null) cur.freezeEndTick = e.tick;
        break;
      case 'end':
        if (cur.endTick === null) {
          cur.endTick = e.tick;
          cur.winnerTeamNum = e.winner;
          cur.reason = e.reason;
          cur.message = e.message;
        }
        break;
      case 'officially_ended': {
        const target = cur.endTick !== null && cur.officialEndTick === null ? cur : [...segments].reverse().find((s) => s.officialEndTick === null);
        if (target && target.endTick !== null && e.tick >= target.endTick) target.officialEndTick = e.tick;
        break;
      }
      default:
        break;
    }
  }
  if (cur.endTick !== null || cur.freezeEndTick !== null) {
    if (cur.endTick === null) notes.push(`last round (started at tick ${cur.startTick}) has no end: the demo stops mid-round`);
    segments.push(cur);
  }
  return { segments, liveStart: range.start, liveEnd: range.end, hasMatchStart, notes };
}
