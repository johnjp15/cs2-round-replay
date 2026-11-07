/**
 * Wall penetration (wallbangs). The host knows the world, so it passes the solids along the bullet's ray (a
 * `SolidQuery` callback: enter / exit distances and the surface's penetration modifier); this module only does the
 * damage arithmetic, so it stays pure. docs/weapons.md, "Penetration".
 *
 * Model (CS:GO's `FireBullet` / `HandleBulletPenetration` structure, constants in `weaponModel.pen*`):
 * - The bullet starts with the weapon's damage and may pass `penMaxPenetrations` surfaces (none if the weapon's
 *   penetration power is 0, and none once it has flown penMaxDistance).
 * - At each surface: air distance so far `s` (thickness of solids crossed is not counted), damage ×=
 *   rangeModifier^(s / falloffUnits) (CS applies the cumulative falloff again at every surface: a known quirk kept
 *   here), then, with `pm = 1 / modifier`:
 *   `lost = damage × penDamageLostFraction + (penPowerConst / penetration × penPowerFactor) × (pm × penModFactor)
 *           + pm × thickness² / penThicknessDivisor`; damage −= lost. It stops if damage < penMinDamage or the solid is
 *   thicker than penMaxThickness.
 * - At the target: damage ×= rangeModifier^(s_target / falloffUnits). With no solids this is exactly the open-air
 *   falloff of damage.ts.
 */
import type { DamageTuning, Vec3, WeaponModelTuning } from '../../contracts/index';
import type { WeaponDef } from './table';

/** A solid the ray crosses: distances from the ray's origin, enter < exit. */
export interface SolidSpan {
  readonly enter: number;
  readonly exit: number;
  /** The surface's penetration modifier (CS surface property); undefined = `weaponModel.penDefaultModifier`. */
  readonly modifier?: number;
}

/**
 * The host's world query: every solid along the ray from `origin` in unit direction `dir` up to `maxDistance`,
 * sorted by `enter`. Must be pure (same answer for the same ray).
 */
export type SolidQuery = (origin: Vec3, dir: Vec3, maxDistance: number) => readonly SolidSpan[];

export interface PenetrationResult {
  /** Damage left at `targetDistance` (before the hitgroup multiplier and armor), 0 if the bullet stopped. */
  readonly damage: number;
  /** Surfaces passed. */
  readonly surfaces: number;
  /** Distance where the bullet stopped (inside or at a solid), or null if it reached the target. */
  readonly stoppedAt: number | null;
}

type PenTuning = Pick<
  WeaponModelTuning,
  'penMaxPenetrations' | 'penMaxDistance' | 'penMaxThickness' | 'penDamageLostFraction' | 'penPowerConst' | 'penPowerFactor' | 'penModFactor' | 'penThicknessDivisor' | 'penDefaultModifier' | 'penMinDamage'
>;

/** Damage one surface of `thickness` with penetration modifier `modifier` takes off a bullet carrying `damage`. */
export function penetrationLoss(w: WeaponDef, damage: number, thickness: number, modifier: number, m: PenTuning): number {
  const pm = modifier > 0 ? 1 / modifier : 0;
  const power = w.penetration > 0 ? Math.max(0, (m.penPowerConst / w.penetration) * m.penPowerFactor) : 0;
  return Math.max(0, damage * m.penDamageLostFraction + power * (pm * m.penModFactor) + (pm * thickness * thickness) / m.penThicknessDivisor);
}

/**
 * Damage at `targetDistance` of a bullet from `w` through `spans` (sorted by enter; spans at or beyond the target are
 * ignored, as is any solid the target stands in front of).
 */
export function penetrate(w: WeaponDef, spans: readonly SolidSpan[], targetDistance: number, d: Pick<DamageTuning, 'falloffUnits'>, m: PenTuning): PenetrationResult {
  let damage = w.damage;
  let left = w.penetration > 0 ? m.penMaxPenetrations : 0;
  let air = 0;
  let pos = 0;
  let surfaces = 0;
  for (const s of spans) {
    if (s.enter >= targetDistance) break;
    if (s.exit <= pos) continue;
    air += Math.max(0, s.enter - pos);
    damage *= Math.pow(w.rangeModifier, air / d.falloffUnits);
    if (air > m.penMaxDistance) left = 0;
    const thickness = s.exit - Math.max(pos, s.enter);
    if (left <= 0 || thickness > m.penMaxThickness) return { damage: 0, surfaces, stoppedAt: s.enter };
    damage -= penetrationLoss(w, damage, thickness, s.modifier ?? m.penDefaultModifier, m);
    if (damage < m.penMinDamage) return { damage: 0, surfaces, stoppedAt: s.enter };
    left--;
    surfaces++;
    pos = s.exit;
  }
  air += Math.max(0, targetDistance - pos);
  return { damage: damage * Math.pow(w.rangeModifier, air / d.falloffUnits), surfaces, stoppedAt: null };
}

/** `penetrate` with the host's world query for the ray from `origin` along `dir` to a target at `targetDistance`. */
export function traceBulletDamage(
  w: WeaponDef,
  origin: Vec3,
  dir: Vec3,
  targetDistance: number,
  query: SolidQuery,
  d: Pick<DamageTuning, 'falloffUnits'>,
  m: PenTuning,
): PenetrationResult {
  return penetrate(w, query(origin, dir, targetDistance), targetDistance, d, m);
}
