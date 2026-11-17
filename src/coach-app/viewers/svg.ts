/** Tiny SVG helpers for the hand-drawn charts (no chart library). */

export interface Scale {
  (v: number): number;
  d0: number;
  d1: number;
}

/** Linear scale from the domain [d0, d1] to the range [r0, r1]. */
export function scale(d0: number, d1: number, r0: number, r1: number): Scale {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as Scale;
  f.d0 = d0;
  f.d1 = d1;
  return f;
}

/** An SVG path through the points, broken where a value is not finite. */
export function linePath(xs: readonly number[], ys: readonly number[], sx: (v: number) => number, sy: (v: number) => number): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] ?? NaN;
    const y = ys[i] ?? NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** About `n` round tick values covering [lo, hi]. */
export function ticks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export function finiteRange(...lists: (readonly number[])[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of lists) for (const v of l) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo <= hi ? [lo, hi] : [0, 1];
}

export function fmt(v: number, digits = 0): string {
  const s = v.toFixed(digits);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}
