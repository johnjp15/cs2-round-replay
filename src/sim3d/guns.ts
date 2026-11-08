/**
 * W2: the 3D host's guns from CS2's weapon table (`data/weapons.json`, weapons.vdata) instead of the 2D table
 * (`tuning.weapons`, the 2020 recording's values): the one place that maps an item id to its table entry and turns
 * it into the fire / reload / deploy numbers the weapon state machine (src/sim2d/weapons.ts stepWeapon) runs on.
 *
 * Used for mechanical pawns only (the human while controlled, LIVE bots; Sim3DHost.mechanical): puppets keep the 2D
 * table, so a run nobody plays is the 2D golden master byte for byte (their shots and damage are the tape's anyway).
 *
 * | stepWeapon field | from the table | e.g. |
 * | --- | --- | --- |
 * | damage, headshotMult, rangeModifier | `damage`, `headshotMultiplier`, `rangeModifier` | |
 * | armorPen | `armorRatio` / 2 (CS2's armor ratio is twice the health share) | AK 1.55 → 0.775 |
 * | rpm | 60 / `cycleTime[0]` | AWP 1.455 s → 41.24 |
 * | clip, reserve | `clip`, `reserve` (magazines × clip, March 2026) | AWP 5 / 10, USP-S 12 / 24 |
 * | reloadSec, deploySec | `reloadTime`, `deployTime` | |
 * | automatic | `fullAuto` | |
 */
import type { WeaponTuning } from '../contracts/index';
import type { WeaponDef, WeaponTable } from '../engine/weapons/index';

/** Item ids that differ from the table's (none today: the 2D ids were chosen as the table's; `m4a4` = weapon_m4a1). */
export const TABLE_ALIASES: Readonly<Record<string, string>> = { m4a1: 'm4a4', incgrenade: 'incendiary', hkp2000: 'p2000', usp_silencer: 'usps', knife_ct: 'knife' };

/** Table kinds that shoot bullets. */
const GUN_KINDS: readonly string[] = ['rifle', 'sniper', 'smg', 'pistol', 'machinegun', 'shotgun', 'taser'];

/** The table id of an item (aliases resolved), or null when the table doesn't have it. */
export function tableId(table: WeaponTable, item: string): string | null {
  const id = TABLE_ALIASES[item] ?? item;
  return table.weapons[id] !== undefined ? id : null;
}

/** A table entry as stepWeapon's gun stats, or null for anything that doesn't shoot. */
export function gunFromDef(w: WeaponDef): WeaponTuning | null {
  if (!GUN_KINDS.includes(w.kind)) return null;
  const cycle = w.cycleTime[0] ?? 0;
  return {
    damage: w.damage,
    rpm: cycle > 0 ? 60 / cycle : 600,
    headshotMult: w.headshotMultiplier,
    armorPen: w.armorRatio / 2,
    rangeModifier: w.rangeModifier,
    clip: w.clip,
    reserve: w.reserve,
    reloadSec: w.reloadTime,
    deploySec: w.deployTime,
    automatic: w.fullAuto,
  };
}

/** Every gun of the table by id (built once per host). */
export function gunTable(table: WeaponTable): ReadonlyMap<string, WeaponTuning> {
  const m = new Map<string, WeaponTuning>();
  for (const id of Object.keys(table.weapons).sort()) {
    const g = gunFromDef(table.weapons[id] as WeaponDef);
    if (g !== null) m.set(id, g);
  }
  return m;
}
