/**
 * P1: per-frame main-thread cost of the 3D page, by phase (docs/app3d.md "Performance"). Pure (no DOM, no Three.js;
 * tests/app3d-perf.test.ts): the page passes `performance.now()` readings, nothing here reads a clock or allocates
 * per frame (fixed Float64Array rings).
 *
 * Phases of one frame, in order: `input` (mouse and keys → the view and the human's input), `sim` (the 64 Hz ticks
 * this frame owes, including the Scene ingest), `scene` (camera, interpolated pawns, tracers, effects into the
 * renderer's objects), `render` (Three.js render calls: culling, sorting, uniforms, draw calls; CPU side only, the
 * GPU runs asynchronously), `hud` (DOM text and the minimap). `frame` is their sum: the main-thread time the page
 * itself needs per frame (the browser's own work, compositing and the GPU are not in it). The "fps-equivalent" is
 * 1000 / frame ms: the frame rate the page's main thread could sustain if the display did not cap it.
 */

export const PHASES = ['input', 'sim', 'scene', 'render', 'hud'] as const;
export type Phase = (typeof PHASES)[number];

/** Percentiles of a sample (ms). */
export interface Dist {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Percentile `q` (0..1) of a sorted array: the nearest-rank value. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] as number;
}

export function dist(values: ArrayLike<number>): Dist {
  const a = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of a) sum += v;
  return { mean: a.length === 0 ? 0 : sum / a.length, p50: percentile(a, 0.5), p95: percentile(a, 0.95), p99: percentile(a, 0.99), max: a.length === 0 ? 0 : (a[a.length - 1] as number) };
}

/** A fixed-size ring of numbers (no allocation after construction). */
export class Ring {
  readonly size: number;
  private readonly buf: Float64Array;
  private n = 0;
  private head = 0;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError(`Ring: size must be a positive integer, got ${size}`);
    this.size = size;
    this.buf = new Float64Array(size);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.n < this.size) this.n++;
  }

  get length(): number {
    return this.n;
  }

  /** The values, oldest first (allocates: for reports, not the hot path). */
  values(): Float64Array {
    const out = new Float64Array(this.n);
    const start = (this.head - this.n + this.size) % this.size;
    for (let i = 0; i < this.n; i++) out[i] = this.buf[(start + i) % this.size] as number;
    return out;
  }

  /** Median of the stored values into `scratch` (length ≥ size; no allocation). */
  median(scratch: Float64Array): number {
    if (this.n === 0) return 0;
    const s = scratch.subarray(0, this.n);
    s.set(this.n === this.size ? this.buf : this.buf.subarray(0, this.n));
    s.sort();
    return percentile(s, 0.5);
  }

  clear(): void {
    this.n = 0;
    this.head = 0;
  }
}

/** One frame's readings. */
export interface FrameSample {
  readonly input: number;
  readonly sim: number;
  readonly scene: number;
  readonly render: number;
  readonly hud: number;
  readonly ticks: number;
}

export interface PerfReport {
  readonly frames: number;
  readonly frame: Dist;
  readonly phases: { readonly [K in Phase]: Dist };
  /** Main-thread ms per sim tick over the frames that ran ticks (sim phase ms / ticks). */
  readonly simPerTick: Dist;
  readonly ticks: number;
  /** 1000 / frame p50: the frame rate the main thread could sustain. */
  readonly fpsEquivalent: number;
  /** Wall time between frame starts (ms): the presented frame interval with rAF, the loop's own rate uncapped. */
  readonly interval: Dist;
}

/**
 * Phase timings of the last `size` frames. The page calls `begin(now)`, then `mark(phase, now)` at the end of each
 * phase in order, then `end(ticks)`.
 */
export class FrameProbe {
  readonly size: number;
  private readonly rings: { readonly [K in Phase | 'frame' | 'interval' | 'ticks']: Ring };
  private readonly scratch: Float64Array;
  private t = 0;
  private lastStart: number | null = null;
  private cur = { input: 0, sim: 0, scene: 0, render: 0, hud: 0 };
  frames = 0;

  constructor(size = 600) {
    this.size = size;
    this.rings = { input: new Ring(size), sim: new Ring(size), scene: new Ring(size), render: new Ring(size), hud: new Ring(size), frame: new Ring(size), interval: new Ring(size), ticks: new Ring(size) };
    this.scratch = new Float64Array(size);
  }

  begin(now: number): void {
    if (this.lastStart !== null) this.rings.interval.push(now - this.lastStart);
    this.lastStart = now;
    this.t = now;
    this.cur.input = this.cur.sim = this.cur.scene = this.cur.render = this.cur.hud = 0;
  }

  /** The phase that just ended at `now` (phases not marked count 0). */
  mark(phase: Phase, now: number): void {
    this.cur[phase] += now - this.t;
    this.t = now;
  }

  end(ticks: number): void {
    const c = this.cur;
    this.rings.input.push(c.input);
    this.rings.sim.push(c.sim);
    this.rings.scene.push(c.scene);
    this.rings.render.push(c.render);
    this.rings.hud.push(c.hud);
    this.rings.frame.push(c.input + c.sim + c.scene + c.render + c.hud);
    this.rings.ticks.push(ticks);
    this.frames++;
  }

  /** The last frame's readings. */
  last(): FrameSample {
    return { ...this.cur, ticks: 0 };
  }

  /** Median frame ms over the stored frames (no allocation: for the HUD meter). */
  medianFrameMs(): number {
    return this.rings.frame.median(this.scratch);
  }

  /** Median wall interval between frames (ms). */
  medianIntervalMs(): number {
    return this.rings.interval.median(this.scratch);
  }

  /** Forget the stored frames (a bench starts a new sample). */
  reset(): void {
    for (const r of Object.values(this.rings)) r.clear();
    this.lastStart = null;
    this.frames = 0;
  }

  report(): PerfReport {
    const r = this.rings;
    const frame = dist(r.frame.values());
    const sim = r.sim.values();
    const ticks = r.ticks.values();
    const perTick: number[] = [];
    let total = 0;
    for (let i = 0; i < ticks.length; i++) {
      const n = ticks[i] as number;
      total += n;
      if (n > 0) perTick.push((sim[i] as number) / n);
    }
    return {
      frames: r.frame.length,
      frame,
      phases: { input: dist(r.input.values()), sim: dist(sim), scene: dist(r.scene.values()), render: dist(r.render.values()), hud: dist(r.hud.values()) },
      simPerTick: dist(perTick),
      ticks: total,
      fpsEquivalent: frame.p50 > 0 ? 1000 / frame.p50 : 0,
      interval: dist(r.interval.values()),
    };
  }
}

/** The display's refresh rate from the median rAF interval (ms), snapped to the common rates. */
export function displayHz(medianIntervalMs: number): number {
  if (!(medianIntervalMs > 0)) return 0;
  const hz = 1000 / medianIntervalMs;
  const common = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 360, 480, 500];
  let best = hz;
  let err = Infinity;
  for (const c of common) {
    const e = Math.abs(c - hz) / c;
    if (e < err) {
      err = e;
      best = c;
    }
  }
  return err < 0.04 ? best : Math.round(hz);
}

/**
 * The HUD's headroom meter: "1.60 ms · 625 fps-eq · 2400 fps uncapped · display 120 Hz (120 shown)". The main-thread
 * ms per frame (median) and its fps-equivalent (what the page could sustain), the rate the loop runs at and its
 * limit, the display's refresh and the frames it can actually show (min of the two: the vsync cap made visible).
 */
export function meterText(frameMs: number, loopFps: number, hz: number, limit: string): string {
  const eq = frameMs > 0 ? Math.min(99999, Math.round(1000 / frameMs)) : 0;
  const ms = frameMs < 10 ? frameMs.toFixed(2) : frameMs.toFixed(1);
  const shown = hz > 0 ? Math.min(loopFps, hz) : loopFps;
  return `${ms} ms · ${eq} fps-eq · ${loopFps.toFixed(0)} fps ${limit}${hz > 0 ? ` · display ${hz} Hz (${shown.toFixed(0)} shown)` : ''}`;
}

/**
 * Events per second over the last ~1 s in 10 fixed buckets (no allocation, O(1) per add: the page adds every frame,
 * and at thousands of frames per second src/app/loop.ts RateMeter's arrays would grow and shift).
 */
export class BucketRate {
  private readonly buckets = new Float64Array(10);
  private readonly bucketMs: number;
  /** Index (in buckets since the epoch) of the current bucket, or null before the first reading. */
  private cur: number | null = null;

  constructor(windowMs = 1000) {
    this.bucketMs = windowMs / 10;
  }

  add(nowMs: number, count = 1): void {
    const c = this.roll(nowMs);
    this.buckets[c % 10] = (this.buckets[c % 10] as number) + count;
  }

  /** Events per second over the 9 complete buckets before the current one. */
  rate(nowMs: number): number {
    const c = this.roll(nowMs);
    let sum = 0;
    for (let i = 1; i < 10; i++) sum += this.buckets[(c - i) % 10] as number;
    return (sum * 1000) / (9 * this.bucketMs);
  }

  private roll(nowMs: number): number {
    const b = Math.floor(nowMs / this.bucketMs) + 10;
    if (this.cur === null) this.cur = b;
    // Clear the buckets entered since the last call (at most all ten).
    for (let k = this.cur + 1; k <= b && k <= this.cur + 10; k++) this.buckets[k % 10] = 0;
    if (b > this.cur) this.cur = b;
    return this.cur;
  }
}
