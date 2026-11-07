/**
 * A1: CS2's distance attenuation and occlusion, pure (tested in Node). docs/cs2-sounds.md "Attenuation".
 *
 * Distance: every CS2 sound event carries its own `distance_volume_mapping_curve` (data/audio/cs2-sound-events.json,
 * from the decompiled `.vsndevts` in SteamDatabase/GameTracking-CS2): points `[distance (units), volume, slopeIn,
 * slopeOut, modeIn, modeOut]`. We evaluate it as a cubic Hermite spline through the points with the given slopes
 * (volume per unit), held flat before the first and after the last point, clamped at 0. The interpolation-mode
 * numbers (1, 2, 3) are not documented publicly; the Hermite reading reproduces every point exactly and follows the
 * slopes, which is what they describe. **Assumed** for the in-between shape. The event's `volume` multiplies the
 * curve; a child event (the AK's `Weapon_AK47.SingleDistant`) has its own curve, so far shots turn into the distant
 * layer as in CS2.
 *
 * Occlusion: CS2 traces `snd_occlusion_rays` (4) rays to the source (CS2 convar dump) and scales the event by its
 * `occlusion_intensity`. Here: 4 segments from the listener's ear to points around the emitter on the collision mesh
 * (MapGeometry.lineBlocked); the blocked share `b` (0..1) gives gain `1 − b × intensity × OCCLUSION_DEPTH` and a
 * low-pass falling from `OPEN_LOWPASS_HZ` to `OCCLUDED_LOWPASS_HZ`. Depth and cut-offs are **assumed** (tunables).
 */
import { AUDIO_TUNING } from './tuning';

export type CurvePoint = readonly number[];

/** The curve's volume at distance `d` (units). An empty curve is 1 everywhere. */
export function evalCurve(points: readonly CurvePoint[], d: number): number {
  const n = points.length;
  if (n === 0) return 1;
  const first = points[0] as CurvePoint;
  if (d <= (first[0] as number)) return Math.max(0, first[1] as number);
  const last = points[n - 1] as CurvePoint;
  if (d >= (last[0] as number)) return Math.max(0, last[1] as number);
  let i = 0;
  while (i < n - 2 && d > ((points[i + 1] as CurvePoint)[0] as number)) i++;
  const a = points[i] as CurvePoint;
  const b = points[i + 1] as CurvePoint;
  const x0 = a[0] as number;
  const x1 = b[0] as number;
  const h = x1 - x0;
  if (h <= 1e-9) return Math.max(0, b[1] as number);
  const t = (d - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const y0 = a[1] as number;
  const y1 = b[1] as number;
  const m0 = (a[3] ?? 0) * h;
  const m1 = (b[2] ?? 0) * h;
  const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
  return Math.max(0, y);
}

/** Linear gain of an event at distance `d`: its volume × its curve. */
export function distanceGain(volume: number, curve: readonly CurvePoint[], d: number): number {
  return volume * evalCurve(curve, d);
}

/** Gain and low-pass cut-off for a blocked share `blocked` (0..1) of the occlusion rays. */
export function occlusion(intensity: number, blocked: number): { gain: number; lowpassHz: number } {
  const k = Math.max(0, Math.min(1, blocked)) * Math.max(0, Math.min(1, intensity));
  const t = AUDIO_TUNING.occlusion;
  return { gain: 1 - k * t.depth, lowpassHz: t.openLowpassHz * Math.pow(t.occludedLowpassHz / t.openLowpassHz, k) };
}

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The 4 occlusion ray targets around an emitter at `e` seen from `ear` (CS2 snd_occlusion_rays 4): the emitter, and
 * three points `spread` units to its left, right and above, perpendicular to the line. Written into `out` (4 points,
 * reused: no allocation per frame).
 */
export function occlusionTargets(ear: P3, e: P3, spread: number, out: P3[]): void {
  const dx = e.x - ear.x;
  const dy = e.y - ear.y;
  const len = Math.hypot(dx, dy) || 1;
  const sx = (-dy / len) * spread;
  const sy = (dx / len) * spread;
  const set = (i: number, x: number, y: number, z: number): void => {
    const p = out[i] as P3;
    p.x = x;
    p.y = y;
    p.z = z;
  };
  set(0, e.x, e.y, e.z);
  set(1, e.x + sx, e.y + sy, e.z);
  set(2, e.x - sx, e.y - sy, e.z);
  set(3, e.x, e.y, e.z + spread);
}

/**
 * Closest approach of a bullet segment a→b to the listener at `l` (for the whiz, CS2's `BulletBy.*`): the distance
 * and the point, or null when the closest point is the segment's start (the shooter) or the listener is behind it.
 */
export function closestApproach(a: P3, b: P3, l: P3): { distance: number; t: number } | null {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const vz = b.z - a.z;
  const len2 = vx * vx + vy * vy + vz * vz;
  if (len2 < 1e-6) return null;
  const t = ((l.x - a.x) * vx + (l.y - a.y) * vy + (l.z - a.z) * vz) / len2;
  if (t <= 0 || t > 1) return null;
  const px = a.x + vx * t - l.x;
  const py = a.y + vy * t - l.y;
  const pz = a.z + vz * t - l.z;
  return { distance: Math.hypot(px, py, pz), t };
}
