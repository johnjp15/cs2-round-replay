/**
 * Fixed-rate game loop: a 64 Hz accumulator that is independent of the display's frame rate.
 * Pure logic (no requestAnimationFrame, no clock reads): the caller passes the wall time elapsed
 * since the previous frame and the loop runs as many whole ticks as that time covers at the current
 * speed. Leftover time carries to the next frame, so the long-run tick rate is exact.
 *
 * Spiral-of-death guard: at most `maxTicksPerFrame` ticks run per advance(). When a frame would need
 * more (a background tab, a debugger pause, a slow device at 4×), the extra whole ticks are dropped,
 * not queued, and counted in `droppedTicks`; the round then runs slower than real time instead of
 * freezing the page while it catches up.
 */

export const TICK_HZ = 64;
/** Milliseconds per tick (15.625, exact in binary). */
export const TICK_MS = 1000 / TICK_HZ;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
/** Speeds offered by the controls bar. */
export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];
/**
 * Slack (in ticks) when converting owed time to whole ticks, so float error in the running sum
 * (e.g. 127.99999999 ticks after 8 s of 60 fps frames at 0.25×) does not lose a tick.
 */
const TICK_EPSILON = 1e-6;
/** 0.25 s of round time at 1×; enough for 4× down to 16 fps. */
export const DEFAULT_MAX_TICKS_PER_FRAME = 16;

export interface LoopOptions {
  readonly maxTicksPerFrame?: number;
  readonly speed?: number;
  readonly paused?: boolean;
}

export class FixedLoop {
  readonly maxTicksPerFrame: number;
  /** Ticks run since construction. */
  ticksRun = 0;
  /** Whole ticks dropped by the per-frame cap since construction. */
  droppedTicks = 0;
  private readonly step: () => void;
  private speedX = 1;
  private isPaused = false;
  /** Round time (ms) owed but not yet stepped; always < TICK_MS after advance() returns. */
  private acc = 0;

  constructor(step: () => void, options: LoopOptions = {}) {
    const cap = options.maxTicksPerFrame ?? DEFAULT_MAX_TICKS_PER_FRAME;
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`FixedLoop: maxTicksPerFrame must be a positive integer, got ${cap}`);
    this.step = step;
    this.maxTicksPerFrame = cap;
    if (options.speed !== undefined) this.speed = options.speed;
    if (options.paused !== undefined) this.paused = options.paused;
  }

  /** Playback multiplier, clamped to 0.25–4. */
  get speed(): number {
    return this.speedX;
  }

  set speed(x: number) {
    if (!Number.isFinite(x)) throw new RangeError(`FixedLoop: speed must be finite, got ${x}`);
    this.speedX = Math.min(MAX_SPEED, Math.max(MIN_SPEED, x));
  }

  /** While paused, advance() runs nothing and time does not pile up, so resuming never bursts. */
  get paused(): boolean {
    return this.isPaused;
  }

  set paused(p: boolean) {
    this.isPaused = p;
  }

  /** Round time owed but not yet stepped, in ms (for interpolation: `pending / TICK_MS` of a tick). */
  get pending(): number {
    return this.acc;
  }

  /**
   * Account for `elapsedMs` of wall time and run the ticks it covers (capped). Returns the number of
   * ticks run. Non-positive or non-finite elapsed time runs nothing.
   */
  advance(elapsedMs: number): number {
    if (this.isPaused || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
    this.acc += elapsedMs * this.speedX;
    let n = Math.floor(this.acc / TICK_MS + TICK_EPSILON);
    this.acc = Math.max(0, this.acc - n * TICK_MS);
    if (n > this.maxTicksPerFrame) {
      this.droppedTicks += n - this.maxTicksPerFrame;
      n = this.maxTicksPerFrame;
    }
    for (let i = 0; i < n; i++) {
      this.step();
      this.ticksRun++;
    }
    return n;
  }

  /** Forget owed time (after a restart or a long stall). */
  reset(): void {
    this.acc = 0;
  }
}

/**
 * Events per second over a sliding window (frames, ticks). Pure: the caller passes timestamps.
 */
export class RateMeter {
  readonly windowMs: number;
  private readonly times: number[] = [];
  private readonly counts: number[] = [];

  constructor(windowMs = 1000) {
    if (!(windowMs > 0)) throw new RangeError(`RateMeter: windowMs must be positive, got ${windowMs}`);
    this.windowMs = windowMs;
  }

  /** Record `count` events at `nowMs`. */
  add(nowMs: number, count = 1): void {
    this.times.push(nowMs);
    this.counts.push(count);
    this.trim(nowMs);
  }

  /** Events per second over the samples inside the window ending at `nowMs` (0 until two samples exist). */
  rate(nowMs: number): number {
    this.trim(nowMs);
    const first = this.times[0];
    if (this.times.length < 2 || first === undefined) return 0;
    const span = nowMs - first;
    if (span <= 0) return 0;
    let total = 0;
    // The first sample opens the window; its events happened before it.
    for (let i = 1; i < this.counts.length; i++) total += this.counts[i] as number;
    return (total * 1000) / span;
  }

  private trim(nowMs: number): void {
    while (this.times.length > 2 && (this.times[0] as number) < nowMs - this.windowMs) {
      this.times.shift();
      this.counts.shift();
    }
  }
}
