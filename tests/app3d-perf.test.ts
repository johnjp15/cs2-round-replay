/**
 * P1: the 3D page's performance helpers (src/app3d/perf.ts, src/app3d/frame-driver.ts): the per-phase frame probe,
 * the percentiles, the allocation-free rate counter, the display-rate snap, the meter line, the FPS-limit setting and
 * the limiter's pacing.
 */
import { describe, expect, it } from 'vitest';
import { BucketRate, FrameProbe, Ring, dist, displayHz, meterText, percentile } from '../src/app3d/perf';
import { FPS_MAX, FPS_MIN, fpsLimitLabel, paceDelay, parseFpsLimit } from '../src/app3d/frame-driver';

describe('percentiles and rings', () => {
  it('nearest-rank percentiles', () => {
    const a = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([percentile(a, 0.5), percentile(a, 0.95), percentile(a, 0.99), percentile(a, 0)]).toEqual([5, 10, 10, 1]);
    expect(dist([3, 1, 2])).toEqual({ mean: 2, p50: 2, p95: 3, p99: 3, max: 3 });
    expect(dist([]).p50).toBe(0);
  });

  it('a ring keeps the newest values, oldest first', () => {
    const r = new Ring(3);
    for (const v of [1, 2, 3, 4, 5]) r.push(v);
    expect([...r.values()]).toEqual([3, 4, 5]);
    expect(r.median(new Float64Array(3))).toBe(4);
    r.clear();
    expect(r.length).toBe(0);
    expect(() => new Ring(0)).toThrow(RangeError);
  });
});

describe('FrameProbe', () => {
  it('splits each frame into phases and reports ms per tick', () => {
    const p = new FrameProbe(10);
    for (let f = 0; f < 4; f++) {
      const t = f * 10;
      p.begin(t);
      p.mark('input', t + 0.1);
      p.mark('sim', t + 1.1);
      p.mark('scene', t + 1.3);
      p.mark('render', t + 1.8);
      p.mark('hud', t + 2);
      p.end(f % 2 === 0 ? 2 : 0);
    }
    const r = p.report();
    expect(r.frames).toBe(4);
    expect(r.frame.p50).toBeCloseTo(2, 9);
    expect(r.phases.sim.p50).toBeCloseTo(1, 9);
    expect(r.phases.render.p50).toBeCloseTo(0.5, 9);
    expect(r.simPerTick.p50).toBeCloseTo(0.5, 9);
    expect(r.ticks).toBe(4);
    expect(r.fpsEquivalent).toBeCloseTo(500, 6);
    expect(r.interval.p50).toBe(10);
    expect(p.medianFrameMs()).toBeCloseTo(2, 9);
    p.reset();
    expect(p.report().frames).toBe(0);
  });
});

describe('BucketRate', () => {
  it('counts events per second over the last second, without growing', () => {
    const r = new BucketRate(1000);
    // 2000 fps for 3 s.
    for (let t = 0; t < 3000; t += 0.5) r.add(t, 1);
    expect(r.rate(3000)).toBeCloseTo(2000, -1);
    // Nothing for 2 s: back to 0.
    expect(r.rate(5000)).toBe(0);
    // 64 ticks/s in frames of 0 or 1.
    for (let t = 5000; t < 7000; t += 1) r.add(t, t % 15.625 < 1 ? 1 : 0);
    expect(r.rate(7000)).toBeGreaterThan(60);
    expect(r.rate(7000)).toBeLessThan(68);
  });
});

describe('display rate and meter', () => {
  it('snaps the rAF interval to the common refresh rates', () => {
    expect(displayHz(1000 / 120)).toBe(120);
    expect(displayHz(16.9)).toBe(60);
    expect(displayHz(6.95)).toBe(144);
    expect(displayHz(1000 / 85)).toBe(85);
    expect(displayHz(0)).toBe(0);
  });

  it('shows ms, fps-equivalent, the loop rate and limit, and what the display can show', () => {
    expect(meterText(1.6, 2400, 120, 'uncapped')).toBe('1.60 ms · 625 fps-eq · 2400 fps uncapped · display 120 Hz (120 shown)');
    expect(meterText(1.6, 60, 120, 'cap 60')).toBe('1.60 ms · 625 fps-eq · 60 fps cap 60 · display 120 Hz (60 shown)');
    expect(meterText(12.5, 80, 0, 'vsync')).toBe('12.5 ms · 80 fps-eq · 80 fps vsync');
  });
});

describe('FPS limit setting', () => {
  it('parses the menu and storage values; junk is uncapped', () => {
    expect([parseFpsLimit('uncapped'), parseFpsLimit('vsync'), parseFpsLimit('144'), parseFpsLimit(240), parseFpsLimit(237.6)]).toEqual(['uncapped', 'vsync', 144, 240, 238]);
    expect([parseFpsLimit(undefined), parseFpsLimit('fast'), parseFpsLimit(-5), parseFpsLimit(''), parseFpsLimit(null)]).toEqual(['uncapped', 'uncapped', 'uncapped', 'uncapped', 'uncapped']);
    expect([parseFpsLimit(5), parseFpsLimit(5000)]).toEqual([FPS_MIN, FPS_MAX]);
    expect([fpsLimitLabel('uncapped'), fpsLimitLabel(500)]).toEqual(['uncapped', '500 fps cap']);
  });

  it('paces to the limit: waits until due, keeps the schedule, drops debt instead of bursting', () => {
    const iv = 1000 / 120;
    expect(paceDelay(100, 95, iv)).toEqual({ run: false, ms: 5, nextDue: 100 });
    // On time (or a little late): the next one is a whole interval after the due time, not after now.
    expect(paceDelay(100, 101, iv)).toEqual({ run: true, ms: 0, nextDue: 100 + iv });
    // More than an interval late: restart from now.
    expect(paceDelay(100, 130, iv)).toEqual({ run: true, ms: 0, nextDue: 130 + iv });
    // Simulated: frames that take 1 ms on a 240 fps cap run 240 times a second.
    let due = 0;
    let frames = 0;
    for (let now = 0; now < 1000; ) {
      const p = paceDelay(due, now, 1000 / 240);
      if (p.run) {
        frames++;
        due = p.nextDue;
        now += 1;
      } else now += p.ms;
    }
    expect(frames).toBeGreaterThanOrEqual(239);
    expect(frames).toBeLessThanOrEqual(241);
  });
});
