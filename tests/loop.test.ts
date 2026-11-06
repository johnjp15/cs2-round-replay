import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_TICKS_PER_FRAME, FixedLoop, RateMeter, TICK_MS } from '../src/app/loop';

/** Deterministic frame times (ms) between 8 and 34: a jittery display without Math.random. */
function jitteryFrames(): () => number {
  let s = 12345;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return 8 + (s / 2147483648) * 26;
  };
}

/** Run frames for `seconds` of wall time; returns the ticks run in each wall second. */
function ticksPerWallSecond(loop: FixedLoop, seconds: number, frame: () => number): number[] {
  const perSecond: number[] = [];
  const before = loop.ticksRun;
  let wall = 0;
  let counted = 0;
  for (let sec = 1; sec <= seconds; sec++) {
    let ticks = 0;
    while (wall < sec * 1000) {
      const dt = Math.min(frame(), sec * 1000 - wall);
      wall += dt;
      ticks += loop.advance(dt);
    }
    perSecond.push(ticks);
    counted += ticks;
  }
  expect(counted).toBe(loop.ticksRun - before);
  return perSecond;
}

function counter(): { loop: FixedLoop; steps: () => number } {
  let n = 0;
  const loop = new FixedLoop(() => {
    n++;
  });
  return { loop, steps: () => n };
}

describe('FixedLoop', () => {
  it('runs 64 ticks per second (±1) at 1× on a 60 fps display, exactly 640 in 10 s', () => {
    const { loop, steps } = counter();
    const perSecond = ticksPerWallSecond(loop, 10, () => 1000 / 60);
    for (const n of perSecond) expect(Math.abs(n - 64)).toBeLessThanOrEqual(1);
    expect(steps()).toBe(640);
    expect(loop.droppedTicks).toBe(0);
  });

  it('runs 64 ticks per second (±1) at 1× on a jittery 30–120 fps display', () => {
    const { loop } = counter();
    const perSecond = ticksPerWallSecond(loop, 10, jitteryFrames());
    for (const n of perSecond) expect(Math.abs(n - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(loop.ticksRun - 640)).toBeLessThanOrEqual(1);
  });

  it('runs 64 ticks per simulated second (±1) at 4×: 256 per wall second', () => {
    const { loop } = counter();
    loop.speed = 4;
    for (const frame of [() => 1000 / 60, () => 1000 / 144, jitteryFrames()]) {
      const before = loop.ticksRun;
      const perSecond = ticksPerWallSecond(loop, 5, frame);
      // One wall second at 4x is four simulated seconds.
      for (const n of perSecond) expect(Math.abs(n / 4 - 64)).toBeLessThanOrEqual(1);
      expect(Math.abs(loop.ticksRun - before - 5 * 256)).toBeLessThanOrEqual(1);
    }
    expect(loop.droppedTicks).toBe(0);
  });

  it('runs 16 ticks per wall second at 0.25×', () => {
    const { loop } = counter();
    loop.speed = 0.25;
    const perSecond = ticksPerWallSecond(loop, 8, () => 1000 / 60);
    for (const n of perSecond) expect(Math.abs(n - 16)).toBeLessThanOrEqual(1);
    expect(loop.ticksRun).toBe(128);
  });

  it('caps ticks per frame and drops the backlog (no spiral of death after a tab switch)', () => {
    const { loop, steps } = counter();
    expect(loop.maxTicksPerFrame).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
    // 5 s away: 320 ticks owed, 16 run, the rest dropped.
    expect(loop.advance(5000)).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
    expect(loop.droppedTicks).toBe(320 - DEFAULT_MAX_TICKS_PER_FRAME);
    expect(loop.pending).toBeLessThan(TICK_MS);
    // The next normal frame runs a normal number of ticks.
    expect(loop.advance(1000 / 60)).toBe(1);
    expect(steps()).toBe(DEFAULT_MAX_TICKS_PER_FRAME + 1);

    const small = new FixedLoop(() => undefined, { maxTicksPerFrame: 3, speed: 4 });
    expect(small.advance(1000)).toBe(3);
    expect(small.droppedTicks).toBe(256 - 3);
    expect(() => new FixedLoop(() => undefined, { maxTicksPerFrame: 0 })).toThrow(RangeError);
  });

  it('runs nothing while paused, and does not burst on resume', () => {
    const { loop, steps } = counter();
    loop.advance(100);
    const before = steps();
    loop.paused = true;
    for (let i = 0; i < 120; i++) expect(loop.advance(1000 / 60)).toBe(0);
    expect(loop.advance(10_000)).toBe(0);
    expect(steps()).toBe(before);
    expect(loop.droppedTicks).toBe(0);
    loop.paused = false;
    expect(loop.advance(1000 / 60)).toBeLessThanOrEqual(2);
    expect(loop.droppedTicks).toBe(0);
  });

  it('clamps speed to 0.25–4 and ignores bad elapsed times', () => {
    const { loop } = counter();
    loop.speed = 10;
    expect(loop.speed).toBe(4);
    loop.speed = 0.01;
    expect(loop.speed).toBe(0.25);
    expect(() => {
      loop.speed = Number.NaN;
    }).toThrow(RangeError);
    expect(loop.advance(-5)).toBe(0);
    expect(loop.advance(Number.NaN)).toBe(0);
    expect(loop.advance(Number.POSITIVE_INFINITY)).toBe(0);
    expect(loop.ticksRun).toBe(0);
  });

  it('carries sub-tick time between frames and reset() forgets it', () => {
    const { loop } = counter();
    expect(loop.advance(10)).toBe(0);
    expect(loop.advance(10)).toBe(1);
    expect(loop.pending).toBeCloseTo(20 - TICK_MS, 9);
    loop.reset();
    expect(loop.pending).toBe(0);
    expect(loop.advance(10)).toBe(0);
  });
});

describe('RateMeter', () => {
  it('measures events per second over a sliding window', () => {
    const m = new RateMeter(1000);
    let t = 0;
    for (let i = 0; i < 180; i++) {
      t += 1000 / 60;
      m.add(t, 4);
    }
    expect(m.rate(t)).toBeCloseTo(240, 0);
    expect(new RateMeter().rate(0)).toBe(0);
  });
});
