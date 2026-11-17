/**
 * K4: item prices and kinds by canonical item name (src/coach/model/items.ts), from data/weapons.json (class names
 * stripped and canonicalized: item_kevlar → vest, item_assaultsuit → vesthelm, weapon_m4a1 → m4a1, …).
 */
import weaponsJson from '../../../../data/weapons.json';
import { GRENADES, canonicalItem } from '../../model/items';

interface WeaponRow { className: string; price: number; kind: string }

const PRICE = new Map<string, number>();
const KIND = new Map<string, string>();
{
  const w = (weaponsJson as unknown as { weapons: Record<string, WeaponRow> }).weapons;
  for (const key of Object.keys(w).sort()) {
    const row = w[key];
    if (!row) continue;
    const name = canonicalItem(row.className);
    if (!PRICE.has(name)) PRICE.set(name, row.price);
    if (!KIND.has(name)) KIND.set(name, row.kind);
  }
}

/** Price in dollars (0 when unknown). */
export function itemPrice(item: string): number {
  return PRICE.get(item) ?? 0;
}

/** `rifle`, `sniper`, `smg`, `shotgun`, `machinegun`, `pistol`, `grenade`, `knife`, `equipment`, `c4`, `taser`, or ''. */
export function itemKind(item: string): string {
  return KIND.get(item) ?? '';
}

const GRENADE_SET = new Set(GRENADES);
export function isGrenade(item: string): boolean {
  return GRENADE_SET.has(item);
}

/** Primary weapons: rifles, snipers, SMGs, shotguns, machine guns. */
export function isPrimary(item: string): boolean {
  const k = itemKind(item);
  return k === 'rifle' || k === 'sniper' || k === 'smg' || k === 'shotgun' || k === 'machinegun';
}

/** Any firearm (primary or pistol). */
export function isGun(item: string): boolean {
  return isPrimary(item) || itemKind(item) === 'pistol';
}

/** Grenades in a sorted item list and their summed price. */
export function grenadesOf(items: readonly string[]): { grenades: string[]; value: number } {
  const grenades = items.filter(isGrenade);
  return { grenades, value: grenades.reduce((s, g) => s + itemPrice(g), 0) };
}
