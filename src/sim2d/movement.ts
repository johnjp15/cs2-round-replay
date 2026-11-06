/**
 * Source-style ground movement for the 2D sim, close enough to CS2 that tuning carries over:
 * friction, then acceleration toward the wish velocity, then a wall-sliding position update on the
 * nav mesh. Pure functions over MoveState at 64 Hz; every parameter comes from tuning
 * (`Tuning.movement`). Equations and sign conventions: docs/movement.md.
 */
import type { Button, MovementTuning, PawnInput, Vec3 } from '../contracts/index';
import type { NavMesh } from './nav';

export const TICKS_PER_SEC = 64;
/** Seconds per tick. */
export const TICK_DT = 1 / TICKS_PER_SEC;

const DEG = Math.PI / 180;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const NO_WISH: Wish = { dirX: 0, dirY: 0, speed: 0, accelScale: 0 };

/** Kinematic state of one pawn. Ground only: `vel.z` is always 0 and `pos.z` is the nav floor. */
export interface MoveState {
  readonly pos: Vec3;
  /** Units per second. */
  readonly vel: Vec3;
  /** Degrees CCW from +x (0 = east, 90 = north). */
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
}

/** The fields of a PawnInput that movement reads (any PawnInput fits). */
export type MoveInput = Pick<PawnInput, 'forward' | 'side' | 'yaw' | 'pitch' | 'buttons'>;

/** Wish direction (unit vector in the x/y plane, or zero), wish speed and acceleration scale (units/s). */
export interface Wish {
  readonly dirX: number;
  readonly dirY: number;
  readonly speed: number;
  /** max(speed, accelScaleFloor × run speed of the weapon); equals `speed` when running at full stick. */
  readonly accelScale: number;
}

export interface MoveStep {
  readonly state: MoveState;
  /** True when the nav mesh cut the move short (wall contact); `vel` was then reduced to the actual displacement. */
  readonly clipped: boolean;
}

export class MovementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementError';
  }
}

/**
 * Run speed (units/s) for the held item: `runSpeedByWeapon[weapon]`, falling back to the knife's
 * entry for items the table does not list (e.g. a defuser). Throws if neither exists.
 */
export function runSpeed(weapon: string, m: MovementTuning): number {
  const own = m.runSpeedByWeapon[weapon];
  if (own !== undefined) return own;
  const knife = m.runSpeedByWeapon['knife'];
  if (knife === undefined) throw new MovementError(`movement.runSpeedByWeapon: no entry for ${weapon} and no knife fallback`);
  return knife;
}

/** Speed cap for the held item and buttons: run × (WALK ? walkFactor : 1) × (DUCK ? crouchFactor : 1). */
export function maxSpeed(weapon: string, buttons: readonly Button[], m: MovementTuning): number {
  let v = runSpeed(weapon, m);
  if (buttons.includes('WALK')) v *= m.walkFactor;
  if (buttons.includes('DUCK')) v *= m.crouchFactor;
  return v;
}

/**
 * Wish direction and speed from forward/side relative to `yaw`. Forward = (cos yaw, sin yaw);
 * positive side = strafe right = yaw − 90° = (sin yaw, −cos yaw). (forward, side) is normalized when
 * its length exceeds 1; wish speed = maxSpeed × min(1, |(forward, side)|).
 */
export function wishFromInput(input: MoveInput, weapon: string, m: MovementTuning): Wish {
  let f = input.forward;
  let s = input.side;
  const len = Math.sqrt(f * f + s * s);
  if (len === 0) return NO_WISH;
  if (len > 1) {
    f /= len;
    s /= len;
  }
  const c = Math.cos(input.yaw * DEG);
  const sn = Math.sin(input.yaw * DEG);
  const wx = f * c + s * sn;
  const wy = f * sn - s * c;
  const wl = Math.sqrt(wx * wx + wy * wy);
  if (wl === 0) return NO_WISH;
  const speed = maxSpeed(weapon, input.buttons, m) * Math.min(1, len);
  return { dirX: wx / wl, dirY: wy / wl, speed, accelScale: Math.max(speed, m.accelScaleFloor * runSpeed(weapon, m)) };
}

/**
 * Source ground friction: control = max(speed, svStopSpeed); drop = control × svFriction × dt;
 * vel *= max(speed − drop, 0) / speed.
 */
export function applyFriction(vel: Vec3, m: MovementTuning, dt: number): Vec3 {
  const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
  if (speed === 0) return ZERO;
  const control = Math.max(speed, m.svStopSpeed);
  const drop = control * m.svFriction * dt;
  const scale = Math.max(speed - drop, 0) / speed;
  return { x: vel.x * scale, y: vel.y * scale, z: 0 };
}

/**
 * Source acceleration: addspeed = wishspeed − dot(vel, wishdir); if addspeed > 0,
 * vel += min(svAccelerate × dt × accelScale, addspeed) × wishdir, where accelScale = wishspeed
 * except that `accelScaleFloor` can raise it for walking, crouching and partial stick (see Wish).
 */
export function accelerate(vel: Vec3, wish: Wish, m: MovementTuning, dt: number): Vec3 {
  const current = vel.x * wish.dirX + vel.y * wish.dirY;
  const addspeed = wish.speed - current;
  if (!(addspeed > 0)) return vel;
  const accelspeed = Math.min(m.svAccelerate * dt * wish.accelScale, addspeed);
  return { x: vel.x + accelspeed * wish.dirX, y: vel.y + accelspeed * wish.dirY, z: 0 };
}

/**
 * One movement tick. `input` null = no command (zero move, keep yaw/pitch, buttons released).
 * Order: yaw/pitch/crouch from the input, friction, accelerate, then position via
 * `nav.clampMove(pos, pos + vel × dt)`. If the move was clipped, vel becomes the actual displacement / dt
 * (a wall slide keeps its tangential speed and loses the blocked part). z = nav floor height.
 * A pawn that starts off walkable space (e.g. teleported into a hole) moves unclamped until it is
 * back on the mesh, rather than being frozen in place.
 */
export function stepMove(s: MoveState, input: MoveInput | null, weapon: string, nav: NavMesh, m: MovementTuning, dt: number = TICK_DT): MoveStep {
  const yaw = input === null ? s.yaw : input.yaw;
  const pitch = input === null ? s.pitch : input.pitch;
  const crouching = input === null ? false : input.buttons.includes('DUCK');
  let vel = applyFriction(s.vel, m, dt);
  if (input !== null) vel = accelerate(vel, wishFromInput(input, weapon, m), m, dt);

  const tx = s.pos.x + vel.x * dt;
  const ty = s.pos.y + vel.y * dt;
  let x = tx;
  let y = ty;
  let clipped = false;
  if (nav.isWalkable(s.pos)) {
    const r = nav.clampMove(s.pos, { x: tx, y: ty, z: s.pos.z });
    x = r.x;
    y = r.y;
    clipped = x !== tx || y !== ty;
  }
  if (clipped) vel = { x: (x - s.pos.x) / dt, y: (y - s.pos.y) / dt, z: 0 };
  const z = nav.zAt({ x, y, z: s.pos.z });
  return { state: { pos: { x, y, z }, vel, yaw, pitch, crouching }, clipped };
}
