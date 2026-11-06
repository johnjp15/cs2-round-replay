/**
 * Seeded deterministic PRNG (mulberry32, 32-bit state).
 *
 * The only source of randomness allowed in src/core and src/contracts.
 * All arithmetic is 32-bit unsigned integer math (`>>> 0`, `Math.imul`), so a C#
 * port is a direct transcription using `uint` and `unchecked` multiplication.
 */
export class Rng {
  /** Seed this generator was created with (uint32). Forks derive from it, not from the current state. */
  readonly seed: number;
  /** Current internal state (uint32). */
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) throw new RangeError(`Rng seed must be an integer, got ${seed}`);
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
    z = (z ^ (z + Math.imul(z ^ (z >>> 7), z | 61))) >>> 0;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [0, n). `n` must be a positive integer. */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new RangeError(`nextInt(n) needs a positive integer, got ${n}`);
    return Math.floor(this.next() * n);
  }

  /**
   * Independent child generator keyed by `label`. Depends only on this generator's
   * seed and the label (not on how many numbers have been drawn), so adding draws
   * in one subsystem never shifts another subsystem's stream.
   */
  fork(label: string): Rng {
    return new Rng(mix32((this.seed ^ fnv1a32(label)) >>> 0));
  }
}

/** FNV-1a over UTF-16 code units, uint32. */
function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Final avalanche (murmur3 fmix32) so nearby seeds give unrelated streams. */
function mix32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
