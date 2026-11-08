/**
 * A2: objective measurements of a mono PCM buffer (tools/audio-analyze.ts, tests/a2-sound.test.ts). Pure, no DOM.
 *
 * Peak / RMS in dBFS, the loudest 50 ms window (a short-term loudness), DC offset, clicks (a non-zero first or last
 * sample: the sound starts or stops without an envelope), the attack (time to reach −6 dB of the peak), the tail
 * (time until the 50 ms RMS stays 40 dB under its maximum), the spectral centroid and the share of energy in bands
 * (60–120 Hz thump, > 4 kHz air), and an envelope + spectrum fingerprint to find sounds that are the same.
 */

export interface PcmMetrics {
  readonly durSec: number;
  readonly peakDb: number;
  readonly rmsDb: number;
  /** The loudest 50 ms RMS (dBFS). */
  readonly shortDb: number;
  readonly dc: number;
  /** |first sample| and the largest |sample| in the last 1 ms (both ≈ 0 for an enveloped sound). */
  readonly startAbs: number;
  readonly endAbs: number;
  readonly attackMs: number;
  readonly tailMs: number;
  readonly centroidHz: number;
  /** Energy share 20–60 Hz, 60–120 Hz, 120–500 Hz, 500–4000 Hz, > 4000 Hz. */
  readonly bands: readonly [number, number, number, number, number];
  readonly clipped: number;
  readonly fingerprint: Float32Array;
}

export const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** In-place radix-2 FFT (re, im of length 2^k). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k;
        const q = p + len / 2;
        const xr = (re[q] as number) * cr - (im[q] as number) * ci;
        const xi = (re[q] as number) * ci + (im[q] as number) * cr;
        re[q] = (re[p] as number) - xr;
        im[q] = (im[p] as number) - xi;
        re[p] = (re[p] as number) + xr;
        im[p] = (im[p] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Power spectrum averaged over Hann windows of 4096 (hop 2048), bins 0..2048. */
export function powerSpectrum(pcm: Float32Array, rate: number): { power: Float64Array; binHz: number } {
  const N = 4096;
  const power = new Float64Array(N / 2 + 1);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let frames = 0;
  for (let start = 0; start === 0 || start + N / 2 < pcm.length; start += N / 2) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = (pcm[start + i] ?? 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) power[k] = (power[k] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    frames++;
  }
  for (let k = 0; k <= N / 2; k++) power[k] = (power[k] as number) / frames;
  return { power, binHz: rate / N };
}

export function measure(pcm: Float32Array, rate: number): PcmMetrics {
  const n = pcm.length;
  let peak = 0;
  let sum = 0;
  let sq = 0;
  let clipped = 0;
  let peakAt = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm[i] as number;
    const a = Math.abs(v);
    if (a > peak) {
      peak = a;
      peakAt = i;
    }
    if (a > 1) clipped++;
    sum += v;
    sq += v * v;
  }
  // 50 ms windows (hop 10 ms).
  const win = Math.max(1, Math.round(rate * 0.05));
  const hop = Math.max(1, Math.round(rate * 0.01));
  const env: number[] = [];
  for (let s = 0; s < Math.max(1, n - win + 1); s += hop) {
    let e = 0;
    for (let i = s; i < Math.min(n, s + win); i++) e += (pcm[i] as number) ** 2;
    env.push(Math.sqrt(e / win));
  }
  const envMax = Math.max(...env);
  let tailIdx = env.length - 1;
  while (tailIdx > 0 && (env[tailIdx] as number) < envMax * 0.01) tailIdx--;
  let attack = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(pcm[i] as number) >= peak * 0.5) {
      attack = i;
      break;
    }
  }
  let endAbs = 0;
  for (let i = Math.max(0, n - Math.round(rate * 0.001)); i < n; i++) endAbs = Math.max(endAbs, Math.abs(pcm[i] as number));
  const { power, binHz } = powerSpectrum(pcm, rate);
  let tot = 0;
  let cen = 0;
  const bands: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const edges = [20, 60, 120, 500, 4000, Infinity];
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    const p = power[k] as number;
    if (f < 20) continue;
    tot += p;
    cen += p * f;
    for (let b = 0; b < 5; b++) if (f >= (edges[b] as number) && f < (edges[b + 1] as number)) bands[b] = (bands[b] as number) + p;
  }
  for (let b = 0; b < 5; b++) bands[b] = tot > 0 ? (bands[b] as number) / tot : 0;
  // Fingerprint: 32 log-spaced spectrum bands (normalised) + 32 envelope points (normalised to the peak).
  const fp = new Float32Array(64);
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    if (f < 30) continue;
    const b = Math.min(31, Math.floor((Math.log(f / 30) / Math.log(20000 / 30)) * 32));
    fp[b] = (fp[b] as number) + (power[k] as number);
  }
  const norm = (a: Float32Array, from: number, to: number): void => {
    let m = 0;
    for (let i = from; i < to; i++) m += (a[i] as number) ** 2;
    m = Math.sqrt(m) || 1;
    for (let i = from; i < to; i++) a[i] = (a[i] as number) / m;
  };
  for (let i = 0; i < 32; i++) fp[i] = Math.sqrt(fp[i] as number);
  norm(fp, 0, 32);
  for (let i = 0; i < 32; i++) fp[32 + i] = env[Math.min(env.length - 1, Math.floor((i / 32) * env.length))] as number;
  norm(fp, 32, 64);
  return {
    durSec: n / rate,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sq / Math.max(1, n))),
    shortDb: db(envMax),
    dc: sum / Math.max(1, n),
    startAbs: Math.abs(pcm[0] ?? 0),
    endAbs,
    attackMs: (attack / rate) * 1000,
    tailMs: (((tailIdx * hop + win) / rate) - peakAt / rate) * 1000,
    centroidHz: tot > 0 ? cen / tot : 0,
    bands,
    clipped,
    fingerprint: fp,
  };
}

/** Cosine similarity of two fingerprints (1 = same spectrum and envelope). */
export function similarity(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s / 2;
}
