/**
 * Valve's `CUniformRandomStream` (vstdlib): the Park–Miller "minimal standard" generator with a 32-entry Bays–Durham
 * shuffle, i.e. Numerical Recipes in C (2nd ed., §7.1) `ran1`. The class layout (`m_idum`, `m_iy`, `m_iv[NTAB]`,
 * NTAB 32) is in the public Source SDK 2013 header `src/public/vstdlib/random.h`. CS uses it to expand a weapon's
 * `m_nRecoilSeed` into its recoil table (recoil.ts).
 *
 * Integer arithmetic only (every product stays below 2^53, so doubles are exact); `randomFloat` rounds to float32
 * like the C++ `float`. Deterministic, no state outside the instance. This is a data generator, not the game's
 * per-shot RNG: per-shot randomness comes from the Core's seeded `Rng` (contracts/rng.ts).
 */
const NTAB = 32;
const IA = 16807;
const IM = 2147483647;
const IQ = 127773;
const IR = 2836;
const NDIV = 1 + Math.floor((IM - 1) / NTAB);
const AM = 1 / IM;
const RNMX = 1 - 1.2e-7;

export class ValveUniformRandom {
  private idum: number;
  private iy = 0;
  private readonly iv: number[] = new Array<number>(NTAB).fill(0);

  constructor(seed: number) {
    if (!Number.isInteger(seed)) throw new RangeError(`ValveUniformRandom seed must be an integer, got ${seed}`);
    this.idum = seed < 0 ? seed : -seed;
  }

  /** Next integer in [1, 2^31 − 2]. */
  next(): number {
    if (this.idum <= 0 || this.iy === 0) {
      this.idum = -this.idum < 1 ? 1 : -this.idum;
      for (let j = NTAB + 7; j >= 0; j--) {
        this.idum = step(this.idum);
        if (j < NTAB) this.iv[j] = this.idum;
      }
      this.iy = this.iv[0] as number;
    }
    this.idum = step(this.idum);
    const j = Math.floor(this.iy / NDIV);
    this.iy = this.iv[j] as number;
    this.iv[j] = this.idum;
    return this.iy;
  }

  /** `RandomFloat(lo, hi)`: float32 maths like the C++ (`fl = AM × n`, clamped below 1, then `fl × (hi − lo) + lo`). */
  randomFloat(lo: number, hi: number): number {
    let fl = Math.fround(AM * this.next());
    if (fl > RNMX) fl = Math.fround(RNMX);
    return Math.fround(Math.fround(fl * Math.fround(hi - lo)) + lo);
  }
}

/** One Schrage step of idum = IA × idum mod IM (idum > 0). */
function step(idum: number): number {
  const k = Math.trunc(idum / IQ);
  let v = IA * (idum - k * IQ) - IR * k;
  if (v < 0) v += IM;
  return v;
}
