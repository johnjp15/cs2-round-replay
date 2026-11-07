/**
 * Build data/weapons.json (H2, docs/weapons.md) from CS2's `scripts/weapons.vdata` (KV3 text, as mirrored by
 * SteamDatabase/GameTracking-CS2), plus the model spray patterns of the spray weapons.
 *
 *   npx tsx tools/extract-weapons.ts [data/source/cs2/weapons.vdata] [data/weapons.json]
 *
 * The vdata entries are flattened (each weapon lists every field). Fields that are a scalar for some weapons and a
 * [primary, alt] pair for others are normalized to pairs. Output is deterministic 2-space JSON with sorted keys.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTuning } from '../src/contracts/index';
import { parseWeaponTable, recoilTable, sprayPattern, type WeaponKind } from '../src/engine/weapons/index';

const SOURCE = {
  file: 'game/csgo/pak01_dir/scripts/weapons.vdata',
  repo: 'https://github.com/SteamDatabase/GameTracking-CS2',
  commit: 'cce7bf1f190144c1c08fb0fe75fd3c9514f2637f',
  date: '2026-11-05',
};

/** vdata class → repo id (the 2D sim's ids where they exist). Knife skins, heavy armor and NVGs are left out. */
const IDS: Readonly<Record<string, string>> = {
  weapon_ak47: 'ak47',
  weapon_aug: 'aug',
  weapon_awp: 'awp',
  weapon_bizon: 'bizon',
  weapon_c4: 'c4',
  weapon_cz75a: 'cz75a',
  weapon_deagle: 'deagle',
  weapon_decoy: 'decoy',
  weapon_elite: 'elite',
  weapon_famas: 'famas',
  weapon_fiveseven: 'fiveseven',
  weapon_flashbang: 'flash',
  weapon_g3sg1: 'g3sg1',
  weapon_galilar: 'galil',
  weapon_glock: 'glock',
  weapon_healthshot: 'healthshot',
  weapon_hegrenade: 'he',
  weapon_hkp2000: 'p2000',
  weapon_incgrenade: 'incendiary',
  weapon_knife: 'knife',
  weapon_knife_t: 'knife_t',
  weapon_m249: 'm249',
  weapon_m4a1: 'm4a4',
  weapon_m4a1_silencer: 'm4a1s',
  weapon_mac10: 'mac10',
  weapon_mag7: 'mag7',
  weapon_molotov: 'molotov',
  weapon_mp5sd: 'mp5sd',
  weapon_mp7: 'mp7',
  weapon_mp9: 'mp9',
  weapon_negev: 'negev',
  weapon_nova: 'nova',
  weapon_p250: 'p250',
  weapon_p90: 'p90',
  weapon_revolver: 'revolver',
  weapon_sawedoff: 'sawedoff',
  weapon_scar20: 'scar20',
  weapon_sg556: 'sg553',
  weapon_smokegrenade: 'smoke',
  weapon_ssg08: 'ssg08',
  weapon_taser: 'zeus',
  weapon_tec9: 'tec9',
  weapon_ump45: 'ump45',
  weapon_usp_silencer: 'usps',
  weapon_xm1014: 'xm1014',
  item_assaultsuit: 'assaultsuit',
  item_defuser: 'defuser',
  item_kevlar: 'kevlar',
};

/** Spray weapons whose model patterns go into the table (task card H2), and the pistols' short patterns. */
export const SPRAYS = ['ak47', 'm4a4', 'm4a1s', 'galil', 'famas', 'aug', 'sg553', 'mp9', 'mac10', 'ump45', 'p90', 'bizon', 'mp7', 'mp5sd', 'negev', 'm249'];
export const PISTOL_SPRAY = ['glock', 'usps', 'p2000', 'p250', 'fiveseven', 'tec9', 'cz75a', 'deagle', 'elite', 'revolver'];
const PISTOL_SHOTS = 10;

type Kv = string | number | boolean | Kv[] | { [k: string]: Kv };

/** Minimal KV3 text parser: objects `{ k = v }`, arrays `[ a, b ]`, strings, numbers, booleans, `type:"…"` values. */
export function parseKv3(text: string): Record<string, Kv> {
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  const re = /"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*:"(?:[^"\\]|\\.)*"|[{}[\]=,]|[^\s{}[\]=,]+/g;
  const toks = body.match(re) ?? [];
  let i = 0;
  const value = (): Kv => {
    const t = toks[i++];
    if (t === undefined) throw new Error('kv3: unexpected end');
    if (t === '{') {
      const o: Record<string, Kv> = {};
      while (toks[i] !== '}') {
        const k = toks[i++] as string;
        if (toks[i++] !== '=') throw new Error(`kv3: expected = after ${k}`);
        o[k] = value();
      }
      i++;
      return o;
    }
    if (t === '[') {
      const a: Kv[] = [];
      while (toks[i] !== ']') {
        if (toks[i] === ',') {
          i++;
          continue;
        }
        a.push(value());
      }
      i++;
      return a;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    const typed = /^[A-Za-z_][A-Za-z0-9_]*:"(.*)"$/.exec(t);
    if (typed !== null) return typed[1] as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    return t;
  };
  return value() as Record<string, Kv>;
}

function main(): void {
  const src = process.argv[2] ?? new URL('../data/source/cs2/weapons.vdata', import.meta.url).pathname;
  const out = process.argv[3] ?? new URL('../data/weapons.json', import.meta.url).pathname;
  const text = buildWeaponsJson(readFileSync(src), readFileSync(new URL('../data/tuning.json', import.meta.url), 'utf8'));
  writeFileSync(out, text);
  const j = JSON.parse(text) as { weapons: object; sprays: object; source: { sha256: string } };
  console.log(`wrote ${out}: ${Object.keys(j.weapons).length} weapons, ${Object.keys(j.sprays).length} spray patterns (vdata sha256 ${j.source.sha256.slice(0, 12)}…)`);
}

/** The text of data/weapons.json for the vdata bytes and the tuning JSON text (pure; the tests rebuild it). */
export function buildWeaponsJson(vdataBytes: Uint8Array, tuningText: string): string {
  const sha256 = createHash('sha256').update(vdataBytes).digest('hex');
  const vdata = parseKv3(new TextDecoder().decode(vdataBytes));
  const weapons: Record<string, unknown> = {};
  for (const cls of Object.keys(IDS).sort()) {
    const v = vdata[cls];
    if (v === undefined || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${cls}: missing from the vdata`);
    const id = IDS[cls] as string;
    weapons[id] = convert(id, cls, v);
  }
  const table = { source: { ...SOURCE, sha256 }, weapons, sprays: {} };
  const parsed = parseWeaponTable(table);
  const model = parseTuning(tuningText).weaponModel;
  if (model === undefined) throw new Error('data/tuning.json has no weapons._engine');
  const sprays: Record<string, [number, number][]> = {};
  for (const id of [...SPRAYS, ...PISTOL_SPRAY].sort()) {
    const w = parsed.weapons[id];
    if (w === undefined) throw new Error(`no ${id}`);
    const tables = [recoilTable(w, 0, model), recoilTable(w, 1, model)] as const;
    sprays[id] = sprayPattern(w, tables, model, 64, SPRAYS.includes(id) ? w.clip : Math.min(PISTOL_SHOTS, w.clip));
  }
  const full = { source: table.source, weapons, sprays };
  parseWeaponTable(full);
  return stringify(full) + '\n';
}

function convert(id: string, cls: string, v: Record<string, Kv>): Record<string, unknown> {
  const num = (k: string, fallback?: number): number => {
    const x = v[k];
    if (typeof x === 'number') return x;
    if (x === undefined && fallback !== undefined) return fallback;
    throw new Error(`${cls}.${k}: expected a number, got ${JSON.stringify(x)}`);
  };
  const bool = (k: string, fallback = false): boolean => {
    const x = v[k];
    if (x === undefined) return fallback;
    if (typeof x !== 'boolean') throw new Error(`${cls}.${k}: expected a boolean`);
    return x;
  };
  const pair = (k: string): [number, number] => {
    const x = v[k];
    if (typeof x === 'number') return [x, x];
    if (Array.isArray(x) && x.length === 2 && typeof x[0] === 'number' && typeof x[1] === 'number') return [x[0], x[1]];
    throw new Error(`${cls}.${k}: expected a number or a pair`);
  };
  const str = (k: string): string => {
    const x = v[k];
    if (typeof x !== 'string') throw new Error(`${cls}.${k}: expected a string`);
    return x;
  };
  const clip = Math.max(0, num('m_iMaxClip1', 0));
  const reserveMax = Math.max(0, num('m_nPrimaryReserveAmmoMax', 0));
  const reserveAsClips = bool('m_bReserveAmmoAsClips');
  const burstCycle = num('m_flCycleTimeWhenInBurstMode', 0);
  return {
    id,
    className: cls,
    kind: kindOf(cls, str('m_WeaponType')),
    gearSlot: typeof v['m_GearSlot'] === 'string' ? str('m_GearSlot').replace(/^GEAR_SLOT_/, '').toLowerCase() : 'none',
    price: num('m_nPrice', 0),
    killAward: num('m_nKillAward', 0),
    damage: num('m_nDamage', 0),
    armorRatio: num('m_flArmorRatio'),
    penetration: num('m_flPenetration'),
    range: num('m_flRange'),
    rangeModifier: num('m_flRangeModifier'),
    headshotMultiplier: num('m_flHeadshotMultiplier'),
    bullets: num('m_nNumBullets', 1),
    fullAuto: bool('m_bIsFullAuto'),
    clip,
    reserveMax,
    reserveAsClips,
    reserve: reserveAsClips ? reserveMax * clip : reserveMax,
    reloadsSingleShells: bool('m_bReloadsSingleShells'),
    cycleTime: pair('m_flCycleTime'),
    burst: bool('m_bHasBurstMode') ? { cycleTime: burstCycle, timeBetweenShots: num('m_flTimeBetweenBurstShots') } : null,
    revolver: bool('m_bIsRevolver'),
    deployTime: num('m_flDeployDuration'),
    reloadTime: num('m_flDisallowAttackAfterReloadStartDuration'),
    maxSpeed: pair('m_flMaxSpeed'),
    attackMovespeedFactor: num('m_flAttackMovespeedFactor', 1),
    spread: pair('m_flSpread'),
    inaccuracy: {
      stand: pair('m_flInaccuracyStand'),
      crouch: pair('m_flInaccuracyCrouch'),
      move: pair('m_flInaccuracyMove'),
      jump: pair('m_flInaccuracyJump'),
      land: pair('m_flInaccuracyLand'),
      ladder: pair('m_flInaccuracyLadder'),
      fire: pair('m_flInaccuracyFire'),
      jumpInitial: num('m_flInaccuracyJumpInitial'),
      jumpApex: num('m_flInaccuracyJumpApex'),
      reload: num('m_flInaccuracyReload'),
    },
    recoil: {
      angle: pair('m_flRecoilAngle'),
      angleVariance: pair('m_flRecoilAngleVariance'),
      magnitude: pair('m_flRecoilMagnitude'),
      magnitudeVariance: pair('m_flRecoilMagnitudeVariance'),
      seed: num('m_nRecoilSeed', 0),
    },
    recovery: {
      stand: num('m_flRecoveryTimeStand'),
      crouch: num('m_flRecoveryTimeCrouch'),
      standFinal: num('m_flRecoveryTimeStandFinal'),
      crouchFinal: num('m_flRecoveryTimeCrouchFinal'),
      transitionStartBullet: num('m_nRecoveryTransitionStartBullet'),
      transitionEndBullet: num('m_nRecoveryTransitionEndBullet'),
    },
    flinchLarge: num('m_flFlinchVelocityModifierLarge'),
    flinchSmall: num('m_flFlinchVelocityModifierSmall'),
    zoom: {
      levels: num('m_nZoomLevels', 0),
      fov: [num('m_nZoomFOV1', 90), num('m_nZoomFOV2', 90)],
      times: [num('m_flZoomTime0', 0), num('m_flZoomTime1', 0), num('m_flZoomTime2', 0)],
      unzoomsAfterShot: bool('m_bUnzoomsAfterShot'),
    },
    silencer: str('m_eSilencerType').replace(/^WEAPONSILENCER_/, '').toLowerCase(),
    spreadSeed: num('m_nSpreadSeed', 0),
    tracerFrequency: typeof v['m_nTracerFrequency'] === 'number' ? num('m_nTracerFrequency') : pair('m_nTracerFrequency')[0],
  };
}

function kindOf(cls: string, type: string): WeaponKind {
  if (cls === 'weapon_taser') return 'taser';
  const t = type.replace(/^WEAPONTYPE_/, '');
  const map: Record<string, WeaponKind> = {
    PISTOL: 'pistol',
    SUBMACHINEGUN: 'smg',
    RIFLE: 'rifle',
    SNIPER_RIFLE: 'sniper',
    SHOTGUN: 'shotgun',
    MACHINEGUN: 'machinegun',
    KNIFE: 'knife',
    GRENADE: 'grenade',
    C4: 'c4',
    EQUIPMENT: 'equipment',
    TASER: 'taser',
    STACKABLEITEM: 'equipment',
  };
  const k = map[t];
  if (k === undefined) throw new Error(`${cls}: unknown weapon type ${type}`);
  return k;
}

/** JSON with sorted object keys, 2-space indent, arrays of numbers on one line. */
function stringify(v: unknown, indent = ''): string {
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'number')) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    const inner = indent + '  ';
    return `[\n${v.map((x) => inner + stringify(x, inner)).join(',\n')}\n${indent}]`;
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    const inner = indent + '  ';
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${stringify((v as Record<string, unknown>)[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
