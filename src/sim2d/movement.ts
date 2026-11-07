/**
 * Source-style movement for the 2D sim, close enough to CS2 that tuning carries over. Pure functions over MoveState
 * at 64 Hz; every parameter comes from tuning (`Tuning.movement`). Equations, sources and sign conventions:
 * docs/movement.md.
 *
 * - `stepMove3d` (G3): Source's PlayerMove on the CS2 collision mesh (`MapGeometry`, world + player clips): duck, jump,
 *   friction, ground acceleration, StepMove / StayOnGround on the ground, air acceleration and gravity in the air,
 *   TryPlayerMove slides (4 bumps), the ground check, landing, the landing speed penalty and fall damage.
 * - `stepMove` (B2): ground-only movement on the nav mesh (z = nav floor), for hosts without geometry (tests with a
 *   synthetic nav). On flat open ground both give the same horizontal motion.
 */
import type { Button, MovementTuning, PawnInput, Vec3 } from '../contracts/index';
import { CROUCHING_HULL, STANDING_HULL, TRACE_SKIN, type BoxTrace, type Hull, type MapGeometry } from './geometry';
import type { NavMesh } from './nav';

export const TICKS_PER_SEC = 64;
/** Seconds per tick. */
export const TICK_DT = 1 / TICKS_PER_SEC;

const DEG = Math.PI / 180;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const NO_WISH: Wish = { dirX: 0, dirY: 0, speed: 0, accelScale: 0 };

/**
 * Kinematic state of one pawn. `pos` is the feet (the bottom of the hull). With the nav movement `vel.z` is always 0,
 * `pos.z` the nav floor and `onGround` true.
 */
export interface MoveState {
  readonly pos: Vec3;
  /** Units per second. */
  readonly vel: Vec3;
  /** Degrees CCW from +x (0 = east, 90 = north). */
  readonly yaw: number;
  readonly pitch: number;
  /** Crouched hull (54 high); in the air the feet are tucked up by `airDuckLift`. */
  readonly crouching: boolean;
  /** On walkable ground (Source's ground entity). */
  readonly onGround: boolean;
  /** JUMP was held last tick (Source's IN_JUMP in m_nOldButtons): a jump needs a fresh press. */
  readonly jumpHeld: boolean;
  /** Landing speed penalty in percent (Source's stamina), recovering at `staminaRecoveryRate` per second. */
  readonly stamina: number;
}

/** A pawn standing still at `pos` (on the ground, no penalty). */
export function restingState(pos: Vec3, yaw = 0, pitch = 0, crouching = false): MoveState {
  return { pos: { x: pos.x, y: pos.y, z: pos.z }, vel: { x: 0, y: 0, z: 0 }, yaw, pitch, crouching, onGround: true, jumpHeld: false, stamina: 0 };
}

/** The fields of a PawnInput that movement reads (any PawnInput fits). */
export type MoveInput = Pick<PawnInput, 'forward' | 'side' | 'yaw' | 'pitch' | 'buttons'>;

/**
 * Per-pawn speed state the weapons engine owns (H2, src/engine/weapons `maxSpeedOf` / `applyHit`), passed in by the host.
 * Both optional; absent = the plain `runSpeedByWeapon` table, so the per-tick path is unchanged without them.
 */
export interface MoveOptions {
  /** The held item's speed in its current mode (CS2 weapons.vdata `m_flMaxSpeed[mode]`: AWP 100 scoped), replacing `runSpeedByWeapon`. */
  readonly runSpeed?: number;
  /**
   * Tagging (CS2 `m_flVelocityModifier`, 0..1): scales the speed cap (wish speed) only, not the acceleration rate
   * (unverified; docs/movement.md M1-4). The victim's modifier after a hit = min(current, flinch × `mp_tagging_scale`).
   */
  readonly velocityModifier?: number;
}

const NO_OPTIONS: MoveOptions = {};

/** Speed under which a ground move stops dead (Source WalkMove: `if ( spd < 1.0f ) mv->m_vecVelocity.Init()`). */
const WALK_STOP_SPEED = 1;
/** Friction leaves speeds below this alone (Source Friction: `if (speed < 0.1f) return`). */
const FRICTION_MIN_SPEED = 0.1;
/** `sv_enablebunnyhopping 0`: "Allow jump speed to exceed 1.1x max speed" (CS2 convar description). */
const BUNNYJUMP_MAX_SPEED_FACTOR = 1.1;
/** Source CategorizePosition: airborne and moving up (0 < vz ≤ NON_JUMP_VELOCITY) → m_surfaceFriction 0.25 for AirAccelerate. */
const AIR_RISE_SURFACE_FRICTION = 0.25;

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
  /**
   * True when a wall cut the move short: the nav mesh (2D; `vel` is then the actual displacement), or (3D) a surface
   * that isn't ground.
   */
  readonly clipped: boolean;
  /** 3D: a jump started this tick. */
  readonly jumped: boolean;
  /** 3D: the pawn landed this tick with this downward speed (units/s, Source's m_flFallVelocity), else 0. */
  readonly landSpeed: number;
  /** 3D: fall damage of that landing (HP before armor, an integer; 0 = none). */
  readonly fallDamage: number;
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
export function runSpeed(weapon: string, m: MovementTuning, opts: MoveOptions = NO_OPTIONS): number {
  if (opts.runSpeed !== undefined) return opts.runSpeed;
  const own = m.runSpeedByWeapon[weapon];
  if (own !== undefined) return own;
  const knife = m.runSpeedByWeapon['knife'];
  if (knife === undefined) throw new MovementError(`movement.runSpeedByWeapon: no entry for ${weapon} and no knife fallback`);
  return knife;
}

/** Speed cap for the held item and buttons: run × (WALK ? walkFactor : 1) × (DUCK ? crouchFactor : 1). */
export function maxSpeed(weapon: string, buttons: readonly Button[], m: MovementTuning, opts: MoveOptions = NO_OPTIONS): number {
  let v = runSpeed(weapon, m, opts);
  if (opts.velocityModifier !== undefined) v *= opts.velocityModifier;
  if (buttons.includes('WALK')) v *= m.walkFactor;
  if (buttons.includes('DUCK')) v *= m.crouchFactor;
  return v;
}

/**
 * Wish direction and speed from forward/side relative to `yaw`. Forward = (cos yaw, sin yaw);
 * positive side = strafe right = yaw − 90° = (sin yaw, −cos yaw). (forward, side) is normalized when
 * its length exceeds 1; wish speed = maxSpeed × min(1, |(forward, side)|).
 */
export function wishFromInput(input: MoveInput, weapon: string, m: MovementTuning, opts: MoveOptions = NO_OPTIONS): Wish {
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
  const speed = maxSpeed(weapon, input.buttons, m, opts) * Math.min(1, len);
  return { dirX: wx / wl, dirY: wy / wl, speed, accelScale: Math.max(speed, m.accelScaleFloor * runSpeed(weapon, m, opts)) };
}

/**
 * Source ground friction (gamemovement.cpp Friction): speeds below 0.1 are left alone; control = max(speed, svStopSpeed);
 * drop = control × svFriction × dt; vel *= max(speed − drop, 0) / speed.
 */
export function applyFriction(vel: Vec3, m: MovementTuning, dt: number): Vec3 {
  const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
  if (speed === 0) return ZERO;
  if (speed < FRICTION_MIN_SPEED) return { x: vel.x, y: vel.y, z: 0 };
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

/** Source WalkMove: a ground velocity under 1 u/s after the acceleration is zeroed. */
function walkStop(vel: Vec3): Vec3 {
  return vel.x * vel.x + vel.y * vel.y < WALK_STOP_SPEED * WALK_STOP_SPEED ? ZERO : vel;
}

/**
 * One movement tick. `input` null = no command (zero move, keep yaw/pitch, buttons released).
 * Order: yaw/pitch/crouch from the input, friction, accelerate, then position via
 * `nav.clampMove(pos, pos + vel × dt)`. If the move was clipped, vel becomes the actual displacement / dt
 * (a wall slide keeps its tangential speed and loses the blocked part). z = nav floor height.
 * A pawn that starts off walkable space (e.g. teleported into a hole) moves unclamped until it is
 * back on the mesh, rather than being frozen in place.
 */
export function stepMove(s: MoveState, input: MoveInput | null, weapon: string, nav: NavMesh, m: MovementTuning, dt: number = TICK_DT, opts: MoveOptions = NO_OPTIONS): MoveStep {
  const yaw = input === null ? s.yaw : input.yaw;
  const pitch = input === null ? s.pitch : input.pitch;
  const crouching = input === null ? false : input.buttons.includes('DUCK');
  let vel = applyFriction(s.vel, m, dt);
  if (input !== null) vel = accelerate(vel, wishFromInput(input, weapon, m, opts), m, dt);
  vel = walkStop(vel);

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
  return { state: { pos: { x, y, z }, vel, yaw, pitch, crouching, onGround: true, jumpHeld: false, stamina: 0 }, clipped, jumped: false, landSpeed: 0, fallDamage: 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3D movement (G3): Source's PlayerMove on MapGeometry
// ---------------------------------------------------------------------------------------------------------------------

/** Source's NON_JUMP_VELOCITY: moving up faster than this, a pawn is not on the ground. */
const NON_JUMP_VELOCITY = 140;
/** Source's ground check: a hull trace this far down (CategorizePosition). */
const GROUND_CHECK = 2;
/** Source's MAX_CLIP_PLANES. */
const MAX_CLIP_PLANES = 5;
/** Source's bump count in TryPlayerMove. */
const MAX_BUMPS = 4;
/** StayOnGround moves the pawn only if the floor is more than this far (half of COORD_RESOLUTION, 1/32). */
const STAY_EPS = 1 / 64;
/** `standsOn`: the standable top must be at least this high relative to where the trace ended (two trace skins)... */
const GROUND_EDGE = 2 * TRACE_SKIN;
/** ... at most this much above it ... */
const STEP_EDGE_UP = 8;
/** ... and under the footprint grown by this (units). */
const STEP_EDGE_MARGIN = 4;

/** The hull for a stance. */
export function hullOf(crouching: boolean): Hull {
  return crouching ? CROUCHING_HULL : STANDING_HULL;
}

/** Source's fall damage for a landing at `speed` (units/s): linear from fallSafeSpeed (0) to fallFatalSpeed (100), scaled; rounded down to whole HP. */
export function fallDamageFor(speed: number, m: MovementTuning): number {
  if (!(speed > m.fallSafeSpeed)) return 0;
  return Math.floor(((speed - m.fallSafeSpeed) * 100 * m.fallDamageScale) / (m.fallFatalSpeed - m.fallSafeSpeed));
}

/** Mutable working state of one 3D move (plain numbers, so the inner loop doesn't allocate vectors). */
class Mover {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  onGround = false;
  clipped = false;
  hull: Hull = STANDING_HULL;
  private readonly planes = new Float64Array(MAX_CLIP_PLANES * 3);

  constructor(
    private readonly g: MapGeometry,
    private readonly m: MovementTuning,
  ) {}

  trace(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BoxTrace {
    return this.g.traceBox({ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }, this.hull);
  }

  /**
   * A trace that ended on a surface steeper than standable still stands on ground if a standable top lies at most
   * STEP_EDGE_UP above the contact, under the footprint grown by STEP_EDGE_MARGIN: the hull is on the edge of a step
   * or ledge. This is Source's quadrant fallback (TryTouchGroundInQuadrants) in the form this mesh needs: its 8-unit
   * decimation turns stair risers into slants a couple of units deep, so a hull stepping up meets the slant just
   * before the step's top (docs/movement.md "Decimated stairs").
   */
  standsOn(t: BoxTrace): boolean {
    if (!t.hit) return false;
    if (t.normalZ >= this.m.standableNormal) return true;
    const f = this.g.floorBelow(t.endX, t.endY, t.endZ, this.hull.halfWidth + STEP_EDGE_MARGIN, STEP_EDGE_UP, GROUND_CHECK + GROUND_EDGE);
    return f !== null && f.normalZ >= this.m.standableNormal && f.z >= t.endZ - GROUND_EDGE;
  }

  /** Source's CheckVelocity: bound each axis by sv_maxvelocity. */
  checkVelocity(): void {
    const c = this.m.maxVelocity;
    this.vx = Math.max(-c, Math.min(c, this.vx));
    this.vy = Math.max(-c, Math.min(c, this.vy));
    this.vz = Math.max(-c, Math.min(c, this.vz));
  }

  /**
   * Source's TryPlayerMove: move along the velocity for `dt`, up to MAX_BUMPS traces, clipping the velocity against
   * each plane hit (overbounce 1, so it slides), along the crease of two planes, or stopping in a corner.
   */
  tryPlayerMove(dt: number): void {
    const pl = this.planes;
    const pvx = this.vx;
    const pvy = this.vy;
    const pvz = this.vz;
    let ovx = pvx;
    let ovy = pvy;
    let ovz = pvz;
    let numPlanes = 0;
    let allFraction = 0;
    let left = dt;
    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      if (this.vx === 0 && this.vy === 0 && this.vz === 0) break;
      const t = this.trace(this.x, this.y, this.z, this.x + this.vx * left, this.y + this.vy * left, this.z + this.vz * left);
      allFraction += t.fraction;
      if (t.allSolid) {
        this.vx = 0;
        this.vy = 0;
        this.vz = 0;
        return;
      }
      if (t.fraction > 0) {
        this.x = t.endX;
        this.y = t.endY;
        this.z = t.endZ;
        ovx = this.vx;
        ovy = this.vy;
        ovz = this.vz;
        numPlanes = 0;
      }
      if (t.fraction === 1) break;
      if (t.normalZ < this.m.standableNormal) this.clipped = true;
      left -= left * t.fraction;
      if (numPlanes >= MAX_CLIP_PLANES) {
        this.vx = 0;
        this.vy = 0;
        this.vz = 0;
        break;
      }
      pl[numPlanes * 3] = t.normalX;
      pl[numPlanes * 3 + 1] = t.normalY;
      pl[numPlanes * 3 + 2] = t.normalZ;
      numPlanes++;
      if (numPlanes === 1 && !this.onGround) {
        // In the air against one plane: slide along it (sv_bounce 0, so the overbounce is 1 for walls too).
        this.clip(ovx, ovy, ovz, t.normalX, t.normalY, t.normalZ);
        ovx = this.vx;
        ovy = this.vy;
        ovz = this.vz;
        continue;
      }
      let i = 0;
      for (; i < numPlanes; i++) {
        this.clip(ovx, ovy, ovz, pl[i * 3] as number, pl[i * 3 + 1] as number, pl[i * 3 + 2] as number);
        let j = 0;
        for (; j < numPlanes; j++) {
          if (j !== i && this.vx * (pl[j * 3] as number) + this.vy * (pl[j * 3 + 1] as number) + this.vz * (pl[j * 3 + 2] as number) < 0) break;
        }
        if (j === numPlanes) break;
      }
      if (i === numPlanes) {
        // Along the crease of two planes, or stuck in a corner.
        if (numPlanes !== 2) {
          this.vx = 0;
          this.vy = 0;
          this.vz = 0;
          break;
        }
        const ax = pl[0] as number;
        const ay = pl[1] as number;
        const az = pl[2] as number;
        const bx = pl[3] as number;
        const by = pl[4] as number;
        const bz = pl[5] as number;
        let dx = ay * bz - az * by;
        let dy = az * bx - ax * bz;
        let dz = ax * by - ay * bx;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 0) {
          dx /= len;
          dy /= len;
          dz /= len;
        }
        const d = dx * this.vx + dy * this.vy + dz * this.vz;
        this.vx = dx * d;
        this.vy = dy * d;
        this.vz = dz * d;
      }
      if (this.vx * pvx + this.vy * pvy + this.vz * pvz <= 0) {
        this.vx = 0;
        this.vy = 0;
        this.vz = 0;
        break;
      }
    }
    if (allFraction === 0) {
      this.vx = 0;
      this.vy = 0;
      this.vz = 0;
    }
  }

  /** Source's ClipVelocity with overbounce 1: the velocity (ix, iy, iz) minus its part into the plane, once more if still into it. */
  private clip(ix: number, iy: number, iz: number, nx: number, ny: number, nz: number): void {
    const back = ix * nx + iy * ny + iz * nz;
    let ox = ix - nx * back;
    let oy = iy - ny * back;
    let oz = iz - nz * back;
    const adjust = ox * nx + oy * ny + oz * nz;
    if (adjust < 0) {
      ox -= nx * adjust;
      oy -= ny * adjust;
      oz -= nz * adjust;
    }
    this.vx = ox;
    this.vy = oy;
    this.vz = oz;
  }

  /** Source's WalkMove after the acceleration: a straight move if it is free, else StepMove; then StayOnGround. Returns whether StayOnGround found ground. */
  walkMove(dt: number): boolean {
    this.vz = 0;
    if (this.vx === 0 && this.vy === 0) return false;
    const dx = this.x + this.vx * dt;
    const dy = this.y + this.vy * dt;
    const t = this.trace(this.x, this.y, this.z, dx, dy, this.z);
    if (t.fraction === 1) {
      this.x = t.endX;
      this.y = t.endY;
      this.z = t.endZ;
      return this.stayOnGround();
    }
    this.stepMove(dt);
    return this.stayOnGround();
  }

  /**
   * Source's StepMove: slide along the floor, and slide again raised by a step (sv_stepsize) and put back down; keep
   * the one that went further, unless the raised one doesn't end on ground.
   */
  private stepMove(dt: number): void {
    const x0 = this.x;
    const y0 = this.y;
    const z0 = this.z;
    const vx0 = this.vx;
    const vy0 = this.vy;
    const vz0 = this.vz;
    const clipped0 = this.clipped;
    this.tryPlayerMove(dt);
    const downX = this.x;
    const downY = this.y;
    const downZ = this.z;
    const downVx = this.vx;
    const downVy = this.vy;
    const downVz = this.vz;
    const downClipped = this.clipped;
    this.x = x0;
    this.y = y0;
    this.z = z0;
    this.vx = vx0;
    this.vy = vy0;
    this.vz = vz0;
    this.clipped = clipped0;
    const step = this.m.stepSize + TRACE_SKIN;
    const up = this.trace(this.x, this.y, this.z, this.x, this.y, this.z + step);
    if (!up.startSolid && !up.allSolid) this.z = up.endZ;
    this.tryPlayerMove(dt);
    const down = this.trace(this.x, this.y, this.z, this.x, this.y, this.z - step);
    if (!this.standsOn(down)) {
      this.x = downX;
      this.y = downY;
      this.z = downZ;
      this.vx = downVx;
      this.vy = downVy;
      this.vz = downVz;
      this.clipped = downClipped;
      return;
    }
    if (!down.startSolid && !down.allSolid) {
      this.x = down.endX;
      this.y = down.endY;
      this.z = down.endZ;
    }
    const downDist = (downX - x0) * (downX - x0) + (downY - y0) * (downY - y0);
    const upDist = (this.x - x0) * (this.x - x0) + (this.y - y0) * (this.y - y0);
    if (downDist > upDist) {
      this.x = downX;
      this.y = downY;
      this.z = downZ;
      this.vx = downVx;
      this.vy = downVy;
      this.vz = downVz;
      this.clipped = downClipped;
    } else {
      this.vz = downVz;
    }
  }

  /**
   * Source's StayOnGround: from up to 2 units above, trace down a step; on walkable ground (not embedded) move onto it.
   * Returns true when it found walkable ground (the ground check then needn't trace again).
   */
  private stayOnGround(): boolean {
    const up = this.trace(this.x, this.y, this.z, this.x, this.y, this.z + GROUND_CHECK);
    const sx = up.endX;
    const sy = up.endY;
    const sz = up.endZ;
    const t = this.trace(sx, sy, sz, sx, sy, this.z - this.m.stepSize);
    if (t.fraction > 0 && t.fraction < 1 && !t.startSolid && this.standsOn(t)) {
      if (Math.abs(this.z - t.endZ) > STAY_EPS) {
        this.x = t.endX;
        this.y = t.endY;
        this.z = t.endZ;
      }
      return true;
    }
    return false;
  }

  /** Source's CategorizePosition: on the ground if not moving up fast and a 2-unit trace down hits walkable ground. */
  categorize(): void {
    if (this.vz > NON_JUMP_VELOCITY) {
      this.onGround = false;
      return;
    }
    const t = this.trace(this.x, this.y, this.z, this.x, this.y, this.z - GROUND_CHECK);
    this.onGround = this.standsOn(t);
    if (this.onGround) {
      this.vz = 0;
      // Settle onto it (GoldSrc's PM_CategorizePosition does; Source leaves it to StayOnGround, which needs a move).
      if (!t.startSolid) {
        this.x = t.endX;
        this.y = t.endY;
        this.z = t.endZ;
      }
    }
  }
}

/**
 * One 3D movement tick (Source's PlayerMove / FullWalkMove, docs/movement.md "3D movement"). `input` null = no command
 * (zero move, keep yaw/pitch, buttons released). Order:
 *
 * 1. Look; the landing penalty recovers (ReduceTimers); the fall speed is −vel.z if airborne.
 * 2. Duck (instant): DUCK crouches; in the air the feet tuck up by airDuckLift. Releasing it stands up if the standing
 *    hull fits (in the air, lowering the feet back if there is room below).
 * 3. Jump (CheckJumpButton): a fresh JUMP press on the ground leaves it with vel.z = jumpImpulse (CS2 jumps take off
 *    precisely: no half tick of gravity first, so the apex is impulse² / 2g at 64 Hz too).
 * 4. On the ground: vel.z = 0, friction, the landing penalty, ground acceleration (as `stepMove`) and WalkMove
 *    (straight, else StepMove, then StayOnGround). In the air: air acceleration (wish speed capped at airMaxWishSpeed)
 *    and TryPlayerMove between two half steps of gravity.
 * 5. Ground check (CategorizePosition). A landing adds the penalty and computes fall damage from the fall speed.
 */
export function stepMove3d(s: MoveState, input: MoveInput | null, weapon: string, g: MapGeometry, m: MovementTuning, dt: number = TICK_DT, opts: MoveOptions = NO_OPTIONS): MoveStep {
  const yaw = input === null ? s.yaw : input.yaw;
  const pitch = input === null ? s.pitch : input.pitch;
  const buttons = input === null ? [] : input.buttons;
  const wantDuck = buttons.includes('DUCK');
  const wantJump = buttons.includes('JUMP');
  const mv = new Mover(g, m);
  mv.x = s.pos.x;
  mv.y = s.pos.y;
  mv.z = s.pos.z;
  mv.vx = s.vel.x;
  mv.vy = s.vel.y;
  mv.vz = s.vel.z;
  mv.onGround = s.onGround;
  let stamina = Math.max(0, s.stamina - m.staminaRecoveryRate * dt);
  const fallSpeed = s.onGround ? 0 : -s.vel.z;

  // 2. Duck.
  let crouching = s.crouching;
  if (wantDuck && !crouching) {
    // The crouched hull at the tucked-up feet lies inside the standing hull, so it always fits.
    if (!mv.onGround) mv.z += m.airDuckLift;
    crouching = true;
  } else if (!wantDuck && crouching) {
    mv.hull = STANDING_HULL;
    if (mv.onGround) {
      if (!g.hullBlocked(mv.x, mv.y, mv.z, STANDING_HULL)) crouching = false;
    } else {
      const t = mv.trace(mv.x, mv.y, mv.z, mv.x, mv.y, mv.z - m.airDuckLift);
      if (!t.startSolid && t.fraction === 1) {
        mv.z = t.endZ;
        crouching = false;
      }
    }
  }
  mv.hull = hullOf(crouching);
  // Stuck in something (a teleport into a wall, a stance change): out to the nearest free spot first (CheckStuck).
  if (g.hullBlocked(mv.x, mv.y, mv.z, mv.hull)) {
    const out = unstick(g, { x: mv.x, y: mv.y, z: mv.z }, mv.hull);
    mv.x = out.x;
    mv.y = out.y;
    mv.z = out.z;
  }

  // 3. Jump.
  let jumped = false;
  if (wantJump && mv.onGround && !s.jumpHeld) {
    mv.onGround = false;
    // sv_enablebunnyhopping 0: the take-off speed is cropped to 1.1 × the item's max speed (as PreventBunnyJumping).
    const cap = BUNNYJUMP_MAX_SPEED_FACTOR * runSpeed(weapon, m, opts);
    const hs = Math.sqrt(mv.vx * mv.vx + mv.vy * mv.vy);
    if (hs > cap) {
      mv.vx *= cap / hs;
      mv.vy *= cap / hs;
    }
    mv.vz = m.jumpImpulse;
    jumped = true;
  }

  // 4. Move.
  let groundFound = false;
  if (mv.onGround) {
    const f = applyFriction({ x: mv.vx, y: mv.vy, z: 0 }, m, dt);
    let vx = f.x;
    let vy = f.y;
    if (stamina > 0) {
      const r = (100 - stamina) / 100;
      vx *= r;
      vy *= r;
    }
    const a = walkStop(input === null ? { x: vx, y: vy, z: 0 } : accelerate({ x: vx, y: vy, z: 0 }, wishFromInput(input, weapon, m, opts), m, dt));
    mv.vx = a.x;
    mv.vy = a.y;
    mv.vz = 0;
    mv.checkVelocity();
    groundFound = mv.walkMove(dt);
  } else {
    if (input !== null) {
      const w = wishFromInput(input, weapon, m, opts);
      if (w.speed > 0) {
        const cap = Math.min(w.speed, m.airMaxWishSpeed);
        const add = cap - (mv.vx * w.dirX + mv.vy * w.dirY);
        if (add > 0) {
          // m_surfaceFriction from the last ground check (CategorizePosition, before FinishGravity's half step): 0.25 if
          // it found no ground while moving up at ≤ 140 u/s. vz then was this state's vz + half a tick of gravity.
          const vzAtCheck = s.vel.z + (m.gravity * dt) / 2;
          const sf = !s.onGround && vzAtCheck > 0 && vzAtCheck <= NON_JUMP_VELOCITY ? AIR_RISE_SURFACE_FRICTION : 1;
          const accel = Math.min(m.airAccelerate * w.speed * dt * sf, add);
          mv.vx += accel * w.dirX;
          mv.vy += accel * w.dirY;
        }
      }
    }
    mv.vz -= (m.gravity * dt) / 2;
    mv.checkVelocity();
    mv.tryPlayerMove(dt);
  }

  // 5. Ground check, the second half of gravity, landing.
  const wasAirborne = !s.onGround || jumped;
  if (groundFound) {
    mv.onGround = true;
    mv.vz = 0;
  } else {
    mv.categorize();
  }
  if (!mv.onGround) mv.vz -= (m.gravity * dt) / 2;
  mv.checkVelocity();
  let landSpeed = 0;
  let fallDamage = 0;
  if (mv.onGround && wasAirborne && !jumped) {
    landSpeed = Math.max(0, fallSpeed);
    fallDamage = fallDamageFor(landSpeed, m);
    stamina = Math.min(m.staminaMax, stamina + m.staminaLandCost * landSpeed);
  }
  return {
    state: {
      pos: { x: mv.x, y: mv.y, z: mv.z },
      vel: { x: mv.vx, y: mv.vy, z: mv.vz },
      yaw,
      pitch,
      crouching,
      onGround: mv.onGround,
      jumpHeld: wantJump,
      stamina,
    },
    clipped: mv.clipped,
    jumped,
    landSpeed,
    fallDamage,
  };
}

/** `unstick`: offsets tried, nearest first (xy rings of 4 units out to 32, each at 0, +9, +18, −9, −18 in z). */
const UNSTICK_OFFSETS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (const dz of [0, 9, 18, -9, -18]) {
    for (let dy = -32; dy <= 32; dy += 4) for (let dx = -32; dx <= 32; dx += 4) if (dx * dx + dy * dy <= 32 * 32) out.push([dx, dy, dz]);
  }
  return out.sort((a, b) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2] - (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]) || a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
})();

/**
 * Source's CheckStuck, simplified: a hull at `pos` that cuts into the mesh is moved to the nearest free position
 * (UNSTICK_OFFSETS), or left where it is if there is none within reach. Returns the position (unchanged if free).
 */
export function unstick(g: MapGeometry, pos: Vec3, hull: Hull): Vec3 {
  if (!g.hullBlocked(pos.x, pos.y, pos.z, hull)) return pos;
  for (const [dx, dy, dz] of UNSTICK_OFFSETS) if (!g.hullBlocked(pos.x + dx, pos.y + dy, pos.z + dz, hull)) return { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
  return pos;
}

/**
 * Put a pawn that was placed (teleported, spawned) at `pos` on the floor: the hull is traced down from `up` units above
 * `pos` (or from where `unstick` frees it, if that is blocked) to `down` units below, and stands where it lands (on the
 * ground if that is walkable).
 */
export function settle(g: MapGeometry, pos: Vec3, crouching: boolean, m: MovementTuning, up = 18, down = 64): { pos: Vec3; onGround: boolean } {
  const hull = hullOf(crouching);
  let at = pos;
  let from = { x: pos.x, y: pos.y, z: pos.z + up };
  if (g.hullBlocked(from.x, from.y, from.z, hull)) {
    at = unstick(g, pos, hull);
    from = { x: at.x, y: at.y, z: at.z };
  }
  const t = g.traceBox(from, { x: at.x, y: at.y, z: at.z - down }, hull);
  return { pos: { x: t.endX, y: t.endY, z: t.endZ }, onGround: t.hit && t.normalZ >= m.standableNormal };
}

/**
 * Sub-tick input (CS2): a key change at `fraction` (0..1) of the tick splits the tick into two simulations, the first
 * `fraction × dt` with the input before the change, the rest with the input after it (docs/movement.md "Sub-tick").
 * `fraction` ≤ 0 or ≥ 1 is one plain `stepMove3d` tick (with `after` / `before`), bit-identical to the per-tick path.
 * The result's `jumped` / `landSpeed` / `fallDamage` / `clipped` merge both parts (a landing in the first part counts).
 */
export function stepMove3dSubtick(
  s: MoveState,
  before: MoveInput | null,
  after: MoveInput | null,
  fraction: number,
  weapon: string,
  g: MapGeometry,
  m: MovementTuning,
  dt: number = TICK_DT,
  opts: MoveOptions = NO_OPTIONS,
): MoveStep {
  if (!(fraction > 0)) return stepMove3d(s, after, weapon, g, m, dt, opts);
  if (!(fraction < 1)) return stepMove3d(s, before, weapon, g, m, dt, opts);
  const a = stepMove3d(s, before, weapon, g, m, dt * fraction, opts);
  const b = stepMove3d(a.state, after, weapon, g, m, dt * (1 - fraction), opts);
  return {
    state: b.state,
    clipped: a.clipped || b.clipped,
    jumped: a.jumped || b.jumped,
    landSpeed: Math.max(a.landSpeed, b.landSpeed),
    fallDamage: a.fallDamage + b.fallDamage,
  };
}
