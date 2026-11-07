/**
 * W2: weapons lying in the world (dropped on death, thrown with G, swapped out by a pickup) and the human's pickup.
 * Pure functions over plain data (Sim3DHost keeps the list in its state and snapshots), deterministic, rounded to the
 * log's 6 decimals every tick like the pawns. docs/sim3d.md "World items".
 *
 * CS2 / Source rules used (cited in docs/sim3d.md):
 * - **Death** (`mp_death_drop_gun 1`, the default): the dead player's most valuable gun drops (price from the weapon
 *   table; on a tie the primary). The C4 drops too (src/sim2d/bomb.ts, as before). Grenades, the defuser and the
 *   knife stay with the body here.
 * - **Drop** (`drop`, G): the active gun leaves from the eye − 12 units (Source `Weapon_Drop`:
 *   `Weapon_ShootPosition() - Vector(0,0,12)`) at 400 u/s along the view (`BodyDirection3D() * 400`), then falls
 *   under `sv_gravity` 800 and comes to rest on the first floor it hits (walls bounce it back, damped). The knife
 *   can't be dropped (`mp_drop_knife_enable 0`); grenades and the C4 aren't dropped by G here.
 * - **Pickup** (`+use`, E): the item nearest the view line among those within `PLAYER_USE_RADIUS` (80 units) of the
 *   eye and within `dot ≥ 0.8` of the view (Source `CBasePlayer::FindUseEntity`), in plain sight. A full slot swaps:
 *   the old gun is dropped as by G. The picked gun is drawn.
 * - **Touch**: walking over a gun whose slot is empty picks it up without drawing it (CS2's weapon touch), except
 *   one the same pawn dropped in the last second (an assumption: CS2 doesn't hand a just-dropped gun straight back).
 * Only the human picks up; puppets keep the tape (a scripted pickup takes the gun nearest to it, `takeNearest`).
 */
import { roundNumber, type PlayerId, type Vec3, type WeaponId } from '../contracts/index';
import type { MapGeometry } from '../sim2d/geometry';

export interface WorldItem {
  /** Unique, in spawn order (the renderer keys meshes on it). */
  readonly seq: number;
  readonly item: WeaponId;
  readonly clip: number;
  readonly reserve: number;
  /** Centre of the item. */
  pos: Vec3;
  vel: Vec3;
  /** Degrees CCW from +x: the dropper's yaw. */
  readonly yaw: number;
  resting: boolean;
  /** Who dropped it (null: placed) and on which tick (the touch-pickup delay). */
  readonly dropper: PlayerId | null;
  readonly dropTick: number;
}

/** Source `PLAYER_USE_RADIUS` (baseplayer_shared.h): how far from the eye +use reaches. */
export const USE_RADIUS = 80;
/** Source `FindUseEntity`: the least dot product between the view and the direction to a usable entity. */
export const USE_MIN_DOT = 0.8;
/** Source `Weapon_Drop`: a player's dropped weapon starts this far below the eye, thrown at this speed. */
export const DROP_BELOW_EYE = 12;
export const DROP_SPEED = 400;
/** `sv_gravity` (CS2 default). */
export const ITEM_GRAVITY = 800;
/** Half extents of an item's collision box (units): a gun lying on the floor. */
export const ITEM_HALF = 2;
/** Velocity kept along a wall's normal after a bounce (the rest of that component is lost). */
const BOUNCE = 0.3;
/** A surface with a normal this upright stops the item (it lies there). */
const REST_NZ = 0.7;
/** A flight that has not landed after this many ticks is put on the floor below (no item flies for ever). */
const MAX_FLIGHT_TICKS = 4 * 64;
/** Ticks before a pawn can touch-pick a gun it dropped itself (assumption, see the header). */
export const TOUCH_DELAY_TICKS = 64;
/** Touch reach: the standing hull's half width (16) plus the item's. */
export const TOUCH_RADIUS = 16 + ITEM_HALF;
/** Touch reach in height: the standing hull (72). */
const TOUCH_HEIGHT = 72;

/** Guns by CS2 slot (1 primary, 2 pistol). Only guns become world items. */
export const PRIMARY_GUNS: readonly WeaponId[] = ['ak47', 'm4a4', 'awp', 'ssg08'];
export const PISTOLS: readonly WeaponId[] = ['deagle', 'glock', 'usps'];

/** 1 primary, 2 pistol, null: not a gun (knife, grenades, c4). */
export function gunSlot(item: string): 1 | 2 | null {
  if ((PRIMARY_GUNS as readonly string[]).includes(item)) return 1;
  if ((PISTOLS as readonly string[]).includes(item)) return 2;
  return null;
}

/** Unit view direction (yaw CCW from +x, pitch positive down: Source). */
export function viewDir(yaw: number, pitch: number): Vec3 {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
}

/** The gun a dead pawn drops (`mp_death_drop_gun 1`): the most valuable gun carried (ties: the primary), or null. */
export function deathDropGun(items: readonly string[], price: (item: WeaponId) => number): WeaponId | null {
  let best: WeaponId | null = null;
  let bestPrice = -1;
  for (const slot of [PRIMARY_GUNS, PISTOLS]) {
    for (const g of slot) {
      if (!items.includes(g)) continue;
      const v = price(g);
      if (v > bestPrice) {
        best = g;
        bestPrice = v;
      }
    }
  }
  return best;
}

/** A new item thrown from `eye` (the dropper's eye) with velocity `vel`. */
export function spawnItem(seq: number, item: WeaponId, clip: number, reserve: number, eye: Vec3, vel: Vec3, yaw: number, dropper: PlayerId | null, tick: number): WorldItem {
  return {
    seq,
    item,
    clip,
    reserve,
    pos: roundVec({ x: eye.x, y: eye.y, z: eye.z - DROP_BELOW_EYE }),
    vel: roundVec(vel),
    yaw: roundNumber(yaw),
    resting: false,
    dropper,
    dropTick: tick,
  };
}

/**
 * One tick of item physics: gravity, a box sweep on the world mesh, rest on a floor, bounce off walls. Items at rest
 * don't move. Returns new objects for moved items (the others are kept as they are).
 */
export function stepItems(items: readonly WorldItem[], world: MapGeometry, tick: number, dt: number): WorldItem[] {
  return items.map((it) => (it.resting ? it : stepOne(it, world, tick, dt)));
}

function stepOne(it: WorldItem, world: MapGeometry, tick: number, dt: number): WorldItem {
  if (tick - it.dropTick >= MAX_FLIGHT_TICKS) return settleItem(it, world);
  const vz = it.vel.z - ITEM_GRAVITY * dt;
  let vel = { x: it.vel.x, y: it.vel.y, z: vz };
  const d = { x: vel.x * dt, y: vel.y * dt, z: vel.z * dt };
  const tr = world.traceAabb(it.pos.x, it.pos.y, it.pos.z, ITEM_HALF, ITEM_HALF, ITEM_HALF, d.x, d.y, d.z);
  const pos = { x: tr.endX, y: tr.endY, z: tr.endZ };
  if (!tr.hit) return { ...it, pos: roundVec(pos), vel: roundVec(vel) };
  if (tr.normalZ >= REST_NZ) return { ...it, pos: roundVec(pos), vel: { x: 0, y: 0, z: 0 }, resting: true };
  // A wall (or a ceiling): lose the velocity into it but a little bounce.
  const vn = vel.x * tr.normalX + vel.y * tr.normalY + vel.z * tr.normalZ;
  if (vn < 0) vel = { x: vel.x - (1 + BOUNCE) * vn * tr.normalX, y: vel.y - (1 + BOUNCE) * vn * tr.normalY, z: vel.z - (1 + BOUNCE) * vn * tr.normalZ };
  return { ...it, pos: roundVec(pos), vel: roundVec(vel) };
}

/** Put an item on the floor under it, at rest. */
export function settleItem(it: WorldItem, world: MapGeometry): WorldItem {
  const f = world.floorBelow(it.pos.x, it.pos.y, it.pos.z, ITEM_HALF, ITEM_HALF);
  const z = f === null ? it.pos.z : f.z + ITEM_HALF;
  return { ...it, pos: roundVec({ x: it.pos.x, y: it.pos.y, z }), vel: { x: 0, y: 0, z: 0 }, resting: true };
}

/**
 * The item +use picks from `eye` looking along `dir` (Source FindUseEntity's radius rule): within USE_RADIUS of the
 * eye, at least USE_MIN_DOT off the view, not behind a wall; the one nearest the view line (ties: lower seq). Index
 * into `items`, or −1.
 */
export function useTarget(items: readonly WorldItem[], eye: Vec3, dir: Vec3, world: MapGeometry): number {
  let best = -1;
  let bestDist = Infinity;
  items.forEach((it, i) => {
    const dx = it.pos.x - eye.x;
    const dy = it.pos.y - eye.y;
    const dz = it.pos.z - eye.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > USE_RADIUS) return;
    if (len > 1e-6) {
      const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / len;
      if (dot < USE_MIN_DOT) return;
    }
    // Distance from the item to the view line.
    const along = dx * dir.x + dy * dir.y + dz * dir.z;
    const dist = Math.sqrt(Math.max(0, len * len - along * along));
    if (dist >= bestDist) return;
    // Seen: the line from the eye to just short of the item's top is clear.
    const top = { x: it.pos.x, y: it.pos.y, z: it.pos.z + ITEM_HALF };
    if (world.traceLine(eye.x, eye.y, eye.z, top.x, top.y, top.z, true) < 1) return;
    best = i;
    bestDist = dist;
  });
  return best;
}

/** Items a pawn standing at `feet` touches (its hull reaches them), in list order. */
export function touched(items: readonly WorldItem[], feet: Vec3): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (Math.abs(it.pos.x - feet.x) > TOUCH_RADIUS || Math.abs(it.pos.y - feet.y) > TOUCH_RADIUS) return;
    if (it.pos.z < feet.z - ITEM_HALF - 1 || it.pos.z > feet.z + TOUCH_HEIGHT) return;
    out.push(i);
  });
  return out;
}

/** A scripted pickup (the tape's `give` to a puppet): the index of the item of that kind nearest `pos` within `range`, or −1. */
export function takeNearest(items: readonly WorldItem[], item: string, pos: Vec3, range: number): number {
  let best = -1;
  let bestD = range;
  items.forEach((it, i) => {
    if (it.item !== item) return;
    const d = Math.hypot(it.pos.x - pos.x, it.pos.y - pos.y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

function roundVec(v: Vec3): Vec3 {
  return { x: roundNumber(v.x), y: roundNumber(v.y), z: roundNumber(v.z) };
}
