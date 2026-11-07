/**
 * The CS2 weapon table (`data/weapons.json`): one `WeaponDef` per CS2 weapon class, in seconds, Source units and
 * the game's own inaccuracy units (the tangent of the cone's half-angle). Every number comes from CS2's
 * `scripts/weapons.vdata` (docs/weapons.md, "Sources"); `tools/extract-weapons.ts` builds the file.
 *
 * `Pair` values are `[primary, alt]`: alt is the weapon's second mode (scoped, silencer on, burst, revolver right
 * click). Pure, no I/O; the host loads the JSON and passes it to `parseWeaponTable`.
 */

/** [primary mode, alt mode]. */
export type Pair = readonly [number, number];

export const WEAPON_KINDS = ['pistol', 'smg', 'rifle', 'sniper', 'shotgun', 'machinegun', 'knife', 'taser', 'grenade', 'c4', 'equipment'] as const;
export type WeaponKind = (typeof WEAPON_KINDS)[number];

export const SILENCER_TYPES = ['none', 'integrated', 'detachable'] as const;
export type SilencerType = (typeof SILENCER_TYPES)[number];

export interface InaccuracyDef {
  readonly stand: Pair;
  readonly crouch: Pair;
  /** Added at full running speed (scaled by speed, see accuracy.ts). */
  readonly move: Pair;
  /** Added in the air at take-off vertical speed (scaled by vertical speed). */
  readonly jump: Pair;
  /** Added to the accuracy penalty on landing. */
  readonly land: Pair;
  readonly ladder: Pair;
  /** Added to the accuracy penalty per shot. */
  readonly fire: Pair;
  /** Added to the accuracy penalty at take-off (CS2 `m_flInaccuracyJumpInitial`). */
  readonly jumpInitial: number;
  /** CS2 `m_flInaccuracyJumpApex` (non-zero only for the Desert Eagle). */
  readonly jumpApex: number;
  /** Added to the penalty's floor while reloading. */
  readonly reload: number;
}

export interface RecoilDef {
  /** Degrees from straight up, per mode. */
  readonly angle: Pair;
  readonly angleVariance: Pair;
  readonly magnitude: Pair;
  readonly magnitudeVariance: Pair;
  /** `m_nRecoilSeed`: seeds the per-bullet recoil table (recoil.ts). */
  readonly seed: number;
}

export interface RecoveryDef {
  /** Seconds for the accuracy penalty to decay by 90 % (×1/10), standing / crouched, at the first bullets. */
  readonly stand: number;
  readonly crouch: number;
  /** ... and from `transitionEndBullet` on (CS2 "final" recovery times). */
  readonly standFinal: number;
  readonly crouchFinal: number;
  readonly transitionStartBullet: number;
  readonly transitionEndBullet: number;
}

export interface ZoomDef {
  /** 0 = no scope; AWP, SSG 08, G3SG1, SCAR-20: 2; AUG, SG 553: 1. */
  readonly levels: number;
  /** FOV (degrees) at zoom level 1 and 2. */
  readonly fov: Pair;
  /** `m_flZoomTime0..2`. */
  readonly times: readonly [number, number, number];
  readonly unzoomsAfterShot: boolean;
}

export interface BurstDef {
  /** Cycle time after a 3-round burst (`m_flCycleTimeWhenInBurstMode`). */
  readonly cycleTime: number;
  /** Seconds between the rounds of a burst (`m_flTimeBetweenBurstShots`). Rounds per burst: `weaponModel.burstShots`. */
  readonly timeBetweenShots: number;
}

export interface WeaponDef {
  /** Short id used across this repo (`ak47`, `m4a4`, `m4a1s`, `he`, …). */
  readonly id: string;
  /** The CS2 entity class (`weapon_ak47`, `weapon_m4a1` = M4A4, `weapon_m4a1_silencer`, …). */
  readonly className: string;
  readonly kind: WeaponKind;
  /** `m_GearSlot` without the prefix: rifle, pistol, knife, grenades, c4, boosts, utility. */
  readonly gearSlot: string;
  readonly price: number;
  readonly killAward: number;
  /** Base damage per bullet. */
  readonly damage: number;
  /** `m_flArmorRatio`; the share of damage that reaches HP through armor is armorRatio × 0.5 (damage.ts). */
  readonly armorRatio: number;
  /** `m_flPenetration` (penetration power, penetration.ts). 0 = can't wallbang. */
  readonly penetration: number;
  /** Maximum bullet range, units. */
  readonly range: number;
  /** Damage × rangeModifier^(distance / 500). */
  readonly rangeModifier: number;
  readonly headshotMultiplier: number;
  /** Pellets per shot (shotguns 6–9). */
  readonly bullets: number;
  readonly fullAuto: boolean;
  /** Magazine size (0 for knife, grenades, c4). */
  readonly clip: number;
  /** `m_nPrimaryReserveAmmoMax`: magazines when `reserveAsClips`, else rounds. */
  readonly reserveMax: number;
  /** CS2 since March 2026: reserve counted in magazines (`m_bReserveAmmoAsClips`). */
  readonly reserveAsClips: boolean;
  /** Reserve rounds at purchase: reserveMax × clip when reserveAsClips, else reserveMax. */
  readonly reserve: number;
  /** Shotguns that load one shell at a time (Nova, XM1014, Sawed-Off). */
  readonly reloadsSingleShells: boolean;
  /** Seconds between shots, per mode. */
  readonly cycleTime: Pair;
  readonly burst: BurstDef | null;
  readonly revolver: boolean;
  /** Seconds from switching to the weapon until it can attack (`m_flDeployDuration`). */
  readonly deployTime: number;
  /**
   * `m_flDisallowAttackAfterReloadStartDuration`: seconds after a reload starts during which the weapon can't
   * attack. For magazine weapons this is the reload time; for shell-by-shell shotguns the start of the reload.
   */
  readonly reloadTime: number;
  /** Max player speed with the weapon drawn, per mode (scoped AWP 100). */
  readonly maxSpeed: Pair;
  /** Speed factor while attacking (Negev 0.5). */
  readonly attackMovespeedFactor: number;
  readonly spread: Pair;
  readonly inaccuracy: InaccuracyDef;
  readonly recoil: RecoilDef;
  readonly recovery: RecoveryDef;
  /** Victim speed modifier on a hit (tagging), large and small flinch. */
  readonly flinchLarge: number;
  readonly flinchSmall: number;
  readonly zoom: ZoomDef;
  readonly silencer: SilencerType;
  /** `m_nSpreadSeed` (shotgun spread patterns; 0 = none). */
  readonly spreadSeed: number;
  readonly tracerFrequency: number;
}

export interface WeaponTable {
  /** Where the numbers come from (docs/weapons.md). */
  readonly source: { readonly file: string; readonly repo: string; readonly commit: string; readonly sha256: string; readonly date: string };
  /** By id, sorted. */
  readonly weapons: Readonly<Record<string, WeaponDef>>;
  /** Sorted ids. */
  readonly ids: readonly string[];
  /**
   * Model spray patterns (recoil.ts `sprayPattern` at the reference tuning, standing still, holding ATTACK):
   * per spray weapon, per bullet `[pitch, yaw]` offset of the bullet direction in degrees (Source pitch, + = down;
   * yaw + = left). Regenerated by tools/extract-weapons.ts and checked against the engine by the tests.
   */
  readonly sprays: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}

export class WeaponTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeaponTableError';
  }
}

/** Validate parsed `data/weapons.json` and return a typed copy. Throws WeaponTableError naming the first bad field. */
export function parseWeaponTable(json: unknown): WeaponTable {
  const root = obj(json, 'weapons.json');
  const src = obj(root['source'], 'source');
  const source = {
    file: str(src['file'], 'source.file'),
    repo: str(src['repo'], 'source.repo'),
    commit: str(src['commit'], 'source.commit'),
    sha256: str(src['sha256'], 'source.sha256'),
    date: str(src['date'], 'source.date'),
  };
  const ws = obj(root['weapons'], 'weapons');
  const ids = Object.keys(ws).sort();
  if (ids.length === 0) throw new WeaponTableError('weapons: empty');
  const weapons: Record<string, WeaponDef> = {};
  for (const id of ids) weapons[id] = parseWeapon(id, ws[id]);
  const sp = obj(root['sprays'] ?? {}, 'sprays');
  const sprays: Record<string, (readonly [number, number])[]> = {};
  for (const id of Object.keys(sp).sort()) {
    if (weapons[id] === undefined) throw new WeaponTableError(`sprays.${id}: no such weapon`);
    const rows = sp[id];
    if (!Array.isArray(rows)) throw new WeaponTableError(`sprays.${id}: expected an array`);
    sprays[id] = rows.map((r, i) => pair(r, `sprays.${id}[${i}]`, -90, 90));
  }
  return { source, weapons, ids, sprays };
}

/** The weapon `id`, or a WeaponTableError. */
export function weaponDef(table: WeaponTable, id: string): WeaponDef {
  const w = table.weapons[id];
  if (w === undefined) throw new WeaponTableError(`no weapon '${id}'`);
  return w;
}

/** True for weapons that fire bullets (guns and the Zeus). */
export function shoots(w: WeaponDef): boolean {
  return w.clip > 0 && w.kind !== 'grenade' && w.kind !== 'c4' && w.kind !== 'equipment' && w.kind !== 'knife';
}

function parseWeapon(id: string, value: unknown): WeaponDef {
  const p = `weapons.${id}`;
  const w = obj(value, p);
  const n = (k: string, min = 0, max = 1e9): number => num(w[k], `${p}.${k}`, min, max);
  const pr = (k: string, min = 0, max = 1e9): Pair => pair(w[k], `${p}.${k}`, min, max);
  const kind = oneOf(w['kind'], WEAPON_KINDS, `${p}.kind`);
  const inacc = obj(w['inaccuracy'], `${p}.inaccuracy`);
  const ip = (k: string): Pair => pair(inacc[k], `${p}.inaccuracy.${k}`, 0, 2);
  const rec = obj(w['recoil'], `${p}.recoil`);
  const rp = (k: string, min: number, max: number): Pair => pair(rec[k], `${p}.recoil.${k}`, min, max);
  const recov = obj(w['recovery'], `${p}.recovery`);
  const rv = (k: string, max = 10): number => num(recov[k], `${p}.recovery.${k}`, -1, max); // -1 = unset (equipment)
  const zoom = obj(w['zoom'], `${p}.zoom`);
  const times = zoom['times'];
  if (!Array.isArray(times) || times.length !== 3) throw new WeaponTableError(`${p}.zoom.times: expected 3 numbers`);
  const burstRaw = w['burst'];
  let burst: BurstDef | null = null;
  if (burstRaw !== null) {
    const b = obj(burstRaw, `${p}.burst`);
    burst = { cycleTime: num(b['cycleTime'], `${p}.burst.cycleTime`, 0, 10), timeBetweenShots: num(b['timeBetweenShots'], `${p}.burst.timeBetweenShots`, 0, 10) };
  }
  const def: WeaponDef = {
    id: str(w['id'], `${p}.id`),
    className: str(w['className'], `${p}.className`),
    kind,
    gearSlot: str(w['gearSlot'], `${p}.gearSlot`),
    price: n('price', 0, 20000),
    killAward: n('killAward', 0, 5000),
    damage: n('damage', 0, 1000),
    armorRatio: n('armorRatio', 0, 2),
    penetration: n('penetration', 0, 10),
    range: n('range', 0, 20000),
    rangeModifier: n('rangeModifier', 0, 1),
    headshotMultiplier: n('headshotMultiplier', 0, 10),
    bullets: n('bullets', 1, 20),
    fullAuto: bool(w['fullAuto'], `${p}.fullAuto`),
    clip: n('clip', 0, 1000),
    reserveMax: n('reserveMax', 0, 1000),
    reserveAsClips: bool(w['reserveAsClips'], `${p}.reserveAsClips`),
    reserve: n('reserve', 0, 10000),
    reloadsSingleShells: bool(w['reloadsSingleShells'], `${p}.reloadsSingleShells`),
    cycleTime: pr('cycleTime', 0, 10),
    burst,
    revolver: bool(w['revolver'], `${p}.revolver`),
    deployTime: n('deployTime', 0, 10),
    reloadTime: n('reloadTime', 0, 10),
    maxSpeed: pr('maxSpeed', 0, 400),
    attackMovespeedFactor: n('attackMovespeedFactor', 0, 1),
    spread: pr('spread', 0, 1),
    inaccuracy: {
      stand: ip('stand'),
      crouch: ip('crouch'),
      move: ip('move'),
      jump: ip('jump'),
      land: ip('land'),
      ladder: ip('ladder'),
      fire: ip('fire'),
      jumpInitial: num(inacc['jumpInitial'], `${p}.inaccuracy.jumpInitial`, 0, 2),
      jumpApex: num(inacc['jumpApex'], `${p}.inaccuracy.jumpApex`, 0, 2),
      reload: num(inacc['reload'], `${p}.inaccuracy.reload`, 0, 2),
    },
    recoil: {
      angle: rp('angle', -180, 180),
      angleVariance: rp('angleVariance', 0, 180),
      magnitude: rp('magnitude', 0, 1000),
      magnitudeVariance: rp('magnitudeVariance', 0, 1000),
      seed: num(rec['seed'], `${p}.recoil.seed`, 0, 2147483647),
    },
    recovery: {
      stand: rv('stand'),
      crouch: rv('crouch'),
      standFinal: rv('standFinal'),
      crouchFinal: rv('crouchFinal'),
      transitionStartBullet: rv('transitionStartBullet', 1000),
      transitionEndBullet: rv('transitionEndBullet', 1000),
    },
    flinchLarge: n('flinchLarge', 0, 1),
    flinchSmall: n('flinchSmall', 0, 1),
    zoom: {
      levels: num(zoom['levels'], `${p}.zoom.levels`, 0, 2),
      fov: pair(zoom['fov'], `${p}.zoom.fov`, 1, 180),
      times: [num(times[0], `${p}.zoom.times[0]`, 0, 10), num(times[1], `${p}.zoom.times[1]`, 0, 10), num(times[2], `${p}.zoom.times[2]`, 0, 10)],
      unzoomsAfterShot: bool(zoom['unzoomsAfterShot'], `${p}.zoom.unzoomsAfterShot`),
    },
    silencer: oneOf(w['silencer'], SILENCER_TYPES, `${p}.silencer`),
    spreadSeed: n('spreadSeed', 0, 2147483647),
    tracerFrequency: n('tracerFrequency', 0, 100),
  };
  if (def.id !== id) throw new WeaponTableError(`${p}.id: '${def.id}' does not match its key`);
  for (const k of ['bullets', 'clip', 'reserveMax', 'reserve', 'price', 'killAward', 'spreadSeed'] as const) {
    if (!Number.isInteger(def[k])) throw new WeaponTableError(`${p}.${k}: expected an integer, got ${def[k]}`);
  }
  if (def.reserve !== (def.reserveAsClips ? def.reserveMax * def.clip : def.reserveMax)) throw new WeaponTableError(`${p}.reserve: must be reserveMax${def.reserveAsClips ? ' × clip' : ''}`);
  if (def.recovery.transitionEndBullet < def.recovery.transitionStartBullet) throw new WeaponTableError(`${p}.recovery: transitionEndBullet < transitionStartBullet`);
  return def;
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new WeaponTableError(`${path}: expected an object`);
  return v as Record<string, unknown>;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new WeaponTableError(`${path}: expected a non-empty string`);
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new WeaponTableError(`${path}: expected true or false`);
  return v;
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new WeaponTableError(`${path}: expected a finite number, got ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
  if (v < min || v > max) throw new WeaponTableError(`${path}: ${v} is outside [${min}, ${max}]`);
  return v;
}

function pair(v: unknown, path: string, min: number, max: number): Pair {
  if (!Array.isArray(v) || v.length !== 2) throw new WeaponTableError(`${path}: expected [primary, alt]`);
  return [num(v[0], `${path}[0]`, min, max), num(v[1], `${path}[1]`, min, max)];
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new WeaponTableError(`${path}: expected one of ${allowed.join(', ')}`);
  return v as T;
}
