/**
 * Weapons for the 2D sim: the gun table (`Tuning.weapons`), the CS damage formula, and the per-pawn
 * fire / reload / deploy / grenade-throw state machine. Pure functions over plain data at 64 Hz.
 * Values, sources and rounding rules: docs/combat.md.
 */
import { roundNumber, type Ammo, type DamageTuning, type Hitgroup, type Tuning, type WeaponId, type WeaponTuning } from '../contracts/index';
import { TICKS_PER_SEC } from './movement';

/** Slack for comparing fractional tick times with integer ticks (times are rounded to 6 decimals). */
const TICK_EPS = 1e-9;

/** Grenade items, sorted. */
export const GRENADE_KINDS = ['flash', 'he', 'molotov', 'smoke'] as const;
export type GrenadeKind = (typeof GRENADE_KINDS)[number];

/** Guns by slot, used to pick what to hold after the last grenade is thrown (game rule, not calibration). */
const PRIMARY_GUNS: readonly WeaponId[] = ['ak47', 'awp', 'm4a4', 'ssg08'];
const SECONDARY_GUNS: readonly WeaponId[] = ['deagle', 'glock'];

export function isGrenade(item: string): item is GrenadeKind {
  return (GRENADE_KINDS as readonly string[]).includes(item);
}

/** Gun stats for an item, or null for anything that does not shoot (knife, c4, grenades, defuser). */
export function gunStats(item: string, tuning: Pick<Tuning, 'weapons'>): WeaponTuning | null {
  return tuning.weapons[item] ?? null;
}

/** Seconds from switching to `item` until it can be used. */
export function deploySec(item: string, tuning: Pick<Tuning, 'weapons' | 'grenades' | 'damage'>): number {
  const gun = gunStats(item, tuning);
  if (gun !== null) return gun.deploySec;
  if (isGrenade(item)) return tuning.grenades.deploySec;
  return tuning.damage.defaultDeploySec;
}

/** Ticks between shots: 64 × 60 / rpm (fractional; AK-47 6.4). */
export function cycleTicks(gun: WeaponTuning): number {
  return (TICKS_PER_SEC * 60) / gun.rpm;
}

/** What to hold when the held grenade is gone: the first primary, else secondary, else knife. */
export function fallbackWeapon(items: readonly string[]): WeaponId {
  for (const g of PRIMARY_GUNS) if (items.includes(g)) return g;
  for (const g of SECONDARY_GUNS) if (items.includes(g)) return g;
  return 'knife';
}

/** True if `t` (fractional tick) has been reached at integer tick `tick`. */
export function reached(tick: number, t: number): boolean {
  return tick + TICK_EPS >= t;
}

// ---- damage -------------------------------------------------------------------------------------

/** HP and armor a hit removes (integers; HP not yet capped at the victim's health). */
export interface HitDamage {
  readonly health: number;
  readonly armor: number;
}

/**
 * Damage before armor: base × rangeModifier^(distance / falloffUnits) × mult (CS FireBullet + TraceAttack).
 * `mult` is the hitgroup multiplier (see hitgroupMult).
 */
export function rawDamage(base: number, rangeModifier: number, distance: number, mult: number, d: Pick<DamageTuning, 'falloffUnits'>): number {
  return base * Math.pow(rangeModifier, distance / d.falloffUnits) * mult;
}

/** Multiplier for a hitgroup: the weapon's headshotMult for the head, else `damage.hitgroupMult`. */
export function hitgroupMult(hitgroup: Hitgroup, headshotMult: number, d: Pick<DamageTuning, 'hitgroupMult'>): number {
  if (hitgroup === 'head') return headshotMult;
  return d.hitgroupMult[hitgroup] ?? 1;
}

/** CS IsArmored: the head only with a helmet, legs never, everything else (chest, stomach, arms, neck, blast) always. */
export function isArmored(hitgroup: Hitgroup, helmet: boolean): boolean {
  if (hitgroup === 'head') return helmet;
  return hitgroup !== 'leg';
}

/**
 * CS armor and integer rounding (cs_player.cpp OnTakeDamage), for damage `damage` (after falloff and
 * hitgroup) against `armor`:
 * - not armored or armor ≤ 0: health = trunc(damage), armor 0;
 * - else toHealth = damage × armorPen, toArmor = (damage − toHealth) × armorBonus; if toArmor > armor:
 *   toHealth = damage − armor / armorBonus, toArmor = armor;
 *   health = trunc(toHealth); new armor = trunc(armor − toArmor) (int −= float), armor removed = armor − new armor.
 * Intermediate values are rounded to 6 decimals before truncating so tiny floating-point differences
 * between JS engines (Math.pow) cannot move a result across an integer.
 */
export function armorDamage(damage: number, armorPen: number, armor: number, armored: boolean, d: Pick<DamageTuning, 'armorBonus'>): HitDamage {
  if (!armored || armor <= 0) return { health: Math.trunc(roundNumber(damage)), armor: 0 };
  let toHealth = damage * armorPen;
  let toArmor = (damage - toHealth) * d.armorBonus;
  if (toArmor > armor) {
    toHealth = damage - armor / d.armorBonus;
    toArmor = armor;
  }
  const newArmor = Math.max(0, Math.trunc(roundNumber(armor - toArmor)));
  return { health: Math.max(0, Math.trunc(roundNumber(toHealth))), armor: armor - newArmor };
}

/** One bullet: falloff, hitgroup multiplier, armor (helmet for the head) and rounding. */
export function bulletDamage(gun: WeaponTuning, distance: number, hitgroup: Hitgroup, armor: number, helmet: boolean, d: DamageTuning): HitDamage {
  const dmg = rawDamage(gun.damage, gun.rangeModifier, distance, hitgroupMult(hitgroup, gun.headshotMult, d), d);
  return armorDamage(dmg, gun.armorPen, armor, isArmored(hitgroup, helmet), d);
}

// ---- weapon state machine ------------------------------------------------------------------------

/** Per-pawn weapon timers and trigger state (plain data, snapshotted). Times are fractional ticks. */
export interface WeaponState {
  /** The held gun may fire at or after this tick (fire cadence and deploy). */
  nextAttackTick: number;
  /** The held item is usable at or after this tick. */
  deployEndTick: number;
  /** A reload in progress completes at this tick; null = not reloading. */
  reloadEndTick: number | null;
  /** A semi-automatic gun already fired during the current ATTACK press. */
  shotThisPress: boolean;
  /** A grenade's pin is pulled (ATTACK pressed while deployed); releasing ATTACK throws it. */
  grenadePrimed: boolean;
}

export function freshWeaponState(): WeaponState {
  return { nextAttackTick: 0, deployEndTick: 0, reloadEndTick: null, shotThisPress: false, grenadePrimed: false };
}

/** State after switching to an item at `tick`: deploy timer started, reload and grenade cancelled. */
export function deployState(s: WeaponState, tick: number, deploySeconds: number): WeaponState {
  const end = roundNumber(tick + deploySeconds * TICKS_PER_SEC);
  return { ...s, nextAttackTick: end, deployEndTick: end, reloadEndTick: null, grenadePrimed: false, shotThisPress: false };
}

export interface WeaponStepInput {
  readonly tick: number;
  readonly item: string;
  /** Ammo of the held item (guns), or null. */
  readonly ammo: Ammo | null;
  /** Gun stats of the held item, or null for non-guns. */
  readonly gun: WeaponTuning | null;
  readonly attack: boolean;
  readonly reload: boolean;
  /** CS2 since March 2026: a reload throws away the rounds left in the magazine. */
  readonly discardMagazine: boolean;
}

export interface WeaponStep {
  readonly state: WeaponState;
  readonly ammo: Ammo | null;
  /** A bullet left the barrel this tick. */
  readonly fired: boolean;
  readonly reloadStarted: boolean;
  readonly reloadDone: boolean;
  /** The held grenade was released this tick. */
  readonly thrown: boolean;
}

/**
 * One tick of the held item, in this order:
 * 1. A reload whose end tick has come refills the magazine (from reserve; or a fresh magazine when
 *    `discardMagazine`).
 * 2. Fire: ATTACK held, deployed, not reloading, cycle ready, clip > 0, and for semi-automatic guns no
 *    shot yet in this press. Held fire keeps the fractional cadence: the next shot is due at the previous
 *    due time + 64 × 60 / rpm when the previous shot was fired within one tick of being due (so a held
 *    AK fires at ticks ⌈0⌉, ⌈6.4⌉, ⌈12.8⌉, …), else at the firing tick + the cycle.
 * 3. Reload start, if nothing was fired: RELOAD held with a magazine that is not full, or an empty
 *    magazine once the cycle is ready (auto reload); reserve must be > 0.
 * 4. Grenades: ATTACK while deployed pulls the pin; releasing ATTACK with the pin pulled throws.
 * Knife, c4 and other items do nothing here.
 */
export function stepWeapon(s: WeaponState, inp: WeaponStepInput): WeaponStep {
  const t = inp.tick;
  let state: WeaponState = { ...s };
  let ammo: Ammo | null = inp.ammo === null ? null : { clip: inp.ammo.clip, reserve: inp.ammo.reserve };
  let fired = false;
  let reloadStarted = false;
  let reloadDone = false;
  let thrown = false;
  const deployed = reached(t, state.deployEndTick);

  if (inp.gun !== null && ammo !== null) {
    const gun = inp.gun;
    if (state.reloadEndTick !== null && reached(t, state.reloadEndTick)) {
      const clip = inp.discardMagazine ? 0 : ammo.clip;
      const moved = Math.max(0, Math.min(gun.clip - clip, ammo.reserve));
      ammo = { clip: clip + moved, reserve: ammo.reserve - moved };
      state = { ...state, reloadEndTick: null };
      reloadDone = true;
    }
    const cycleReady = reached(t, state.nextAttackTick);
    const reloading = state.reloadEndTick !== null;
    if (inp.attack && deployed && !reloading && cycleReady && ammo.clip > 0 && (gun.automatic || !state.shotThisPress)) {
      const base = state.nextAttackTick > t - 1 ? state.nextAttackTick : t;
      state = { ...state, nextAttackTick: roundNumber(base + cycleTicks(gun)), shotThisPress: true };
      ammo = { clip: ammo.clip - 1, reserve: ammo.reserve };
      fired = true;
    }
    if (!fired && deployed && !reloading && ammo.reserve > 0 && ammo.clip < gun.clip) {
      if (inp.reload || (ammo.clip === 0 && reached(t, state.nextAttackTick))) {
        state = { ...state, reloadEndTick: roundNumber(t + gun.reloadSec * TICKS_PER_SEC) };
        reloadStarted = true;
      }
    }
  } else if (isGrenade(inp.item)) {
    if (inp.attack && deployed) {
      state = { ...state, grenadePrimed: true };
    } else if (!inp.attack && state.grenadePrimed) {
      state = { ...state, grenadePrimed: false };
      thrown = true;
    }
  }
  if (!inp.attack) state = { ...state, shotThisPress: false };
  return { state, ammo, fired, reloadStarted, reloadDone, thrown };
}
