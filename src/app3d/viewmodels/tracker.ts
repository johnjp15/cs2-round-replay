/**
 * A1: the first-person weapon's animation state, from the weapon state machine tick by tick (pure; tested in Node).
 * The host's per-pawn weapon state (sim2d `WeaponState`: `deployEndTick`, `reloadEndTick`, `grenadePrimed`, kept by
 * Sim3DHost) gives the real timings: a deploy runs from the switch to `deployEndTick`, a reload from the tick
 * `reloadEndTick` appears to that tick. Shots come from the host's `shot` events. Converted to seconds at the frame's
 * render tick (fractional), so the animation is smooth and `test.render()` is exact.
 */
import type { PawnObs } from '../../contracts/index';
import type { VmAnim } from './pose';

const TICKS_PER_SEC = 64;
const NEVER = -1e9;

/** The fields of the host's weapon state the viewmodel uses (read structurally). */
export interface ArmsTimers {
  readonly deployEndTick: number;
  readonly reloadEndTick: number | null;
  readonly grenadePrimed: boolean;
}

/** Read the timers from whatever weapon state the host keeps (sim2d WeaponState; H2's ArmsState has `reload.endTick`). */
export function readTimers(wpn: unknown): ArmsTimers | null {
  if (wpn === null || typeof wpn !== 'object') return null;
  const w = wpn as Record<string, unknown>;
  const deployEndTick = typeof w['deployEndTick'] === 'number' ? w['deployEndTick'] : 0;
  let reloadEndTick: number | null = null;
  if (typeof w['reloadEndTick'] === 'number') reloadEndTick = w['reloadEndTick'];
  else if (w['reload'] !== null && typeof w['reload'] === 'object' && typeof (w['reload'] as Record<string, unknown>)['endTick'] === 'number') reloadEndTick = (w['reload'] as Record<string, number>)['endTick'] as number;
  return { deployEndTick, reloadEndTick, grenadePrimed: w['grenadePrimed'] === true };
}

export class VmTracker {
  weapon: string | null = null;
  private deployStart = NEVER;
  private deployEnd = NEVER;
  private reloadStart = NEVER;
  private reloadEnd: number | null = null;
  private lastShot = NEVER;
  private swingTick = NEVER;
  private plantTick: number | null = null;
  private primed = false;
  private thrownTick = NEVER;
  private lastTick: number | null = null;

  reset(): void {
    this.weapon = null;
    this.deployStart = NEVER;
    this.deployEnd = NEVER;
    this.reloadStart = NEVER;
    this.reloadEnd = null;
    this.lastShot = NEVER;
    this.swingTick = NEVER;
    this.plantTick = null;
    this.primed = false;
    this.thrownTick = NEVER;
    this.lastTick = null;
  }

  /** One observed tick of the pawn in first person. Returns what started this tick (for local sounds). */
  ingest(tick: number, pawn: PawnObs, timers: ArmsTimers | null, shot: boolean, thrown: boolean): { primed: boolean } {
    if (this.lastTick !== null && (tick <= this.lastTick || tick > this.lastTick + 8)) this.reset();
    const first = this.lastTick === null;
    this.lastTick = tick;
    let primedNow = false;
    // What the host reports at observe tick k happened while it simulated tick k − 1.
    const at = tick - 1;
    if (this.weapon !== pawn.weapon) {
      this.weapon = pawn.weapon;
      this.deployStart = first ? NEVER : at;
      this.deployEnd = timers?.deployEndTick ?? tick;
      this.reloadEnd = null;
      this.primed = false;
      this.thrownTick = NEVER;
    } else if (timers !== null && timers.deployEndTick > this.deployEnd + 1e-6 && timers.deployEndTick > tick) {
      // Re-deployed (the same weapon taken out again).
      this.deployStart = at;
      this.deployEnd = timers.deployEndTick;
    }
    if (timers !== null) {
      if (timers.reloadEndTick !== null && this.reloadEnd !== timers.reloadEndTick) {
        this.reloadStart = at;
        this.reloadEnd = timers.reloadEndTick;
      } else if (timers.reloadEndTick === null && this.reloadEnd !== null && tick < this.reloadEnd) {
        this.reloadEnd = null;
      }
      if (timers.grenadePrimed && !this.primed) primedNow = true;
      this.primed = timers.grenadePrimed;
    }
    if (shot) this.lastShot = at;
    if (thrown) this.thrownTick = at;
    return { primed: primedNow };
  }

  swing(tick: number): void {
    this.swingTick = tick;
  }

  /** Seconds since the last swing at `tick` (rate limit). */
  sinceSwing(tick: number): number {
    return (tick - this.swingTick) / TICKS_PER_SEC;
  }

  plant(tick: number | null): void {
    if (tick === null) this.plantTick = null;
    else this.plantTick ??= tick;
  }

  /** The animation input at render tick `rt` (fractional). */
  anim(rt: number, cycleSec: number, speed: number, timeSec: number): VmAnim | null {
    if (this.weapon === null) return null;
    const s = (a: number): number => (rt - a) / TICKS_PER_SEC;
    const deploy = this.deployStart > NEVER && rt < this.deployEnd ? { t: s(this.deployStart), dur: (this.deployEnd - this.deployStart) / TICKS_PER_SEC } : null;
    const reload = this.reloadEnd !== null && rt < this.reloadEnd ? { t: Math.max(0, s(this.reloadStart)), dur: (this.reloadEnd - this.reloadStart) / TICKS_PER_SEC } : null;
    return {
      weapon: this.weapon,
      sinceShot: this.lastShot > NEVER ? Math.max(0, s(this.lastShot)) : 1e6,
      cycle: cycleSec,
      reload,
      deploy,
      swing: this.swingTick > NEVER && s(this.swingTick) < 1 ? Math.max(0, s(this.swingTick)) : null,
      plant: this.plantTick === null ? null : Math.max(0, s(this.plantTick)),
      primed: this.primed,
      thrown: this.thrownTick > NEVER && s(this.thrownTick) < 1 ? Math.max(0, s(this.thrownTick)) : null,
      speed,
      time: timeSec,
    };
  }
}
