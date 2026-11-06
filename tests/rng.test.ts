import { describe, expect, it } from 'vitest';
import { Rng } from '../src/contracts/rng';

describe('Rng', () => {
  it('yields a fixed sequence for a fixed seed', () => {
    const rng = new Rng(12345);
    const seq = Array.from({ length: 5 }, () => rng.next());
    // Golden values for mulberry32(12345). If these change, every recorded log changes too.
    expect(seq).toEqual(GOLDEN_12345);
  });

  it('is reproducible across instances and stays in [0, 1)', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 10000; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('nextInt(n) stays in [0, n) and is deterministic', () => {
    const a = new Rng(7);
    const ints = Array.from({ length: 1000 }, () => a.nextInt(10));
    expect(ints.every((v) => Number.isInteger(v) && v >= 0 && v < 10)).toBe(true);
    expect(new Set(ints).size).toBe(10);
    const b = new Rng(7);
    expect(Array.from({ length: 1000 }, () => b.nextInt(10))).toEqual(ints);
    expect(() => a.nextInt(0)).toThrow(RangeError);
    expect(() => a.nextInt(2.5)).toThrow(RangeError);
  });

  it('fork(label) is deterministic, label-dependent and independent of parent draws', () => {
    const parent = new Rng(99);
    const f1 = parent.fork('bots').next();
    parent.next();
    parent.next();
    expect(parent.fork('bots').next()).toBe(f1);
    expect(new Rng(99).fork('bots').next()).toBe(f1);
    expect(parent.fork('aim').next()).not.toBe(f1);
    expect(new Rng(100).fork('bots').next()).not.toBe(f1);
  });
});

const GOLDEN_12345 = [0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203, 0.5094283693470061];
