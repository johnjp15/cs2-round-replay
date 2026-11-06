/**
 * Round clock and bomb timer, in integer ticks (64 per second). Replay t = 0 is
 * 1:39 on the HUD (98.25 s left). See docs/core.md "Clock".
 */
import { TICKS_PER_SEC, type RoundData } from '../contracts/index';

export const TICK_RATE = TICKS_PER_SEC;

/** Video seconds -> tick (`Math.round`, half up; C#: `Math.Floor(t * 64 + 0.5)`). */
export function tickOf(t: number): number {
  return Math.round(t * TICK_RATE);
}

/** Tick -> video seconds (exact: a division by a power of two). */
export function tOf(tick: number): number {
  return tick / TICK_RATE;
}

export class RoundClock {
  /** Seconds on the round clock at tick 0. */
  readonly clock0: number;
  /** Bomb timer length in seconds. */
  readonly bombTimerSec: number;

  constructor(clock0: number, bombTimerSec: number) {
    this.clock0 = clock0;
    this.bombTimerSec = bombTimerSec;
  }

  static fromRound(round: RoundData): RoundClock {
    return new RoundClock(round.meta.clock0, round.meta.bombTimerSec);
  }

  /** Seconds left on the round clock (negative once it has run out). */
  remaining(tick: number): number {
    return this.clock0 - tOf(tick);
  }

  /** HUD round clock "m:ss": the remaining seconds rounded up, never below 0:00. */
  hudClock(tick: number): string {
    const secs = Math.max(0, Math.ceil(this.remaining(tick)));
    const m = Math.floor(secs / 60);
    const s = secs - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  /** Seconds left on the bomb planted at `plantTick` (negative after it would have exploded). */
  bombRemaining(tick: number, plantTick: number): number {
    return this.bombTimerSec - (tOf(tick) - tOf(plantTick));
  }

  /** HUD bomb timer "s.d": the remaining seconds rounded to 0.1 (half up), never below 0.0. */
  hudBomb(tick: number, plantTick: number): string {
    const tenths = Math.max(0, Math.round(this.bombRemaining(tick, plantTick) * 10));
    const whole = Math.floor(tenths / 10);
    return `${whole}.${tenths - whole * 10}`;
  }

  /** Tick at which the bomb planted at `plantTick` explodes. */
  bombExplodeTick(plantTick: number): number {
    return plantTick + Math.round(this.bombTimerSec * TICK_RATE);
  }
}
