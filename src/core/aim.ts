/**
 * Aim geometry for scripted shots (B3): where a shooter looks to hit a band (head, chest, …) of a
 * target, or to look at a point on the floor (the bomb). Pure functions over positions and
 * `tuning.damage`, whose eye and band heights both engines share: the 2D hitscan
 * (src/sim2d/hitscan.ts) picks the hitgroup with the same formulas, and CS2 bots aim at the same
 * heights. The Core can't import src/sim2d, so the formulas are repeated here (tests check they agree).
 *
 * Angles: yaw degrees CCW from +x, pitch Source's (positive = down). Every result is rounded to
 * 0.001° (docs/port-notes.md "Puppets", trig).
 */
import type { DamageTuning, Vec3 } from '../contracts/index';
import { bearing, dist2, roundYaw, turnToward } from './puppet';

/** The bands a scripted shot aims at (`tuning.damage.bandHeights`), top to bottom. */
export const AIM_BANDS = ['head', 'chest', 'stomach', 'leg'] as const;
export type AimBand = (typeof AIM_BANDS)[number];

/** Source clamps view pitch to ±89° (game rule, not calibration). */
export const MAX_PITCH_DEG = 89;

/** Pitches are rounded to 1 / PITCH_SCALE degrees, like yaws. */
const PITCH_SCALE = 1000;
/** Closer than this (units, 2D) the bearing is meaningless: keep the yaw. */
const MIN_LOOK_DIST = 1;

/** A look direction (degrees). */
export interface Look {
  readonly yaw: number;
  readonly pitch: number;
}

/** Eye height above `pos.z`: `damage.eyeHeight` standing, `crouchEyeHeight` crouched. */
export function eyeHeightOf(crouching: boolean, d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>): number {
  return crouching ? d.crouchEyeHeight : d.eyeHeight;
}

/** Height of a band above `pos.z`; a crouched target's bands scale by crouchEyeHeight / eyeHeight. */
export function bandHeightOf(band: AimBand, crouching: boolean, d: Pick<DamageTuning, 'bandHeights' | 'eyeHeight' | 'crouchEyeHeight'>): number {
  const h = d.bandHeights[band] ?? 0;
  return crouching ? (h * d.crouchEyeHeight) / d.eyeHeight : h;
}

/** Clamp to ±MAX_PITCH_DEG and round to 0.001°. */
export function roundPitch(deg: number): number {
  const c = deg > MAX_PITCH_DEG ? MAX_PITCH_DEG : deg < -MAX_PITCH_DEG ? -MAX_PITCH_DEG : deg;
  const r = Math.round(c * PITCH_SCALE) / PITCH_SCALE;
  return r === 0 ? 0 : r;
}

/** Pitch from the eye of a pawn at `from` to `point` (Source: + = down), rounded and clamped. */
export function pitchTo(from: Vec3, fromCrouching: boolean, point: Vec3, d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>): number {
  const dz = point.z - (from.z + eyeHeightOf(fromCrouching, d));
  return roundPitch((-Math.atan2(dz, dist2(from, point)) * 180) / Math.PI);
}

/** The point a shot at `band` of a target standing (or crouching) at `to` aims at. */
export function bandPoint(to: Vec3, toCrouching: boolean, band: AimBand, d: Pick<DamageTuning, 'bandHeights' | 'eyeHeight' | 'crouchEyeHeight'>): Vec3 {
  return { x: to.x, y: to.y, z: to.z + bandHeightOf(band, toCrouching, d) };
}

/** Pitch at which `from`'s eye looks at `band` of a target at `to` (same formula as sim2d's `aimPitch`). */
export function aimPitchAt(from: Vec3, fromCrouching: boolean, to: Vec3, toCrouching: boolean, band: AimBand, d: Pick<DamageTuning, 'bandHeights' | 'eyeHeight' | 'crouchEyeHeight'>): number {
  return pitchTo(from, fromCrouching, bandPoint(to, toCrouching, band, d), d);
}

/** Turn a pitch toward `to` by at most `maxStep` degrees; rounded. */
export function turnPitchToward(from: number, to: number, maxStep: number): number {
  const d = to - from;
  return roundPitch(from + (d > maxStep ? maxStep : d < -maxStep ? -maxStep : d));
}

/**
 * Look from `prev` toward `point` as seen from the eye of a pawn at `from`: the yaw turns toward the
 * bearing and the pitch toward `pitchTo`, each by at most `maxStep` degrees. Closer than 1 unit (2D)
 * the yaw is kept.
 */
export function lookToward(prev: Look, from: Vec3, fromCrouching: boolean, point: Vec3, d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>, maxStep: number): Look {
  const yaw = dist2(from, point) < MIN_LOOK_DIST ? roundYaw(prev.yaw) : turnToward(prev.yaw, bearing(from, point), maxStep);
  return { yaw, pitch: turnPitchToward(prev.pitch, pitchTo(from, fromCrouching, point, d), maxStep) };
}
