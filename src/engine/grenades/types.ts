/**
 * Types for the CS2 grenade engine (docs/grenades.md). Plain data only: the whole `GrenadeState` is JSON, so a host
 * can snapshot it for checkpoints and rewind. Positions are Source units in the map's world frame (z up); a pawn's
 * `pos` is its feet. Angles are degrees in the Source convention (pitch + = down, yaw counter-clockwise from +x).
 */
import type { GrenadeCs2Tuning, Team, Vec3 } from '../../contracts/index';

export type GrenadeType = 'smoke' | 'flash' | 'he' | 'molotov' | 'incendiary' | 'decoy';

export const GRENADE_TYPES: readonly GrenadeType[] = ['smoke', 'flash', 'he', 'molotov', 'incendiary', 'decoy'];

/** Result of sweeping the grenade's box through the world (Source `UTIL_TraceHull`). */
export interface HullTrace {
  /** Free fraction of the move, 0..1 (1 = no hit). */
  readonly fraction: number;
  readonly hit: boolean;
  /** Unit surface normal pointing back at the box; (0, 0, 0) without a hit. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** The start box already overlaps the world. */
  readonly startSolid: boolean;
  /** ... and the end box too (stuck). */
  readonly allSolid: boolean;
}

/**
 * The world queries the engine needs. A host implements them on its collision (the Mirage mesh via
 * `src/sim2d/geometry.ts` in the tests, CS2's `TraceShape` in the port). Players are not part of the world:
 * the engine collides grenades with the pawns it is given.
 */
export interface GrenadeWorld {
  /** Sweep the axis-aligned box centred at c with half extent `half` by d. */
  traceHull(cx: number, cy: number, cz: number, half: number, dx: number, dy: number, dz: number): HullTrace;
  /** First crossing of segment a → b with the world as a fraction in (0, 1]; 1 = clear. */
  traceLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number;
}

/** A pawn as the grenade engine sees it, given to every step (sorted by id). */
export interface GrenadePawn {
  readonly id: string;
  readonly team: Team;
  readonly alive: boolean;
  /** Feet position. */
  readonly pos: Vec3;
  /** Hull height (72 standing, 54 crouched); the hull is ±16 in x and y. */
  readonly height: number;
  /** Eye position. */
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
}

/** A throw, as the host's weapon code releases it. */
export interface ThrowRequest {
  readonly type: GrenadeType;
  readonly thrower: string;
  readonly team: Team;
  /** Eye position at release (or at the jump-throw latch; see `jumpThrowPose`). */
  readonly eye: Vec3;
  readonly pitch: number;
  readonly yaw: number;
  /** 1 = full (ATTACK), 0 = underhand (ATTACK2), 0.5 = both buttons. */
  readonly strength: number;
  /** The thrower's velocity at release (units/s). */
  readonly velocity: Vec3;
  /** Decoy only: the interval of the thrower's weapon that the fake shots imitate (seconds); 0 = the tuning default. */
  readonly decoyShotIntervalSec?: number;
}

/** A grenade in flight or at rest before it detonates. */
export interface Projectile {
  readonly seq: number;
  readonly type: GrenadeType;
  readonly thrower: string;
  readonly team: Team;
  readonly throwTick: number;
  pos: Vec3;
  vel: Vec3;
  atRest: boolean;
  bounces: number;
  /** Next tick a smoke / decoy checks whether it has come to rest. */
  nextCheckTick: number;
  readonly decoyShotIntervalSec: number;
  /** Positions at the end of every tick so far (for renderers and lineup tests). */
  path: Vec3[];
}

/** One smoke voxel: grid index, the tick it appears, and the tick a bullet hole in it closes. */
export interface SmokeCell {
  readonly index: number;
  readonly appearTick: number;
  holeUntilTick: number;
}

/** A detonated smoke: a flood-filled voxel volume. */
export interface Smoke {
  readonly seq: number;
  readonly thrower: string;
  readonly team: Team;
  readonly center: Vec3;
  readonly popTick: number;
  /** Density 1 until fadeTick, then linear to 0 at endTick. */
  readonly fadeTick: number;
  readonly endTick: number;
  /** Grid minimum corner (world units) and cells per axis; cell (i, j, k) has index i + n·j + n²·k. */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly cells: SmokeCell[];
  /** index → position in `cells`, as a sorted parallel array for binary search. */
  readonly sortedIndex: number[];
  readonly sortedSlot: number[];
}

/** An HE blast remembered for the smoke holes it makes. */
export interface HeHole {
  readonly pos: Vec3;
  readonly tick: number;
}

export interface Flame {
  readonly pos: Vec3;
  readonly depth: number;
  readonly bornTick: number;
  readonly dieTick: number;
  children: number;
}

/** A burning molotov / incendiary. */
export interface Inferno {
  readonly seq: number;
  readonly type: 'molotov' | 'incendiary';
  readonly thrower: string;
  readonly team: Team;
  readonly center: Vec3;
  readonly popTick: number;
  /** Horizontal spread bias from the grenade's velocity at the burst (× inferno_velocity_factor). */
  readonly biasX: number;
  readonly biasY: number;
  flames: Flame[];
  /** Spawn attempts so far, the next attempt's tick and interval (seconds). */
  attempts: number;
  nextSpawnTick: number;
  spawnInterval: number;
  /** Damage steps dealt so far. */
  damageSteps: number;
}

export interface Decoy {
  readonly seq: number;
  readonly thrower: string;
  readonly team: Team;
  readonly pos: Vec3;
  readonly popTick: number;
  readonly endTick: number;
  /** Ticks of the remaining fake shots, ascending. */
  shots: number[];
}

/** The whole grenade state. JSON-serializable. */
export interface GrenadeState {
  readonly seed: number;
  /** The tick the next `stepGrenades` call simulates. */
  tick: number;
  nextSeq: number;
  projectiles: Projectile[];
  smokes: Smoke[];
  infernos: Inferno[];
  decoys: Decoy[];
  heHoles: HeHole[];
}

/** Engine configuration: the tuning (`grenades.cs2`). */
export interface GrenadeConfig {
  readonly tuning: GrenadeCs2Tuning;
}

export interface StepInput {
  /** All pawns (sorted by id); dead ones are ignored. */
  readonly pawns: readonly GrenadePawn[];
  /** mp_friendlyfire: false = grenades never hurt the thrower's teammates (the thrower is always hurt). */
  readonly friendlyFire: boolean;
}

export type GrenadeEvent =
  | { readonly type: 'thrown'; readonly tick: number; readonly seq: number; readonly grenade: GrenadeType; readonly thrower: string; readonly pos: Vec3; readonly vel: Vec3 }
  | { readonly type: 'bounce'; readonly tick: number; readonly seq: number; readonly pos: Vec3; readonly pawn: string | null }
  | { readonly type: 'rest'; readonly tick: number; readonly seq: number; readonly pos: Vec3 }
  | { readonly type: 'detonate'; readonly tick: number; readonly seq: number; readonly grenade: GrenadeType; readonly thrower: string; readonly pos: Vec3 }
  /** Raw damage before armor: the host applies the CS2 armor rule with `armorPen` (= armor ratio × 0.5) and tagging with the flinch modifiers. */
  | {
      readonly type: 'hurt';
      readonly tick: number;
      readonly seq: number;
      readonly grenade: GrenadeType;
      readonly thrower: string;
      readonly victim: string;
      readonly damage: number;
      readonly armorPen: number;
      readonly flinchSmall: number;
      readonly flinchLarge: number;
    }
  | { readonly type: 'blind'; readonly tick: number; readonly seq: number; readonly thrower: string; readonly victim: string; readonly blind: Blind }
  | { readonly type: 'smoke_start'; readonly tick: number; readonly seq: number; readonly pos: Vec3; readonly voxels: number }
  | { readonly type: 'smoke_end'; readonly tick: number; readonly seq: number }
  | { readonly type: 'fire_start'; readonly tick: number; readonly seq: number; readonly pos: Vec3 }
  | { readonly type: 'no_fire'; readonly tick: number; readonly seq: number; readonly reason: 'airburst' | 'smoke' }
  | { readonly type: 'fire_end'; readonly tick: number; readonly seq: number; readonly reason: 'burnt_out' | 'smoked' }
  | { readonly type: 'decoy_shot'; readonly tick: number; readonly seq: number; readonly thrower: string; readonly pos: Vec3 }
  | { readonly type: 'decoy_explode'; readonly tick: number; readonly seq: number; readonly thrower: string; readonly pos: Vec3 };

/** A flash on one pawn: full white `maxAlpha` until `startTick + hold`, then a linear fade to 0 at `startTick + fade`. */
export interface Blind {
  readonly startTick: number;
  readonly holdSec: number;
  readonly fadeSec: number;
  /** 0..1 */
  readonly maxAlpha: number;
}
