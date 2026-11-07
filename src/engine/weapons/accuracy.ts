/**
 * Inaccuracy and spread: the accuracy penalty (its floor by stance, the per-shot fire penalty and its decay over the
 * recovery time), the total inaccuracy at the moment of a shot (penalty + movement + air), and the shot direction
 * from two cones (inaccuracy and spread), drawn from the caller's seeded RNG. docs/weapons.md, "Accuracy".
 *
 * Units: inaccuracy and spread are the tangent of the cone's half-angle (CS2's own units: an inaccuracy of 0.00641
 * puts a bullet at most 6.56 units off-centre at 1,024 units). Velocities in units per second.
 */
import { roundNumber, type Vec3, type WeaponModelTuning } from '../../contracts/index';
import type { Angle2 } from './recoil';
import type { WeaponDef } from './table';

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** What the shooter's body is doing this tick. */
export interface Motion {
  /** Units per second (the pawn's velocity, z up). */
  readonly velocity: Vec3;
  readonly onGround: boolean;
  readonly crouched: boolean;
  readonly onLadder: boolean;
}

/** The part of the RNG contract the spread draw needs (contracts/rng.ts `Rng` fits). */
export interface UniformSource {
  /** Next float in [0, 1). */
  next(): number;
}

type FloorTuning = Pick<WeaponModelTuning, 'airSpreadScale'>;

/**
 * The value the accuracy penalty decays toward (and never sits below): ladder, else in the air stand + jumpApex,
 * else crouch or stand; + reload while reloading.
 */
export function penaltyFloor(w: WeaponDef, mode: 0 | 1, motion: Motion, reloading: boolean, m: FloorTuning): number {
  const i = w.inaccuracy;
  let p: number;
  if (motion.onLadder) p = i.ladder[mode];
  else if (!motion.onGround) p = i.stand[mode] + i.jumpApex * m.airSpreadScale;
  else if (motion.crouched) p = i.crouch[mode];
  else p = i.stand[mode];
  if (reloading) p += i.reload;
  return p;
}

/** Where the shooter is, for the recovery time: on the ground, in the air, or on a ladder. */
export type Footing = 'ground' | 'air' | 'ladder';


/**
 * Recovery time (seconds for the penalty to fall to a tenth), CS:GO's `CWeaponCSBase::GetRecoveryTime` (docs/weapons.md
 * S9): on a ladder the standing time; else (also in the air, see below) the stand / crouch time, moving linearly to the "final" time between transitionStartBullet and
 * transitionEndBullet of the **integer** recoil index (`int nRecoilIndex = m_flRecoilIndex`; RemapValClamped), unless
 * the final time is unset (−1).
 */
export function recoveryTime(w: WeaponDef, crouched: boolean, recoilIndex: number, footing: Footing = 'ground'): number {
  const r = w.recovery;
  if (footing === 'ladder') return r.stand;
  // CS:GO's in-air rule (crouch × 4) is not applied: CS2's air model (m_flInaccuracyJumpApex, which CS:GO's 2020 code
  // doesn't have) differs, and the sim's air terms follow CS2's fields; docs/weapons.md, gunplay checklist G9.
  const a = crouched ? r.crouch : r.stand;
  const b = crouched ? r.crouchFinal : r.standFinal;
  if (b === -1) return a;
  const n = Math.trunc(recoilIndex);
  const span = r.transitionEndBullet - r.transitionStartBullet;
  const t = span === 0 ? (n >= r.transitionEndBullet ? 1 : 0) : Math.max(0, Math.min(1, (n - r.transitionStartBullet) / span));
  return a + (b - a) * t;
}

/**
 * One tick of the accuracy penalty: if the floor is above it, it jumps to the floor; else it decays toward the floor,
 * `penalty = floor + (penalty − floor) × e^(−dt × ln(penaltyDecayRatio) / recovery)`.
 */
export function decayPenalty(penalty: number, floor: number, recovery: number, dt: number, m: Pick<WeaponModelTuning, 'penaltyDecayRatio'>): number {
  if (floor >= penalty) return roundNumber(floor);
  if (recovery <= 0) return roundNumber(floor);
  const k = Math.exp((-dt * Math.log(m.penaltyDecayRatio)) / recovery);
  return roundNumber(floor + (penalty - floor) * k);
}

type InaccuracyTuning = Pick<WeaponModelTuning, 'moveStartFraction' | 'moveFullFraction' | 'moveCurveExponent' | 'airSpreadScale' | 'airLowSpeedFraction' | 'airMaxPenalty' | 'jumpImpulse' | 'maxInaccuracy'>;

/** The 0–1 movement scale: 0 up to moveStartFraction × maxSpeed, 1 from moveFullFraction × maxSpeed, linear between, ^ exponent. */
export function movementScale(speed2d: number, maxSpeed: number, m: InaccuracyTuning): number {
  if (maxSpeed <= 0) return 0;
  const lo = maxSpeed * m.moveStartFraction;
  const hi = maxSpeed * m.moveFullFraction;
  const s = Math.max(0, Math.min(1, (speed2d - lo) / (hi - lo)));
  return s > 0 ? Math.pow(s, m.moveCurveExponent) : 0;
}

/** The 0–airMaxPenalty air scale from the vertical speed: √|vz| remapped from airLowSpeedFraction·√J … √J to 0 … 1. */
export function airScale(vz: number, m: InaccuracyTuning): number {
  const top = Math.sqrt(m.jumpImpulse);
  const lo = top * m.airLowSpeedFraction;
  const s = (Math.sqrt(Math.abs(vz)) - lo) / (top - lo);
  return Math.max(0, Math.min(m.airMaxPenalty, s));
}

/**
 * Total inaccuracy of a shot fired now: the accuracy penalty + movementScale × move + (in the air) airScale × jump ×
 * airSpreadScale, capped at maxInaccuracy. `maxSpeed` is the weapon's max speed in the current mode.
 */
export function inaccuracy(w: WeaponDef, mode: 0 | 1, penalty: number, motion: Motion, m: InaccuracyTuning): number {
  let acc = penalty;
  const speed = Math.hypot(motion.velocity.x, motion.velocity.y);
  acc += movementScale(speed, w.maxSpeed[mode], m) * w.inaccuracy.move[mode];
  if (!motion.onGround && !motion.onLadder) acc += airScale(motion.velocity.z, m) * w.inaccuracy.jump[mode] * m.airSpreadScale;
  return Math.min(acc, m.maxInaccuracy);
}

/** Offsets of one shot in the view plane (tangent units: x right, y up), one per pellet. */
export interface SpreadOffsets {
  /** Offsets per pellet (bullets per shot), in draw order. */
  readonly pellets: readonly { readonly x: number; readonly y: number }[];
}

/**
 * Draw the shot's cone offsets: one inaccuracy draw (r1, θ1) shared by all pellets, then per pellet a spread draw
 * (r2, θ2); r uniform in [0, 1) (so shots bunch toward the centre), θ uniform in [0, 2π).
 * `x = cos θ1 · r1 · inaccuracy + cos θ2 · r2 · spread`, `y = sin θ1 · r1 · inaccuracy + sin θ2 · r2 · spread`.
 * The R8 Revolver's alt fire uses r1 = 1 − r1²; the Negev's first shots (recoil index < 3) square r1 and r2 once per
 * missing index (more accurate first bullets). Draw order: r1, θ1, then r2, θ2 per pellet.
 */
export function drawSpread(w: WeaponDef, mode: 0 | 1, inacc: number, recoilIndex: number, rng: UniformSource): SpreadOffsets {
  let r1 = rng.next();
  const t1 = rng.next() * TWO_PI;
  if (w.revolver && mode === 1) r1 = 1 - r1 * r1;
  const negev = w.className === 'weapon_negev' && recoilIndex < 3;
  if (negev) for (let j = 3; j > recoilIndex; j--) r1 *= r1;
  const spread = w.spread[mode];
  const pellets: { x: number; y: number }[] = [];
  for (let b = 0; b < w.bullets; b++) {
    let r2 = rng.next();
    const t2 = rng.next() * TWO_PI;
    if (negev) for (let j = 3; j > recoilIndex; j--) r2 *= r2;
    pellets.push({ x: Math.cos(t1) * r1 * inacc + Math.cos(t2) * r2 * spread, y: Math.sin(t1) * r1 * inacc + Math.sin(t2) * r2 * spread });
  }
  return { pellets };
}

/** Source AngleVectors (roll 0) for view angles in degrees (pitch + = down, yaw counter-clockwise from +x). */
export function angleVectors(a: Angle2): { forward: Vec3; right: Vec3; up: Vec3 } {
  const sp = Math.sin(a.pitch * DEG);
  const cp = Math.cos(a.pitch * DEG);
  const sy = Math.sin(a.yaw * DEG);
  const cy = Math.cos(a.yaw * DEG);
  return {
    forward: { x: cp * cy, y: cp * sy, z: -sp },
    right: { x: sy, y: -cy, z: 0 },
    up: { x: sp * cy, y: sp * sy, z: cp },
  };
}

/** Unit direction of a bullet: normalize(forward + right × x + up × y) of the given (punched) view angles; components rounded to 6 decimals. */
export function shotDirection(view: Angle2, off: { readonly x: number; readonly y: number }): Vec3 {
  const { forward: f, right: r, up: u } = angleVectors(view);
  const dx = f.x + r.x * off.x + u.x * off.y;
  const dy = f.y + r.y * off.x + u.y * off.y;
  const dz = f.z + r.z * off.x + u.z * off.y;
  const len = Math.hypot(dx, dy, dz);
  return { x: roundNumber(dx / len), y: roundNumber(dy / len), z: roundNumber(dz / len) };
}
