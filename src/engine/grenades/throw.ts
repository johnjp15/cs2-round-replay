/**
 * The CS2 release law (docs/grenades.md, Throw): throw angle, speed by throw strength, spawn point and the inherited
 * player velocity, plus the jump-throw latch.
 */
import type { GrenadeCs2Tuning, Vec3 } from '../../contracts/index';
import { forward } from './math';
import type { GrenadeWorld } from './types';

/** Source's throw-pitch remap: pitch' = pitch − (90 − |pitch|) × offset / 90 (level aim throws `offset` up). */
export function throwPitch(pitch: number, t: Pick<GrenadeCs2Tuning, 'throwPitchOffsetDeg'>): number {
  let p = pitch;
  if (p > 90) p -= 360;
  else if (p < -90) p += 360;
  p = Math.max(-90, Math.min(90, p));
  return p - ((90 - Math.abs(p)) * t.throwPitchOffsetDeg) / 90;
}

/** Throw speed (units/s) for a strength in [0, 1]: clamp(750 × 0.9, 15, 750) × (0.3 + 0.7 × strength). */
export function throwSpeed(strength: number, t: GrenadeCs2Tuning): number {
  const s = Math.max(0, Math.min(1, strength));
  const base = Math.max(t.throwVelocityMin, Math.min(t.throwVelocityMax, t.throwVelocity * t.throwVelocityScale));
  return base * (t.strengthBase + t.strengthScale * s);
}

export interface Release {
  readonly pos: Vec3;
  readonly vel: Vec3;
}

/**
 * Spawn point and initial velocity. The source is the eye, lowered 12 × (1 − strength); the grenade's box is traced
 * 22 units along the throw direction and backed off 6 (so 16 ahead of the eye in the open); velocity = speed × dir
 * + 1.25 × the thrower's velocity.
 */
export function releaseGrenade(
  eye: Vec3,
  pitch: number,
  yaw: number,
  strength: number,
  playerVel: Vec3,
  world: GrenadeWorld,
  t: GrenadeCs2Tuning,
): Release {
  const s = Math.max(0, Math.min(1, strength));
  const dir = forward(throwPitch(pitch, t), yaw);
  const sx = eye.x;
  const sy = eye.y;
  const sz = eye.z - t.spawnDropUnderhand * (1 - s);
  const tr = world.traceHull(sx, sy, sz, t.hullHalf, dir.x * t.spawnTrace, dir.y * t.spawnTrace, dir.z * t.spawnTrace);
  const reach = t.spawnTrace * (tr.startSolid ? 0 : tr.fraction) - t.spawnBackoff;
  const pos = { x: sx + dir.x * reach, y: sy + dir.y * reach, z: sz + dir.z * reach };
  const speed = throwSpeed(s, t);
  const k = t.playerVelocityScale;
  const vel = { x: dir.x * speed + playerVel.x * k, y: dir.y * speed + playerVel.y * k, z: dir.z * speed + playerVel.z * k };
  return { pos, vel };
}

/**
 * The jump-throw latch (memorin.app "Jump-throw physics"): a grenade released near a jump is thrown with the pose
 * and velocity of `jumpThrowLatchSec` (0.1 s) after the jump: vz = 298.87 − 800 × 0.1 = 218.87 u/s and the eye
 * raised by the jump's rise over that time. `eye` and `horizontal` are at the jump (the horizontal velocity is
 * carried; air acceleration over 0.1 s is ignored).
 */
export function jumpThrowPose(eye: Vec3, horizontal: { x: number; y: number }, t: GrenadeCs2Tuning): { eye: Vec3; velocity: Vec3 } {
  const dt = t.jumpThrowLatchSec;
  const rise = t.jumpVzStart * dt - 0.5 * t.gravity * dt * dt;
  return {
    eye: { x: eye.x + horizontal.x * dt, y: eye.y + horizontal.y * dt, z: eye.z + rise },
    velocity: { x: horizontal.x, y: horizontal.y, z: t.jumpVzStart - t.gravity * dt },
  };
}
