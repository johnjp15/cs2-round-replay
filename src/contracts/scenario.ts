/**
 * H3: a scenario (`data/scenarios/<name>.json`, docs/scenarios.md): a map, round rules, the players' start state and
 * optionally a recording to play. The Mirage round is one (`mirage-sp4rtan-1v3`, recording `data/round.json`); a
 * scenario without a recording is **free play**: every bot is LIVE from the first tick and the human may take any pawn.
 *
 * Not to be confused with the human-bot scripts in `fixtures/scenarios/` (tools/human-bot.ts, `--scenario`), which
 * script a human through the recorded round; the harnesses take this kind with `--game`.
 *
 * Pure data and a validating parser (no map lookups: `checkScenarioOnMap` in src/core/free-play.ts does those).
 */
import { MAP_IDS, isMapId, type MapId } from './maps';
import { GRENADE_IDS, type GrenadeId } from './round';
import { PLAYER_IDS, TEAMS, WEAPON_IDS, isPlayerId, type PlayerId, type Team, type Vec3, type WeaponId } from './types';

export const SCENARIO_FORMAT = 'cs2-round-replay/scenario@1';

/** The bots' skill (docs/scenarios.md: how each scales `tuning.ai`); `normal` is the tuning as it is. */
export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];

export interface ScenarioRules {
  /** C4 fuse (CS2 mp_c4timer 40). */
  readonly c4TimerSec: number;
  /** mp_freezetime: bots wait and the human can only look around (CS2 15; free play here defaults to 0). */
  readonly freezeTimeSec: number;
  /** mp_roundtime_defuse in seconds (CS2 1:55 = 115). */
  readonly roundTimeSec: number;
  readonly score: { readonly ct: number; readonly t: number };
  readonly botDifficulty: BotDifficulty;
  /** Free play: the site the Ts go for ("A", "B"), or null for a seeded pick. */
  readonly site: string | null;
}

export interface ScenarioWeapon {
  readonly weapon: WeaponId;
  /** Rounds in the magazine and in reserve (0 for the knife and the c4). */
  readonly clip: number;
  readonly reserve: number;
}

export interface ScenarioPlayer {
  /** The pawn slot: one of the ten contract ids (src/contracts/types.ts PLAYER_IDS). */
  readonly id: PlayerId;
  /** Display name. */
  readonly name: string;
  readonly team: Team;
  /** Start position, or null for the map's spawn number `spawn` of the team (map.json). */
  readonly pos: Vec3 | null;
  readonly spawn: number | null;
  /** Start yaw (degrees), or null for the spawn's. */
  readonly yaw: number | null;
  readonly hp: number;
  readonly armor: number;
  readonly helmet: boolean;
  readonly kit: boolean;
  readonly c4: boolean;
  /** Guns (the first is drawn), with ammo; the knife is always there. */
  readonly weapons: readonly ScenarioWeapon[];
  readonly grenades: readonly GrenadeId[];
  readonly money: number;
  /** LIVE role in free play (docs/ai.md), or null for the default (the c4 carrier plants, Ts take the site, CTs retake). */
  readonly role: string | null;
  /** Where the role holds (null: from the map's bomb sites). */
  readonly hold: Vec3 | null;
}

export interface ScenarioRecording {
  /** Repo-relative path of a `round.json` (or the round data itself). */
  readonly round: string | unknown;
  /** The pawn a watching player may take over (G4), or null. */
  readonly playable: PlayerId | null;
}

export interface Scenario {
  readonly format: string;
  /** File name without `.json`. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly map: MapId;
  readonly seed: number;
  readonly rules: ScenarioRules;
  /** Free play: exactly the ten pawn slots (RoundModel's roster); with a recording: empty (the recording has them). */
  readonly players: readonly ScenarioPlayer[];
  readonly recording: ScenarioRecording | null;
  /** The pawn the human plays from the start, or null to watch. */
  readonly human: PlayerId | null;
}

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
}

function fail(path: string, why: string): never {
  throw new ScenarioError(`scenario: ${path}: ${why}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected an object');
  return v as Record<string, unknown>;
}

function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a number');
  if (v < min || v > max) fail(path, `expected ${min} … ${max}, got ${v}`);
  return v;
}

function int(v: unknown, path: string, min: number, max: number): number {
  const n = num(v, path, min, max);
  if (!Number.isInteger(n)) fail(path, 'expected an integer');
  return n;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'expected a string');
  return v;
}

function bool(v: unknown, path: string, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') fail(path, 'expected true or false');
  return v;
}

function vecOrNull(v: unknown, path: string): Vec3 | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    if (v.length !== 3) fail(path, 'expected [x, y, z]');
    return { x: num(v[0], `${path}[0]`), y: num(v[1], `${path}[1]`), z: num(v[2], `${path}[2]`) };
  }
  const o = obj(v, path);
  return { x: num(o['x'], `${path}.x`), y: num(o['y'], `${path}.y`), z: num(o['z'], `${path}.z`) };
}

/** CS2 competitive defaults (mp_c4timer 40, mp_freezetime 15, mp_roundtime_defuse 1.92 min). */
export const CS2_RULES: ScenarioRules = { c4TimerSec: 40, freezeTimeSec: 15, roundTimeSec: 115, score: { ct: 0, t: 0 }, botDifficulty: 'normal', site: null };

const GUNS: readonly WeaponId[] = WEAPON_IDS.filter((w) => !(GRENADE_IDS as readonly string[]).includes(w) && w !== 'c4' && w !== 'knife');

function parsePlayer(v: unknown, i: number): ScenarioPlayer {
  const p = `players[${i}]`;
  const o = obj(v, p);
  const id = str(o['id'], `${p}.id`);
  if (!isPlayerId(id)) fail(`${p}.id`, `expected one of the pawn slots ${PLAYER_IDS.join(', ')}`);
  const team = str(o['team'], `${p}.team`);
  if (!(TEAMS as readonly string[]).includes(team)) fail(`${p}.team`, 'expected "T" or "CT"');
  const pos = vecOrNull(o['pos'], `${p}.pos`);
  const spawn = o['spawn'] === undefined || o['spawn'] === null ? null : int(o['spawn'], `${p}.spawn`, 0, 63);
  if (pos === null && spawn === null) fail(p, 'needs "pos" or "spawn"');
  const weapons = (Array.isArray(o['weapons']) ? o['weapons'] : o['weapons'] === undefined ? [] : fail(`${p}.weapons`, 'expected an array')).map((w, k): ScenarioWeapon => {
    const wo = obj(w, `${p}.weapons[${k}]`);
    const weapon = str(wo['weapon'], `${p}.weapons[${k}].weapon`);
    if (!(GUNS as readonly string[]).includes(weapon)) fail(`${p}.weapons[${k}].weapon`, `expected a gun: ${GUNS.join(', ')}`);
    return { weapon: weapon as WeaponId, clip: int(wo['clip'], `${p}.weapons[${k}].clip`, 0, 200), reserve: int(wo['reserve'], `${p}.weapons[${k}].reserve`, 0, 400) };
  });
  const grenades = (Array.isArray(o['grenades']) ? o['grenades'] : o['grenades'] === undefined ? [] : fail(`${p}.grenades`, 'expected an array')).map((g, k): GrenadeId => {
    const s = str(g, `${p}.grenades[${k}]`);
    if (!(GRENADE_IDS as readonly string[]).includes(s)) fail(`${p}.grenades[${k}]`, `expected one of ${GRENADE_IDS.join(', ')}`);
    return s as GrenadeId;
  });
  if (grenades.length > 4) fail(`${p}.grenades`, 'at most 4 grenades');
  const c4 = bool(o['c4'], `${p}.c4`, false);
  if (c4 && team !== 'T') fail(`${p}.c4`, 'only a T carries the c4');
  const kit = bool(o['kit'], `${p}.kit`, false);
  if (kit && team !== 'CT') fail(`${p}.kit`, 'only a CT carries a defuse kit');
  return {
    id,
    name: o['name'] === undefined ? id : str(o['name'], `${p}.name`),
    team: team as Team,
    pos,
    spawn,
    yaw: o['yaw'] === undefined || o['yaw'] === null ? null : num(o['yaw'], `${p}.yaw`, -360, 360),
    hp: o['hp'] === undefined ? 100 : int(o['hp'], `${p}.hp`, 1, 100),
    armor: o['armor'] === undefined ? 0 : int(o['armor'], `${p}.armor`, 0, 100),
    helmet: bool(o['helmet'], `${p}.helmet`, false),
    kit,
    c4,
    weapons,
    grenades,
    money: o['money'] === undefined ? 0 : int(o['money'], `${p}.money`, 0, 16000),
    role: o['role'] === undefined || o['role'] === null ? null : str(o['role'], `${p}.role`),
    hold: vecOrNull(o['hold'], `${p}.hold`),
  };
}

/** Validate a parsed scenario (or its text). `name` is the file's (checked against the JSON's when it has one). */
export function parseScenario(json: unknown, name: string): Scenario {
  const root = obj(typeof json === 'string' ? (JSON.parse(json) as unknown) : json, 'root');
  if (root['format'] !== SCENARIO_FORMAT) fail('format', `expected "${SCENARIO_FORMAT}"`);
  if (root['name'] !== undefined && root['name'] !== name) fail('name', `"${String(root['name'])}" is not the file's name "${name}"`);
  const map = str(root['map'], 'map');
  if (!isMapId(map)) fail('map', `unknown map package (known: ${MAP_IDS.join(', ')})`);
  const r = root['rules'] === undefined ? {} : obj(root['rules'], 'rules');
  const score = r['score'] === undefined ? CS2_RULES.score : obj(r['score'], 'rules.score');
  const diff = r['botDifficulty'] === undefined ? 'normal' : str(r['botDifficulty'], 'rules.botDifficulty');
  if (!(BOT_DIFFICULTIES as readonly string[]).includes(diff)) fail('rules.botDifficulty', `expected one of ${BOT_DIFFICULTIES.join(', ')}`);
  const rules: ScenarioRules = {
    c4TimerSec: r['c4TimerSec'] === undefined ? CS2_RULES.c4TimerSec : num(r['c4TimerSec'], 'rules.c4TimerSec', 1, 600),
    freezeTimeSec: r['freezeTimeSec'] === undefined ? 0 : num(r['freezeTimeSec'], 'rules.freezeTimeSec', 0, 60),
    roundTimeSec: r['roundTimeSec'] === undefined ? CS2_RULES.roundTimeSec : num(r['roundTimeSec'], 'rules.roundTimeSec', 1, 3600),
    score: { ct: int(score['ct'], 'rules.score.ct', 0, 99), t: int(score['t'], 'rules.score.t', 0, 99) },
    botDifficulty: diff as BotDifficulty,
    site: r['site'] === undefined || r['site'] === null ? null : str(r['site'], 'rules.site'),
  };
  let recording: ScenarioRecording | null = null;
  if (root['recording'] !== undefined && root['recording'] !== null) {
    const rec = obj(root['recording'], 'recording');
    const round = rec['round'];
    if (typeof round !== 'string' && (typeof round !== 'object' || round === null)) fail('recording.round', 'expected a path or the round data');
    const playable = rec['playable'] === undefined || rec['playable'] === null ? null : str(rec['playable'], 'recording.playable');
    if (playable !== null && !isPlayerId(playable)) fail('recording.playable', 'unknown pawn');
    recording = { round, playable: playable as PlayerId | null };
  }
  const rawPlayers = root['players'] === undefined ? [] : Array.isArray(root['players']) ? root['players'] : fail('players', 'expected an array');
  const players = rawPlayers.map(parsePlayer);
  if (recording !== null && players.length > 0) fail('players', 'a scenario with a recording takes its players from the recording (leave "players" out)');
  if (recording === null) {
    // Free play: RoundModel's roster is the ten slots (docs/scenarios.md "Limits").
    const ids = players.map((p) => p.id);
    for (const id of PLAYER_IDS) if (!ids.includes(id)) fail('players', `free play needs all ten pawn slots; ${id} is missing`);
    if (ids.length !== PLAYER_IDS.length) fail('players', 'each pawn slot once');
    if (players.filter((p) => p.c4).length > 1) fail('players', 'at most one c4');
  }
  const human = root['human'] === undefined || root['human'] === null ? null : str(root['human'], 'human');
  if (human !== null && !isPlayerId(human)) fail('human', 'unknown pawn');
  return {
    format: SCENARIO_FORMAT,
    name,
    title: root['title'] === undefined ? name : str(root['title'], 'title'),
    description: root['description'] === undefined ? '' : str(root['description'], 'description'),
    map,
    seed: root['seed'] === undefined ? 1 : int(root['seed'], 'seed', -2147483648, 2147483647),
    rules,
    players: [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    recording,
    human: human as PlayerId | null,
  };
}

/** A scenario name as used in `?scenario=` and `--game`: lower-case letters, digits and dashes. */
export function isScenarioName(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(s);
}
