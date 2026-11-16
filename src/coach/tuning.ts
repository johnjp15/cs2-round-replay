/**
 * Typed loader for data/coach/tuning.json: every threshold, window and weight of the coach. Code never hard-codes one.
 */
import tuningJson from '../../data/coach/tuning.json';

export interface CoachTuning {
  rounds: {
    /** Rounds in regulation (MR12: 24). Higher round numbers are overtime. */
    regulationRounds: number;
    /** Round numbers that are pistol rounds (1 and the first of the second half). Overtime has none. */
    pistolRounds: number[];
  };
  economy: {
    /**
     * Buy type from the team's equipment value at freeze end divided by its players: below `ecoBelowPerPlayer` is an
     * eco, at or above `fullFromPerPlayer` a full buy, in between a force. Pistol rounds are always `pistol`.
     */
    ecoBelowPerPlayer: number;
    fullFromPerPlayer: number;
  };
  validate: {
    /** A `player_blind` counts as "enemy flashed" on the scoreboard when longer than this (seconds). */
    blindMinSec: number;
  };
  /** The 2D replay's tracks (`src/coach/report/replay.ts`). */
  replay: {
    /** Samples per second (must divide the tick rate). */
    hz: number;
    /** Seconds of freeze time kept before the freeze end (players barely move in it; it costs a fifth of the bytes). */
    freezeLeadSec: number;
    /** Seconds after the round end kept when the round has no official end. */
    postEndSec: number;
    /** Lifetimes used when the demo has no expiry event (seconds). */
    smokeFallbackSec: number;
    fireFallbackSec: number;
    decoyFallbackSec: number;
    /** How long an HE and a flash burst are drawn (seconds). */
    heSec: number;
    flashSec: number;
  };
}

/** Parse and check a tuning object (throws on a missing or non-numeric field). */
export function loadCoachTuning(json: unknown): CoachTuning {
  const t = json as CoachTuning;
  const need = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`coach tuning: bad ${what}`);
  };
  need(typeof t?.rounds?.regulationRounds === 'number', 'rounds.regulationRounds');
  need(Array.isArray(t?.rounds?.pistolRounds), 'rounds.pistolRounds');
  need(typeof t?.economy?.ecoBelowPerPlayer === 'number', 'economy.ecoBelowPerPlayer');
  need(typeof t?.economy?.fullFromPerPlayer === 'number', 'economy.fullFromPerPlayer');
  need(typeof t?.validate?.blindMinSec === 'number', 'validate.blindMinSec');
  for (const k of ['hz', 'freezeLeadSec', 'postEndSec', 'smokeFallbackSec', 'fireFallbackSec', 'decoyFallbackSec', 'heSec', 'flashSec'] as const) {
    need(typeof t?.replay?.[k] === 'number', `replay.${k}`);
  }
  return t;
}

/** The committed tuning. */
export const COACH_TUNING: CoachTuning = loadCoachTuning(tuningJson);
