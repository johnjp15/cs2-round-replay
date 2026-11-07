/**
 * Bullet damage, generalized to the weapon table. The formula and rounding are exactly those of
 * `src/sim2d/weapons.ts` (docs/combat.md, "Damage"), which reproduce every recorded hit of the Mirage round; here the
 * weapon numbers come from a `WeaponDef` (armor penetration = armorRatio × 0.5) and the global ones (hitgroup
 * multipliers, armor bonus, falloff distance) from `Tuning.damage`.
 */
import { roundNumber, type DamageTuning, type Hitgroup } from '../../contracts/index';
import type { WeaponDef } from './table';

/** HP and armor a hit removes (integers; HP not yet capped at the victim's health). */
export interface HitDamage {
  readonly health: number;
  readonly armor: number;
}

type FalloffTuning = Pick<DamageTuning, 'falloffUnits'>;

/** CS: the share of damage that reaches HP on an armored hit (`m_flArmorRatio` × 0.5; AK-47 1.55 → 0.775). */
export function armorPen(w: WeaponDef): number {
  return w.armorRatio * 0.5;
}

/** Damage × rangeModifier^(distance / falloffUnits), before hitgroup and armor. */
export function falloff(damage: number, rangeModifier: number, distance: number, d: FalloffTuning): number {
  return damage * Math.pow(rangeModifier, distance / d.falloffUnits);
}

/** Multiplier for a hitgroup: the weapon's headshot multiplier for the head, else `damage.hitgroupMult`. */
export function hitgroupMultiplier(w: WeaponDef, hitgroup: Hitgroup, d: Pick<DamageTuning, 'hitgroupMult'>): number {
  if (hitgroup === 'head') return w.headshotMultiplier;
  return d.hitgroupMult[hitgroup] ?? 1;
}

/** CS IsArmored: the head only with a helmet, legs never, everything else always. */
export function isArmored(hitgroup: Hitgroup, helmet: boolean): boolean {
  if (hitgroup === 'head') return helmet;
  return hitgroup !== 'leg';
}

/**
 * CS armor and integer rounding (identical to sim2d `armorDamage`): unarmored → trunc(damage); else
 * toHealth = damage × pen, toArmor = (damage − toHealth) × armorBonus, capped at the armor (the rest goes to HP);
 * HP removed = trunc(toHealth), new armor = trunc(armor − toArmor). Values are rounded to 6 decimals before each trunc.
 */
export function applyArmor(damage: number, pen: number, armor: number, armored: boolean, d: Pick<DamageTuning, 'armorBonus'>): HitDamage {
  if (!armored || armor <= 0) return { health: Math.trunc(roundNumber(damage)), armor: 0 };
  let toHealth = damage * pen;
  let toArmor = (damage - toHealth) * d.armorBonus;
  if (toArmor > armor) {
    toHealth = damage - armor / d.armorBonus;
    toArmor = armor;
  }
  const newArmor = Math.max(0, Math.trunc(roundNumber(armor - toArmor)));
  return { health: Math.max(0, Math.trunc(roundNumber(toHealth))), armor: armor - newArmor };
}

/**
 * One bullet that reaches the victim with `damage` left (after falloff and any wall penetration): hitgroup
 * multiplier, then armor and rounding.
 */
export function damageAfterHitgroup(w: WeaponDef, damage: number, hitgroup: Hitgroup, armor: number, helmet: boolean, d: DamageTuning): HitDamage {
  return applyArmor(damage * hitgroupMultiplier(w, hitgroup, d), armorPen(w), armor, isArmored(hitgroup, helmet), d);
}

/** One bullet over open air at `distance` (the eye to the impact): falloff, hitgroup, armor, rounding. */
export function bulletDamage(w: WeaponDef, distance: number, hitgroup: Hitgroup, armor: number, helmet: boolean, d: DamageTuning): HitDamage {
  return damageAfterHitgroup(w, falloff(w.damage, w.rangeModifier, distance, d), hitgroup, armor, helmet, d);
}
