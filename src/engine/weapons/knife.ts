/**
 * W1 (#38): CS2's knife (weapon_knife / weapon_knife_t) as pure rules: which attack, its damage, reach and the time
 * to the next attack. docs/weapons.md "Knife".
 *
 * The melee numbers are not in weapons.vdata: CS2's `weapon_knife` entry (GameTracking-CS2
 * game/csgo/pak01_dir/scripts/weapons.vdata, data/weapons.json) carries a bullet-weapon template (m_nDamage 50,
 * m_flCycleTime [0.15, 0.3], m_flRange 4096) that the knife's code does not use. The code is CS:GO's
 * `CKnife::SwingOrStab` (game/shared/cstrike15/weapon_knife.cpp, the 2017 CS:GO source; mirrored in
 * github.com/SwagSoftware/Kisak-Strike), whose numbers CS2 kept (counterstrikewiki.com/Knife for CS2: slash 40, stab
 * 65, backstab stab 180 "instant kill", 250 u/s; its armored infobox values 34 / 55 / 76 are 40 / 65 / 90 × 0.85):
 *
 * - **Slash** (mouse 1, `PrimaryAttack`): reach `KNIFE_RANGE_LONG` 48 u. 40 damage on the first swing, 25 on a
 *   swing that follows within 0.4 s of the previous one being ready (`bFirstSwing = m_flNextPrimaryAttack + 0.4 <
 *   curtime`), 90 from behind. Next slash 0.4 s after a miss, 0.5 s after a hit; next stab 0.5 s.
 * - **Stab** (mouse 2, `SecondaryAttack`): reach `KNIFE_RANGE_SHORT` 32 u. 65 damage, 180 from behind (kills from
 *   100 HP through any armor). Next slash or stab 1.0 s after a miss, 1.1 s after a hit.
 * - **Backstab**: the 2D line from the attacker's origin to the victim's, normalized, · the victim's forward (its
 *   yaw) > 0.475 (about 61.6° either side of straight behind).
 * - **Trace**: a line from the eye (`Weapon_ShootPosition`) along the view (EyeAngles: no aim punch) of the reach;
 *   when it hits nothing, the same sweep with a 32 × 32 × 36 box (`head_hull` ±16, ±16, ±18). MASK_SOLID: the world
 *   and the players' collision boxes (not hitboxes), so the hitgroup is `generic` (×1, armored).
 * - **Armor**: `m_flArmorRatio` 1.7 → 85 % of the damage reaches HP through armor (damage.ts armorPen).
 * - Mouse 1 is checked before mouse 2 (CWeaponCSBase::ItemPostFrame), each on its own timer; the deploy (1.0 s,
 *   `m_flDeployDuration`) holds both. Speed: m_flMaxSpeed 250 (arms.ts maxSpeedOf).
 */

export type KnifeAttack = 'slash' | 'stab';

/** `KNIFE_RANGE_LONG` / `KNIFE_RANGE_SHORT` (units). */
export const KNIFE_RANGE: { readonly [A in KnifeAttack]: number } = { slash: 48, stab: 32 };

/** `head_hull_mins` / `maxs`: the half extents of the sweep that follows a missed line (units). */
export const KNIFE_HULL_HALF = { x: 16, y: 16, z: 18 } as const;

/** Backstab when (victim − attacker, 2D, normalized) · victim forward > this. */
export const BACKSTAB_DOT = 0.475;

/** A slash is a "first swing" (full damage) when more than this has passed since the slash timer was ready (s). */
export const FIRST_SWING_SEC = 0.4;

export const KNIFE_DAMAGE = {
  slash: { first: 40, next: 25, back: 90 },
  stab: { front: 65, back: 180 },
} as const;

/** Seconds to the next slash / stab after an attack (`fPrimDelay` / `fSecDelay`). */
export function knifeDelays(attack: KnifeAttack, hit: boolean): { readonly slash: number; readonly stab: number } {
  if (attack === 'stab') {
    const d = hit ? 1.1 : 1.0;
    return { slash: d, stab: d };
  }
  return { slash: hit ? 0.5 : 0.4, stab: 0.5 };
}

/** Damage before armor of a knife hit. `firstSwing`: see FIRST_SWING_SEC (slash only). */
export function knifeDamage(attack: KnifeAttack, backstab: boolean, firstSwing: boolean): number {
  if (attack === 'stab') return backstab ? KNIFE_DAMAGE.stab.back : KNIFE_DAMAGE.stab.front;
  if (backstab) return KNIFE_DAMAGE.slash.back;
  return firstSwing ? KNIFE_DAMAGE.slash.first : KNIFE_DAMAGE.slash.next;
}

/** Whether a hit from `attacker` on `victim` (feet positions) facing `victimYawDeg` is from behind. */
export function isBackstab(attacker: { readonly x: number; readonly y: number }, victim: { readonly x: number; readonly y: number }, victimYawDeg: number): boolean {
  const dx = victim.x - attacker.x;
  const dy = victim.y - attacker.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return false;
  const r = (victimYawDeg * Math.PI) / 180;
  return (dx / len) * Math.cos(r) + (dy / len) * Math.sin(r) > BACKSTAB_DOT;
}

/** Which attack the buttons start this tick, given the timers (fractional ticks; `ready(t)` = reached). */
export function knifeAttackFor(attack: boolean, attack2: boolean, slashReady: boolean, stabReady: boolean): KnifeAttack | null {
  if (attack && slashReady) return 'slash';
  if (attack2 && stabReady) return 'stab';
  return null;
}
