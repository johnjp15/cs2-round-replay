/** Display names for maps, weapons and round-end reasons. */
const WEAPONS: Record<string, string> = {
  ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', awp: 'AWP', ssg08: 'Scout', sg556: 'SG 553', aug: 'AUG',
  famas: 'FAMAS', galilar: 'Galil', g3sg1: 'G3SG1', scar20: 'SCAR-20', mac10: 'MAC-10', mp9: 'MP9', mp7: 'MP7',
  mp5sd: 'MP5-SD', ump45: 'UMP', p90: 'P90', bizon: 'Bizon', nova: 'Nova', xm1014: 'XM1014', mag7: 'MAG-7',
  sawedoff: 'Sawed-Off', m249: 'M249', negev: 'Negev', glock: 'Glock', usp_silencer: 'USP-S', hkp2000: 'P2000',
  p250: 'P250', fiveseven: 'Five-SeveN', tec9: 'Tec-9', cz75a: 'CZ75', deagle: 'Deagle', revolver: 'R8', elite: 'Dualies',
  knife: 'knife', taser: 'Zeus', c4: 'C4', hegrenade: 'HE', flashbang: 'flash', smokegrenade: 'smoke',
  molotov: 'molotov', incgrenade: 'incendiary', decoy: 'decoy', inferno: 'fire', world: 'world',
};

export function weaponName(w: string): string {
  return WEAPONS[w] ?? w;
}

export function mapName(map: string): string {
  const m = map.replace(/^de_|^cs_/, '');
  return m.charAt(0).toUpperCase() + m.slice(1);
}

const REASONS: Record<string, string> = {
  bomb_exploded: 'Bomb exploded', bomb_defused: 'Bomb defused', t_killed: 'Ts eliminated', ct_killed: 'CTs eliminated',
  time_ran_out: 'Time ran out', t_surrender: 'T surrender', ct_surrender: 'CT surrender', draw: 'Draw',
};
const REASON_SHORT: Record<string, string> = {
  bomb_exploded: 'bomb', bomb_defused: 'defuse', t_killed: 'elim', ct_killed: 'elim', time_ran_out: 'time',
  t_surrender: 'surr', ct_surrender: 'surr', draw: 'draw',
};

export const reasonLong = (r: string): string => REASONS[r] ?? r.replace(/_/g, ' ');
export const reasonShort = (r: string): string => REASON_SHORT[r] ?? r.slice(0, 5);

/** m:ss */
export function clock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
