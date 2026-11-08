/**
 * Round data: the shape of data/round.json (written by tools/extract-round.ts,
 * documented in docs/round-data.md) and `parseRound`, its validating loader.
 *
 * No file I/O here: callers read the file and pass the parsed JSON (or its text).
 * Portable style (docs/port-notes.md): readonly plain data. The only optional
 * fields in the repo are `TrackSample.uncertainty` and `TrackSample.resampled`,
 * because the generated file omits them, and (G3) `TrackSample.jump`, which only
 * `applyTracks3d` (src/contracts/tracks3d.ts) sets; read them as nullable.
 */
import { PLAYER_IDS, TEAMS, WEAPON_IDS, isPlayerId, type PlayerId, type Team, type Vec3, type WeaponId } from './types';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export const TICKS_PER_SEC = 64;

/** Video seconds -> integer tick (`Math.round`, half up). */
export function toTick(t: number): number {
  return Math.round(t * TICKS_PER_SEC);
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** How a position (or shot) was obtained, from most to least certain. */
export const CONFIDENCES = ['observed', 'estimated', 'inferred'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const GRENADE_IDS = ['smoke', 'flash', 'he', 'molotov'] as const;
export type GrenadeId = (typeof GRENADE_IDS)[number];

export const SHOT_KINDS = ['shot', 'shot_kill', 'hit', 'kill', 'shot_count', 'switch'] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface MapTransform {
  readonly posx: number;
  readonly posy: number;
  readonly scale: number;
  readonly size: number;
}

export interface RoundMeta {
  /** Seconds on the round clock at t = 0 (98.25). */
  readonly clock0: number;
  readonly bombTimerSec: number;
  readonly score: { readonly ct: number; readonly t: number };
  readonly scoreAfter: { readonly ct: number; readonly t: number };
  readonly teams: { readonly CT: string; readonly T: string };
  readonly map: MapTransform;
  readonly video: string;
  readonly durationSec: number;
  readonly roundEndT: number;
  readonly roundEndTick: number;
  readonly hudRound: string;
  readonly ticksPerSec: number;
  readonly sources: {
    readonly html: { readonly file: string; readonly sha256: string };
    readonly shotsCsv: { readonly file: string; readonly sha256: string; readonly rows: number };
    /** V2: the view fit merged into the tracks (data/source/view-fit.json). */
    readonly viewFit?: { readonly file: string; readonly sha256: string };
  };
}

export interface Kit {
  readonly primary: WeaponId | null;
  readonly secondary: WeaponId | null;
  readonly grenades: readonly GrenadeId[];
  readonly c4: boolean;
  /** Defuse kit. */
  readonly kit: boolean;
  /** Clip/reserve of the weapon drawn at t = 0 (primary if any, else secondary). */
  readonly clip: number;
  readonly reserve: number;
  /** True when the loadout is an assumption (not seen in the recording). */
  readonly assumed: boolean;
}

export interface Pickup {
  readonly t: number;
  readonly tick: number;
  readonly weapon: WeaponId;
}

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  readonly team: Team;
  readonly color: string;
  readonly chev: string;
  readonly start: { readonly pos: Vec3; readonly yaw: number | null; readonly confidence: Confidence };
  readonly startHp: number;
  readonly startArmor: number;
  readonly startHelmet: boolean;
  readonly startMoney: number | null;
  readonly kit: Kit;
  readonly pickups: readonly Pickup[];
  readonly role: string;
  readonly roles: readonly string[];
  readonly isHumanDefault: boolean;
  readonly deathT: number | null;
  readonly deathTick: number | null;
  readonly note: string;
}

export interface TrackSample {
  readonly t: number;
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly confidence: Confidence;
  /** Radius in world units; present only for non-observed samples whose source carries one (CTs). */
  readonly uncertainty?: number;
  /** True when this 10 Hz grid sample was linearly interpolated from off-grid source samples. */
  readonly resampled?: boolean;
  /**
   * G3: the player jumps from here to the next sample (a climb only a jump makes on CS2 Mirage; `crouch` = a crouch
   * jump). Not in round.json: `applyTracks3d` sets it from data/geometry/mirage-tracks.json.
   */
  readonly jump?: 'plain' | 'crouch';
  /**
   * V2: x / y (and z) were moved from the radar reading to where the video's first-person frames put the player
   * (`data/source/view-fit.json` `positions`, docs/round-data.md "View fit: position refinements").
   */
  readonly refined?: 'viewfit';
}

/** Where a view sample comes from (V2, docs/viewfit.md). */
export const VIEW_SOURCES = ['video', 'radar'] as const;
export type ViewSource = (typeof VIEW_SOURCES)[number];

/**
 * V2: the watched player's view, fitted to the video frame (`source: 'video'`): yaw and pitch from aligning the CS2
 * mesh with the frame. Where the fit fails, the radar yaw is kept (`source: 'radar'`, `pitch: null`).
 * `confidence`: `observed` = a clear fit; `estimated` = a plausible but ambiguous fit (or the radar fallback);
 * `inferred` = held from the first fitted frame of a camera segment back across the spectator's camera switch.
 */
export interface ViewSample {
  readonly t: number;
  readonly tick: number;
  /** Degrees counter-clockwise from +x. */
  readonly yaw: number;
  /** Source's (positive = down), within ±89; null when only the radar yaw is known. */
  readonly pitch: number | null;
  readonly source: ViewSource;
  readonly confidence: Confidence;
}

export interface YawSample {
  readonly t: number;
  readonly tick: number;
  readonly deg: number;
}

export interface Track {
  /** 10 Hz samples on the exact 0.1 s grid from t = 0. */
  readonly samples: readonly TrackSample[];
  /** Source samples that were not on the 0.1 s grid, kept verbatim (event anchors). */
  readonly offGridSamples: readonly TrackSample[];
  readonly yaw: readonly YawSample[];
  /** V2: the fitted first-person view while the camera watches this player (empty for the others), by time. */
  readonly view: readonly ViewSample[];
  readonly endT: number;
  readonly endTick: number;
}

export interface Shot {
  /** null for count-only rows whose time is unknown (see window). */
  readonly t: number | null;
  readonly tick: number | null;
  readonly window: { readonly t0: number; readonly tick0: number; readonly t1: number; readonly tick1: number } | null;
  readonly count: number;
  readonly shooter: PlayerId;
  readonly weapon: WeaponId;
  readonly kind: ShotKind;
  readonly target: PlayerId | null;
  readonly damage: number | null;
  readonly armorDamage: number | null;
  readonly headshot: boolean;
  readonly confidence: Confidence;
  /** Every CSV column verbatim, keyed by its header. */
  readonly raw: Readonly<Record<string, string>>;
}

export interface Kill {
  readonly t: number;
  readonly tick: number;
  readonly killer: PlayerId;
  readonly victim: PlayerId;
  readonly weapon: WeaponId;
  readonly hs: boolean;
  readonly assist: PlayerId | null;
  readonly postRound: boolean;
  readonly kpos: Vec3;
  readonly vpos: Vec3;
  readonly kplace: string;
  readonly vplace: string;
}

export interface Damage {
  readonly t: number;
  readonly tick: number;
  readonly attacker: PlayerId;
  readonly victim: PlayerId;
  readonly amount: number;
  readonly armor: number | null;
  readonly weapon: WeaponId;
  readonly note: string;
  readonly apos: Vec3 | null;
  readonly vpos: Vec3 | null;
  readonly source: 'damage' | 'shots_csv';
}

export interface Utility {
  readonly t: number;
  readonly tick: number;
  readonly thrower: PlayerId;
  readonly kind: GrenadeId;
  readonly place: string;
  /** Thrower's position at the throw. */
  readonly throwPos: Vec3;
  /**
   * V0: where the grenade comes to rest and pops (smoke bloom, flash/HE detonation, molotov fire), measured from the
   * recording, with its uncertainty (units, radius); `null` when the recording never shows it (docs/round-data.md).
   */
  readonly landing: GrenadeLanding | null;
  readonly radio: string;
  /**
   * S1: the release view angles (Source degrees; pitch positive = down) that land this throw on `landing` with the CS2
   * grenade engine. Not in round.json: `applyTracks3d` sets it from data/geometry/mirage-tracks.json `utility`.
   */
  readonly aim?: { readonly pitch: number; readonly yaw: number };
}

/** A measured grenade landing (Source units). */
export interface GrenadeLanding {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly uncertainty: number;
}

export interface Radio {
  readonly t: number;
  readonly tick: number;
  readonly who: PlayerId;
  readonly place: string;
  readonly text: string;
  readonly kind: 'radio' | 'callout';
}

export interface Chat {
  readonly t: number;
  readonly tick: number;
  readonly who: PlayerId;
  readonly dead: boolean;
  readonly text: string;
}

export interface Sighting {
  readonly who: PlayerId;
  readonly t0: number;
  readonly tick0: number;
  readonly t1: number;
  readonly tick1: number;
  readonly place: string;
  readonly by: string;
}

export interface LastKnown {
  readonly who: PlayerId;
  readonly t0: number;
  readonly tick0: number;
  readonly t1: number;
  readonly tick1: number;
  readonly pos: Vec2;
}

export interface PovSegment {
  readonly t0: number;
  readonly tick0: number;
  readonly t1: number;
  readonly tick1: number;
  readonly target: PlayerId;
  readonly note: string;
}

export interface RoundEvent {
  readonly t: number;
  readonly tick: number;
  readonly kind: string;
  readonly text: string;
  readonly who: PlayerId | null;
  readonly victim: PlayerId | null;
  readonly util: GrenadeId | null;
}

export interface Bomb {
  readonly carrier: PlayerId;
  readonly plantT: number;
  readonly plantTick: number;
  readonly pos: Vec3;
  readonly defuseStartT: number;
  readonly defuseStartTick: number;
  readonly defuseT: number;
  readonly defuseTick: number;
}

export interface TimelinePoint {
  readonly t: number;
  readonly tick: number;
  readonly value: number;
}

export interface WeaponTimelinePoint {
  readonly t: number;
  readonly tick: number;
  readonly weapon: WeaponId | null;
  readonly raw: string;
}

/** The whole of data/round.json. Objects keyed by player id are written in id order; never iterate them for output. */
export interface RoundData {
  readonly meta: RoundMeta;
  /** Sorted by id. */
  readonly players: readonly Player[];
  readonly tracks: Readonly<Record<string, Track>>;
  /** One per shots-CSV row, in CSV order. */
  readonly shots: readonly Shot[];
  readonly kills: readonly Kill[];
  readonly damage: readonly Damage[];
  readonly utility: readonly Utility[];
  readonly radio: readonly Radio[];
  readonly chat: readonly Chat[];
  readonly sightings: readonly Sighting[];
  readonly lastKnown: readonly LastKnown[];
  readonly pov: readonly PovSegment[];
  readonly bomb: Bomb;
  readonly timelines: {
    readonly hp: Readonly<Record<string, readonly TimelinePoint[]>>;
    readonly money: Readonly<Record<string, readonly TimelinePoint[]>>;
    readonly weapon: Readonly<Record<string, readonly WeaponTimelinePoint[]>>;
  };
  readonly events: readonly RoundEvent[];
}

// ---------------------------------------------------------------------------
// parseRound
// ---------------------------------------------------------------------------

export class RoundDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundDataError';
  }
}

/**
 * Validate parsed round JSON (or its text) and return it typed. Throws RoundDataError
 * naming the first bad field.
 *
 * Checked in depth (the fields the Core uses): meta.clock0/bombTimerSec/ticksPerSec/
 * roundEnd, players (all ten, sorted by id), tracks (one per player, samples strictly
 * increasing), shots, kills, damage, utility, radio, chat, bomb, timelines.weapon and
 * events. Every `tick` must equal `toTick` of its `t`. Everything else (meta.score/
 * teams/map/sources, sightings, lastKnown, pov, timelines.hp/money, shot `raw`) is
 * checked for container shape only. Extra keys are ignored. The input is returned as
 * is (not copied).
 */
export function parseRound(json: unknown): RoundData {
  const root = obj(typeof json === 'string' ? parseText(json) : json, 'round');

  const meta = obj(root['meta'], 'meta');
  num(meta['clock0'], 'meta.clock0');
  num(meta['bombTimerSec'], 'meta.bombTimerSec');
  if (meta['ticksPerSec'] !== TICKS_PER_SEC) fail('meta.ticksPerSec', `expected ${TICKS_PER_SEC}`);
  timed(meta, 'roundEndT', 'roundEndTick', 'meta');
  for (const key of ['score', 'scoreAfter', 'teams', 'map', 'sources']) obj(meta[key], `meta.${key}`);

  const players = arr(root['players'], 'players');
  if (players.length !== PLAYER_IDS.length) fail('players', `expected ${PLAYER_IDS.length} players, got ${players.length}`);
  players.forEach((p, i) => checkPlayer(p, i));

  const tracks = obj(root['tracks'], 'tracks');
  for (const id of PLAYER_IDS) checkTrack(tracks[id], `tracks.${id}`);

  arr(root['shots'], 'shots').forEach((s, i) => checkShot(s, `shots[${i}]`));
  arr(root['kills'], 'kills').forEach((k, i) => checkKill(k, `kills[${i}]`));
  arr(root['damage'], 'damage').forEach((d, i) => checkDamage(d, `damage[${i}]`));
  arr(root['utility'], 'utility').forEach((u, i) => checkUtility(u, `utility[${i}]`));
  arr(root['radio'], 'radio').forEach((r, i) => {
    const o = timedObj(r, `radio[${i}]`);
    pid(o['who'], `radio[${i}].who`);
    str(o['text'], `radio[${i}].text`);
    str(o['place'], `radio[${i}].place`);
    oneOf(o['kind'], ['radio', 'callout'], `radio[${i}].kind`);
  });
  arr(root['chat'], 'chat').forEach((c, i) => {
    const o = timedObj(c, `chat[${i}]`);
    pid(o['who'], `chat[${i}].who`);
    bool(o['dead'], `chat[${i}].dead`);
    str(o['text'], `chat[${i}].text`);
  });
  for (const key of ['sightings', 'lastKnown', 'pov']) arr(root[key], key);

  const bomb = obj(root['bomb'], 'bomb');
  pid(bomb['carrier'], 'bomb.carrier');
  vec3(bomb['pos'], 'bomb.pos');
  timed(bomb, 'plantT', 'plantTick', 'bomb');
  timed(bomb, 'defuseStartT', 'defuseStartTick', 'bomb');
  timed(bomb, 'defuseT', 'defuseTick', 'bomb');

  const timelines = obj(root['timelines'], 'timelines');
  obj(timelines['hp'], 'timelines.hp');
  obj(timelines['money'], 'timelines.money');
  const weapons = obj(timelines['weapon'], 'timelines.weapon');
  for (const id of Object.keys(weapons).sort()) {
    if (!isPlayerId(id)) fail(`timelines.weapon.${id}`, 'unknown player id');
    arr(weapons[id], `timelines.weapon.${id}`).forEach((w, i) => {
      const o = timedObj(w, `timelines.weapon.${id}[${i}]`);
      nullable(o['weapon'], `timelines.weapon.${id}[${i}].weapon`, weapon);
      str(o['raw'], `timelines.weapon.${id}[${i}].raw`);
    });
  }

  arr(root['events'], 'events').forEach((e, i) => {
    const o = timedObj(e, `events[${i}]`);
    str(o['kind'], `events[${i}].kind`);
    str(o['text'], `events[${i}].text`);
    nullable(o['who'], `events[${i}].who`, pid);
    nullable(o['victim'], `events[${i}].victim`, pid);
    nullable(o['util'], `events[${i}].util`, grenade);
  });

  return root as unknown as RoundData;
}

function checkPlayer(value: unknown, i: number): void {
  const path = `players[${i}]`;
  const p = obj(value, path);
  const id = pid(p['id'], `${path}.id`);
  if (id !== PLAYER_IDS[i]) fail(`${path}.id`, `expected ${PLAYER_IDS[i] ?? '?'} (players sorted by id), got ${id}`);
  str(p['name'], `${path}.name`);
  oneOf(p['team'], TEAMS, `${path}.team`);
  const start = obj(p['start'], `${path}.start`);
  vec3(start['pos'], `${path}.start.pos`);
  nullable(start['yaw'], `${path}.start.yaw`, num);
  oneOf(start['confidence'], CONFIDENCES, `${path}.start.confidence`);
  num(p['startHp'], `${path}.startHp`);
  num(p['startArmor'], `${path}.startArmor`);
  bool(p['startHelmet'], `${path}.startHelmet`);
  const kit = obj(p['kit'], `${path}.kit`);
  nullable(kit['primary'], `${path}.kit.primary`, weapon);
  nullable(kit['secondary'], `${path}.kit.secondary`, weapon);
  arr(kit['grenades'], `${path}.kit.grenades`).forEach((g, j) => grenade(g, `${path}.kit.grenades[${j}]`));
  bool(kit['c4'], `${path}.kit.c4`);
  bool(kit['kit'], `${path}.kit.kit`);
  num(kit['clip'], `${path}.kit.clip`);
  num(kit['reserve'], `${path}.kit.reserve`);
  bool(kit['assumed'], `${path}.kit.assumed`);
  arr(p['pickups'], `${path}.pickups`).forEach((k, j) => {
    const o = timedObj(k, `${path}.pickups[${j}]`);
    weapon(o['weapon'], `${path}.pickups[${j}].weapon`);
  });
  str(p['role'], `${path}.role`);
  arr(p['roles'], `${path}.roles`).forEach((r, j) => str(r, `${path}.roles[${j}]`));
  bool(p['isHumanDefault'], `${path}.isHumanDefault`);
  if (p['deathT'] === null) {
    if (p['deathTick'] !== null) fail(`${path}.deathTick`, 'expected null when deathT is null');
  } else timed(p, 'deathT', 'deathTick', path);
}

function checkSample(value: unknown, path: string): number {
  const s = timedObj(value, path);
  num(s['x'], `${path}.x`);
  num(s['y'], `${path}.y`);
  num(s['z'], `${path}.z`);
  oneOf(s['confidence'], CONFIDENCES, `${path}.confidence`);
  if (s['uncertainty'] !== undefined) num(s['uncertainty'], `${path}.uncertainty`);
  if (s['resampled'] !== undefined) bool(s['resampled'], `${path}.resampled`);
  if (s['jump'] !== undefined) oneOf(s['jump'], ['plain', 'crouch'] as const, `${path}.jump`);
  if (s['refined'] !== undefined) oneOf(s['refined'], ['viewfit'] as const, `${path}.refined`);
  return s['t'] as number;
}

function checkTrack(value: unknown, path: string): void {
  const tr = obj(value, path);
  const samples = arr(tr['samples'], `${path}.samples`);
  if (samples.length === 0) fail(`${path}.samples`, 'empty track');
  let prev = Number.NEGATIVE_INFINITY;
  samples.forEach((s, i) => {
    const t = checkSample(s, `${path}.samples[${i}]`);
    if (!(t > prev)) fail(`${path}.samples[${i}].t`, 'samples not strictly increasing');
    prev = t;
  });
  arr(tr['offGridSamples'], `${path}.offGridSamples`).forEach((s, i) => checkSample(s, `${path}.offGridSamples[${i}]`));
  arr(tr['yaw'], `${path}.yaw`).forEach((y, i) => num(timedObj(y, `${path}.yaw[${i}]`)['deg'], `${path}.yaw[${i}].deg`));
  let prevView = Number.NEGATIVE_INFINITY;
  arr(tr['view'], `${path}.view`).forEach((v, i) => {
    const p = `${path}.view[${i}]`;
    const o = timedObj(v, p);
    num(o['yaw'], `${p}.yaw`);
    const pitch = nullable(o['pitch'], `${p}.pitch`, num);
    if (pitch !== null && Math.abs(pitch) > 89) fail(`${p}.pitch`, 'outside ±89');
    const source = oneOf(o['source'], VIEW_SOURCES, `${p}.source`);
    if (source === 'radar' && pitch !== null) fail(`${p}.pitch`, 'radar views have no pitch');
    oneOf(o['confidence'], CONFIDENCES, `${p}.confidence`);
    const t = o['t'] as number;
    if (!(t > prevView)) fail(`${p}.t`, 'view samples not strictly increasing');
    prevView = t;
  });
  timed(tr, 'endT', 'endTick', path);
}

function checkShot(value: unknown, path: string): void {
  const s = obj(value, path);
  if (s['t'] === null) {
    if (s['tick'] !== null) fail(`${path}.tick`, 'expected null when t is null');
    const w = obj(s['window'], `${path}.window`);
    timed(w, 't0', 'tick0', `${path}.window`);
    timed(w, 't1', 'tick1', `${path}.window`);
  } else {
    timed(s, 't', 'tick', path);
    if (s['window'] !== null) fail(`${path}.window`, 'expected null when t is set');
  }
  num(s['count'], `${path}.count`);
  pid(s['shooter'], `${path}.shooter`);
  weapon(s['weapon'], `${path}.weapon`);
  oneOf(s['kind'], SHOT_KINDS, `${path}.kind`);
  nullable(s['target'], `${path}.target`, pid);
  nullable(s['damage'], `${path}.damage`, num);
  nullable(s['armorDamage'], `${path}.armorDamage`, num);
  bool(s['headshot'], `${path}.headshot`);
  oneOf(s['confidence'], CONFIDENCES, `${path}.confidence`);
  obj(s['raw'], `${path}.raw`);
}

function checkKill(value: unknown, path: string): void {
  const k = timedObj(value, path);
  pid(k['killer'], `${path}.killer`);
  pid(k['victim'], `${path}.victim`);
  weapon(k['weapon'], `${path}.weapon`);
  bool(k['hs'], `${path}.hs`);
  nullable(k['assist'], `${path}.assist`, pid);
  bool(k['postRound'], `${path}.postRound`);
  vec3(k['kpos'], `${path}.kpos`);
  vec3(k['vpos'], `${path}.vpos`);
  str(k['kplace'], `${path}.kplace`);
  str(k['vplace'], `${path}.vplace`);
}

function checkDamage(value: unknown, path: string): void {
  const d = timedObj(value, path);
  pid(d['attacker'], `${path}.attacker`);
  pid(d['victim'], `${path}.victim`);
  num(d['amount'], `${path}.amount`);
  nullable(d['armor'], `${path}.armor`, num);
  weapon(d['weapon'], `${path}.weapon`);
  str(d['note'], `${path}.note`);
  nullable(d['apos'], `${path}.apos`, vec3);
  nullable(d['vpos'], `${path}.vpos`, vec3);
  oneOf(d['source'], ['damage', 'shots_csv'], `${path}.source`);
}

function checkUtility(value: unknown, path: string): void {
  const u = timedObj(value, path);
  pid(u['thrower'], `${path}.thrower`);
  grenade(u['kind'], `${path}.kind`);
  str(u['place'], `${path}.place`);
  vec3(u['throwPos'], `${path}.throwPos`);
  nullable(u['landing'], `${path}.landing`, (v, p) => {
    vec3(v, p);
    num((v as Record<string, unknown>)['uncertainty'], `${p}.uncertainty`);
  });
  str(u['radio'], `${path}.radio`);
}

// ---------- primitive checks ----------

function fail(path: string, message: string): never {
  throw new RoundDataError(`${path}: ${message}`);
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new RoundDataError(`round: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, `expected an object, got ${show(value)}`);
  return value as Record<string, unknown>;
}

function arr(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, `expected an array, got ${show(value)}`);
  return value as readonly unknown[];
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `expected a finite number, got ${show(value)}`);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, `expected a string, got ${show(value)}`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, `expected a boolean, got ${show(value)}`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `expected one of ${allowed.join('|')}, got ${show(value)}`);
  }
  return value as T;
}

function nullable<T>(value: unknown, path: string, check: (v: unknown, p: string) => T): T | null {
  return value === null ? null : check(value, path);
}

function pid(value: unknown, path: string): PlayerId {
  return oneOf(value, PLAYER_IDS, path);
}

function weapon(value: unknown, path: string): WeaponId {
  return oneOf(value, WEAPON_IDS, path);
}

function grenade(value: unknown, path: string): GrenadeId {
  return oneOf(value, GRENADE_IDS, path);
}

function vec3(value: unknown, path: string): Vec3 {
  const v = obj(value, path);
  num(v['x'], `${path}.x`);
  num(v['y'], `${path}.y`);
  num(v['z'], `${path}.z`);
  return v as unknown as Vec3;
}

/** Checks `parent[tKey]` is a number and `parent[tickKey] === toTick(parent[tKey])`. */
function timed(parent: Record<string, unknown>, tKey: string, tickKey: string, path: string): void {
  const t = num(parent[tKey], `${path}.${tKey}`);
  const tick = num(parent[tickKey], `${path}.${tickKey}`);
  if (tick !== toTick(t)) fail(`${path}.${tickKey}`, `expected ${toTick(t)} (= round(${t} * ${TICKS_PER_SEC})), got ${tick}`);
}

function timedObj(value: unknown, path: string): Record<string, unknown> {
  const o = obj(value, path);
  timed(o, 't', 'tick', path);
  return o;
}
