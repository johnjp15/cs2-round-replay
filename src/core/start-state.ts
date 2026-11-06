/**
 * Tick-0 setup: the actions that put every pawn where, and as, the recording starts.
 * See docs/core.md "Start state".
 */
import type { Action, Ammo, ItemId, PlayerId, Tuning, WeaponId } from '../contracts/index';
import type { ModelPlayer, RoundModel } from './round-model';

/** How far ahead (ticks) the motion rule looks for the first sample that has moved. 1.0 s. */
export const MOTION_LOOKAHEAD_TICKS = 64;
/** A sample counts as "moved" when it is more than this far (2D, world units) from the start position. */
export const MOTION_MIN_DIST = 8;
/** Computed yaws are rounded to 1 / YAW_SCALE degrees (0.001°) so atan2 ulp differences never reach the log. */
const YAW_SCALE = 1000;

/**
 * Pairs that start facing each other: snarlbot kills incredibad 0.5 s in, and
 * incredibad's spot was chosen to be in snarlbot's line of sight in Palace Alley.
 */
export const FACING_PAIRS: readonly (readonly [PlayerId, PlayerId])[] = [['snarlbot', 'incredibad']];

export type StartYawSource = 'recorded' | 'facing' | 'motion' | 'default';

export interface StartYaw {
  /** Degrees CCW from +x, in (-180, 180]. */
  readonly yaw: number;
  readonly source: StartYawSource;
}

/**
 * Start yaw, first rule that applies:
 * 1. `recorded`: the round's `start.yaw` (only eradicate has one).
 * 2. `facing`: a FACING_PAIRS member faces the other member's start position.
 * 3. `motion`: the bearing from the start position to the first track sample within
 *    the next MOTION_LOOKAHEAD_TICKS that is more than MOTION_MIN_DIST away (2D).
 * 4. `default`: 0 (east) when the track does not move that far in that time.
 * Bearings are `atan2(dy, dx)` in degrees, rounded to 0.001°.
 */
export function startYaw(model: RoundModel, id: PlayerId): StartYaw {
  const p = model.player(id);
  if (p.startYaw !== null) return { yaw: p.startYaw, source: 'recorded' };
  for (const [a, b] of FACING_PAIRS) {
    const other = id === a ? b : id === b ? a : null;
    if (other !== null) {
      const q = model.player(other).startPos;
      return { yaw: bearing(p.startPos.x, p.startPos.y, q.x, q.y), source: 'facing' };
    }
  }
  const samples = model.track(id);
  const s0 = samples[0];
  if (s0 !== undefined) {
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      if (s === undefined || s.tick - s0.tick > MOTION_LOOKAHEAD_TICKS) break;
      const dx = s.x - p.startPos.x;
      const dy = s.y - p.startPos.y;
      if (dx * dx + dy * dy > MOTION_MIN_DIST * MOTION_MIN_DIST) return { yaw: bearing(p.startPos.x, p.startPos.y, s.x, s.y), source: 'motion' };
    }
  }
  return { yaw: 0, source: 'default' };
}

/**
 * The tick-0 setup actions. For each player in id order:
 * `teleport {pos, yaw}`, `set_hp {hp, armor, helmet}`, one `give` per item
 * (primary, secondary, each grenade, `c4`, `defuser`), then `set_weapon` to the
 * primary (the secondary when there is none; `knife` when neither).
 *
 * The weapon drawn at t = 0 gets the round's `kit.clip/reserve`; any other gun gets
 * `tuning.weapons[id].clip/reserve`. Grenades, c4 and the defuser are given with
 * clip = reserve = 0. Every pawn has a knife without a give.
 */
export function startActions(model: RoundModel, tuning: Tuning): Action[] {
  const out: Action[] = [];
  for (const p of model.players) {
    out.push({ type: 'teleport', id: p.id, pos: p.startPos, yaw: startYaw(model, p.id).yaw });
    out.push({ type: 'set_hp', id: p.id, hp: p.hp, armor: p.armor, helmet: p.helmet });
    const k = p.kit;
    const drawn = k.primary ?? k.secondary;
    if (k.primary !== null) out.push(giveGun(p, k.primary, drawn, tuning));
    if (k.secondary !== null) out.push(giveGun(p, k.secondary, drawn, tuning));
    for (const g of k.grenades) out.push(giveItem(p.id, g));
    if (k.c4) out.push(giveItem(p.id, 'c4'));
    if (k.kit) out.push(giveItem(p.id, 'defuser'));
    out.push({ type: 'set_weapon', id: p.id, weapon: drawn ?? 'knife' });
  }
  return out;
}

function giveGun(p: ModelPlayer, weapon: WeaponId, drawn: WeaponId | null, tuning: Tuning): Action {
  const ammo = weapon === drawn ? { clip: p.kit.clip, reserve: p.kit.reserve } : tunedAmmo(weapon, tuning);
  return { type: 'give', id: p.id, item: weapon, clip: ammo.clip, reserve: ammo.reserve };
}

function giveItem(id: PlayerId, item: ItemId): Action {
  return { type: 'give', id, item, clip: 0, reserve: 0 };
}

function tunedAmmo(weapon: WeaponId, tuning: Tuning): Ammo {
  const w = tuning.weapons[weapon];
  if (w === undefined) throw new Error(`startActions: no tuning.weapons.${weapon} for its clip/reserve`);
  return { clip: w.clip, reserve: w.reserve };
}

/** Bearing from (x0, y0) to (x1, y1) in degrees CCW from +x, (-180, 180], rounded to 0.001°. */
function bearing(x0: number, y0: number, x1: number, y1: number): number {
  const deg = Math.round(((Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI) * YAW_SCALE) / YAW_SCALE;
  return deg <= -180 ? deg + 360 : deg;
}
