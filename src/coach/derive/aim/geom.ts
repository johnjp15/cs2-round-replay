/** Angles and body points for the aim tables. Source conventions: pitch + = down, yaw counter-clockwise from +x. */
import { defaultLosTuning } from '../los';
import type { AimTuning } from './tuning';

export type V3 = [number, number, number];
const DEG = 180 / Math.PI;

/** Wrap an angle difference to (−180, 180]. */
export function wrap180(a: number): number {
  let x = a % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

/** View angles from `eye` to `point`. */
export function anglesTo(eye: V3, point: V3): { pitch: number; yaw: number } {
  const dx = point[0] - eye[0];
  const dy = point[1] - eye[1];
  const dz = point[2] - eye[2];
  return { pitch: -Math.atan2(dz, Math.hypot(dx, dy)) * DEG, yaw: Math.atan2(dy, dx) * DEG };
}

/** Unit direction of view angles. */
export function dirOf(pitch: number, yaw: number): V3 {
  const p = pitch / DEG;
  const y = yaw / DEG;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

/** Angle (degrees) between direction `d` (unit) and the ray from `eye` to `point`. */
export function angleToPoint(eye: V3, d: V3, point: V3): number {
  const vx = point[0] - eye[0];
  const vy = point[1] - eye[1];
  const vz = point[2] - eye[2];
  const len = Math.hypot(vx, vy, vz);
  if (len === 0) return 0;
  const c = (vx * d[0] + vy * d[1] + vz * d[2]) / len;
  return Math.acos(Math.max(-1, Math.min(1, c))) * DEG;
}

/** Crouch scale of body heights (1 standing, crouchEye / eye at duck 1), as `LosWorld` poses targets. */
export function crouchScale(duck: number): number {
  const t = defaultLosTuning();
  const d = duck < 0 ? 0 : duck > 1 ? 1 : duck;
  return 1 - d * (1 - t.crouchEyeHeight / t.eyeHeight);
}

/** Head, chest (the target centre) and pelvis of a player standing at `feet` with `duck`. */
export function bodyPoints(feet: V3, duck: number, b: AimTuning['body']): [V3, V3, V3] {
  const k = crouchScale(duck);
  return [
    [feet[0], feet[1], feet[2] + Math.max(5, (b.top - 8) * k)],
    [feet[0], feet[1], feet[2] + b.centre * k],
    [feet[0], feet[1], feet[2] + Math.max(5, 29 * k)],
  ];
}

/**
 * Offsets of an aim direction from the target's chest: `up` (degrees, + = aim above), `right` (+ = aim right of it),
 * and whether the aim ray passes through the target's silhouette (a box ±halfWidth wide, bottom–top tall above the
 * feet, crouch-scaled) at the target's distance.
 */
export function aimOffset(eye: V3, pitch: number, yaw: number, feet: V3, duck: number, b: AimTuning['body']): { up: number; right: number; onTarget: boolean; dist: number } {
  const k = crouchScale(duck);
  const chest: V3 = [feet[0], feet[1], feet[2] + b.centre * k];
  const to = anglesTo(eye, chest);
  const up = to.pitch - pitch;
  const right = wrap180(to.yaw - yaw);
  const horiz = Math.hypot(chest[0] - eye[0], chest[1] - eye[1]);
  const dist = Math.hypot(horiz, chest[2] - eye[2]);
  const lateral = horiz * Math.tan(Math.min(89, Math.abs(right)) / DEG);
  const z = eye[2] - horiz * Math.tan(Math.max(-89, Math.min(89, pitch)) / DEG);
  const onTarget = Math.abs(right) < 90 && lateral <= b.halfWidth && z >= feet[2] + b.bottom * k && z <= feet[2] + b.top * k;
  return { up, right, onTarget, dist };
}
