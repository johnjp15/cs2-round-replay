/**
 * Canonical item names for the coach: the game's item class names without `weapon_` / `item_` (`ak47`,
 * `m4a1_silencer`, `knife`, …). Demos spell items three ways: class names in events (`weapon_ak47`, `ak47`,
 * `knife_t`), display names in tick fields (`AK-47`, `Bowie Knife`), and definition indexes (`item_def_index`).
 * Both parsers map all three to the same canonical name with these helpers. Every knife skin becomes `knife`.
 */

/** Item definition index → [canonical name, display name as demoparser2 reports it]. */
export const ITEM_DEFS: Readonly<Record<number, readonly [string, string]>> = {
  1: ['deagle', 'Desert Eagle'], 2: ['elite', 'Dual Berettas'], 3: ['fiveseven', 'Five-SeveN'], 4: ['glock', 'Glock-18'],
  7: ['ak47', 'AK-47'], 8: ['aug', 'AUG'], 9: ['awp', 'AWP'], 10: ['famas', 'FAMAS'], 11: ['g3sg1', 'G3SG1'],
  13: ['galilar', 'Galil AR'], 14: ['m249', 'M249'], 16: ['m4a1', 'M4A4'], 17: ['mac10', 'MAC-10'], 19: ['p90', 'P90'],
  23: ['mp5sd', 'MP5-SD'], 24: ['ump45', 'UMP-45'], 25: ['xm1014', 'XM1014'], 26: ['bizon', 'PP-Bizon'],
  27: ['mag7', 'MAG-7'], 28: ['negev', 'Negev'], 29: ['sawedoff', 'Sawed-Off'], 30: ['tec9', 'Tec-9'],
  31: ['taser', 'Zeus x27'], 32: ['hkp2000', 'P2000'], 33: ['mp7', 'MP7'], 34: ['mp9', 'MP9'], 35: ['nova', 'Nova'],
  36: ['p250', 'P250'], 38: ['scar20', 'SCAR-20'], 39: ['sg556', 'SG 553'], 40: ['ssg08', 'SSG 08'],
  41: ['knife', 'Knife'], 42: ['knife', 'knife'], 43: ['flashbang', 'Flashbang'], 44: ['hegrenade', 'High Explosive Grenade'],
  45: ['smokegrenade', 'Smoke Grenade'], 46: ['molotov', 'Molotov'], 47: ['decoy', 'Decoy Grenade'],
  48: ['incgrenade', 'Incendiary Grenade'], 49: ['c4', 'C4 Explosive'], 50: ['vest', 'Kevlar Vest'],
  51: ['vesthelm', 'Kevlar & Helmet'], 52: ['heavyassaultsuit', 'Heavy Assault Suit'], 55: ['defuser', 'Defuse Kit'],
  57: ['healthshot', 'Medi-Shot'], 59: ['knife', 'knife_t'], 60: ['m4a1_silencer', 'M4A1-S'], 61: ['usp_silencer', 'USP-S'],
  63: ['cz75a', 'CZ75-Auto'], 64: ['revolver', 'R8 Revolver'],
};

const BY_DISPLAY: Map<string, string> = new Map();
for (const [name, display] of Object.values(ITEM_DEFS)) BY_DISPLAY.set(display, name);

/** Class-name aliases events use that differ from the canonical name. */
const ALIASES: Readonly<Record<string, string>> = {
  knife_t: 'knife', knifegg: 'knife', bayonet: 'knife', m4a4: 'm4a1', usp: 'usp_silencer', p2000: 'hkp2000',
  incendiary: 'incgrenade', inferno: 'inferno', he_grenade: 'hegrenade', smoke: 'smokegrenade',
};

/** Canonical name for an item definition index ('' when unknown; knife skins ≥ 500 are `knife`). */
export function itemFromDefIndex(defIndex: number): string {
  const d = ITEM_DEFS[defIndex];
  if (d) return d[0];
  return defIndex >= 500 && defIndex < 600 ? 'knife' : '';
}

/**
 * Canonical name for any spelling the demo uses: a class name (`weapon_ak47`, `item_kevlar`, `knife_t`), an event
 * name (`ak47`, `inferno`, `world`), or a display name (`AK-47`, `Bowie Knife`). Unknown names come back lowercased
 * with the prefix stripped, so nothing is lost.
 */
export function canonicalItem(raw: string | null | undefined): string {
  if (!raw) return '';
  const display = BY_DISPLAY.get(raw);
  if (display !== undefined) return display;
  if (/knife|bayonet|karambit|daggers/i.test(raw)) return 'knife';
  let s = raw.toLowerCase();
  if (s.startsWith('weapon_')) s = s.slice(7);
  else if (s.startsWith('item_')) s = s.slice(5);
  if (s === 'kevlar') return 'vest';
  if (s === 'assaultsuit') return 'vesthelm';
  return ALIASES[s] ?? s;
}

/** Grenade item names. */
export const GRENADES: readonly string[] = ['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'incgrenade', 'decoy'];
