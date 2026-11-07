/**
 * HE blast damage (docs/grenades.md, HE): Source's `RadiusDamage` shape (the blast point is raised 1 unit, each
 * pawn is hit at its body centre only if the line from the blast to it is clear of the world) with CS2's numbers
 * (weapons.vdata: 99 damage, 350 range, armor ratio 1.2). The falloff is the Gaussian CS:GO introduced
 * (σ = radius / 3; unverified for CS2, `heGaussian` false = Source's linear falloff).
 */
import type { GrenadeCs2Tuning, Team, Vec3 } from '../../contracts/index';
import type { GrenadeEvent, GrenadePawn, GrenadeType, GrenadeWorld } from './types';

/** Damage at distance d from the blast (before armor and team scaling). */
export function blastDamage(d: number, damage: number, radius: number, t: Pick<GrenadeCs2Tuning, 'heGaussian' | 'heSigmaFraction'>): number {
  if (d >= radius) return 0;
  if (!t.heGaussian) return damage * (1 - d / radius);
  const sigma = radius * t.heSigmaFraction;
  return damage * Math.exp(-(d * d) / (2 * sigma * sigma));
}

/** Team scaling: the thrower takes selfDamageScale, teammates teamDamageScale with friendly fire (else nothing). */
export function teamScale(victim: GrenadePawn, thrower: string, team: Team, friendlyFire: boolean, t: GrenadeCs2Tuning): number {
  if (victim.id === thrower) return t.selfDamageScale;
  if (victim.team === team) return friendlyFire ? t.teamDamageScale : 0;
  return 1;
}

export interface BlastSpec {
  readonly seq: number;
  readonly grenade: GrenadeType;
  readonly thrower: string;
  readonly team: Team;
  readonly pos: Vec3;
  readonly damage: number;
  readonly radius: number;
  readonly armorRatio: number;
  readonly flinchSmall: number;
  readonly flinchLarge: number;
}

/** Hurt events of a blast for every alive pawn in range with a clear line to its body centre (pawns in id order). */
export function blast(spec: BlastSpec, pawns: readonly GrenadePawn[], world: GrenadeWorld, friendlyFire: boolean, tick: number, t: GrenadeCs2Tuning): GrenadeEvent[] {
  const out: GrenadeEvent[] = [];
  const sx = spec.pos.x;
  const sy = spec.pos.y;
  const sz = spec.pos.z + 1;
  for (const p of pawns) {
    if (!p.alive) continue;
    const cx = p.pos.x;
    const cy = p.pos.y;
    const cz = p.pos.z + p.height / 2;
    const d = Math.sqrt((cx - sx) ** 2 + (cy - sy) ** 2 + (cz - sz) ** 2);
    if (d >= spec.radius) continue;
    const scale = teamScale(p, spec.thrower, spec.team, friendlyFire, t);
    if (scale <= 0) continue;
    if (world.traceLine(sx, sy, sz, cx, cy, cz) < 1) continue;
    const damage = blastDamage(d, spec.damage, spec.radius, t) * scale;
    if (damage <= 0) continue;
    out.push({
      type: 'hurt',
      tick,
      seq: spec.seq,
      grenade: spec.grenade,
      thrower: spec.thrower,
      victim: p.id,
      damage,
      armorPen: spec.armorRatio * 0.5,
      flinchSmall: spec.flinchSmall,
      flinchLarge: spec.flinchLarge,
    });
  }
  return out;
}

/**
 * The CS armor rule (for hosts and tests): health damage = damage × armorPen; armor takes (damage − health) × 0.5
 * (armor bonus); if that is more than the armor left, the excess goes to health.
 */
export function applyArmor(damage: number, armor: number, armorPen: number, armorBonus = 0.5): { health: number; armor: number } {
  if (armor <= 0) return { health: damage, armor: 0 };
  let health = damage * armorPen;
  let armorDmg = (damage - health) * armorBonus;
  if (armorDmg > armor) {
    armorDmg = armor;
    health = damage - armor / armorBonus;
  }
  return { health, armor: armorDmg };
}
