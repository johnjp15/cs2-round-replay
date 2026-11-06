/**
 * Typed loader for data/tuning.json. All tunable numbers (speeds, weapon stats,
 * thresholds) come from there; code never hard-codes values CS2 calibration may change.
 */

export interface MovementTuning {
  svAccelerate: number;
  svFriction: number;
  svStopSpeed: number;
  walkFactor: number;
  crouchFactor: number;
  /** Run speed (units/s) by weapon id. */
  runSpeedByWeapon: Record<string, number>;
}

export interface ReplayTuning {
  lookaheadSec: number;
  driftNudgeUnits: number;
  driftSnapUnits: number;
  walkSpeedThreshold: number;
  crouchSpeedThreshold: number;
  maxTurnRateDegPerTick: number;
  hearingRangeUnits: number;
  outliveGraceSec: number;
}

export interface WeaponTuning {
  damage: number;
  rpm: number;
  headshotMult: number;
  armorPen: number;
  clip: number;
  reserve: number;
  reloadSec: number;
}

export interface BombTuning {
  plantSec: number;
  timerSec: number;
  defuseSec: number;
  defuseKitSec: number;
}

export interface GrenadeTuning {
  smokeSec: number;
  molotovSec: number;
  flashSec: number;
}

export interface AiTuning {
  fovDeg: number;
  reactionSec: number;
  aimErrorDeg: number;
}

export interface Tuning {
  movement: MovementTuning;
  replay: ReplayTuning;
  /** Weapon stats by weapon id. */
  weapons: Record<string, WeaponTuning>;
  bomb: BombTuning;
  grenades: GrenadeTuning;
  ai: AiTuning;
}

export class TuningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TuningError';
  }
}

const MOVEMENT_KEYS = ['svAccelerate', 'svFriction', 'svStopSpeed', 'walkFactor', 'crouchFactor'] as const;
const REPLAY_KEYS = [
  'lookaheadSec',
  'driftNudgeUnits',
  'driftSnapUnits',
  'walkSpeedThreshold',
  'crouchSpeedThreshold',
  'maxTurnRateDegPerTick',
  'hearingRangeUnits',
  'outliveGraceSec',
] as const;
const WEAPON_KEYS = ['damage', 'rpm', 'headshotMult', 'armorPen', 'clip', 'reserve', 'reloadSec'] as const;
const BOMB_KEYS = ['plantSec', 'timerSec', 'defuseSec', 'defuseKitSec'] as const;
const GRENADE_KEYS = ['smokeSec', 'molotovSec', 'flashSec'] as const;
const AI_KEYS = ['fovDeg', 'reactionSec', 'aimErrorDeg'] as const;

/**
 * Validate parsed tuning JSON (or a JSON string) and return a typed copy.
 * Throws TuningError naming the first missing or non-numeric key.
 * Extra keys (such as "_note") are ignored.
 */
export function parseTuning(json: unknown): Tuning {
  const root = asObject(typeof json === 'string' ? parseJsonText(json) : json, 'tuning');
  const movementObj = asObject(root['movement'], 'movement');
  const weaponsObj = asObject(root['weapons'], 'weapons');
  const movement: MovementTuning = {
    ...pickNumbers(movementObj, MOVEMENT_KEYS, 'movement'),
    runSpeedByWeapon: numberRecord(movementObj['runSpeedByWeapon'], 'movement.runSpeedByWeapon'),
  };
  const weapons: Record<string, WeaponTuning> = {};
  const weaponIds = Object.keys(weaponsObj).sort();
  if (weaponIds.length === 0) throw new TuningError('weapons: must define at least one weapon');
  for (const id of weaponIds) {
    weapons[id] = pickNumbers(asObject(weaponsObj[id], `weapons.${id}`), WEAPON_KEYS, `weapons.${id}`);
  }
  return {
    movement,
    replay: pickNumbers(asObject(root['replay'], 'replay'), REPLAY_KEYS, 'replay'),
    weapons,
    bomb: pickNumbers(asObject(root['bomb'], 'bomb'), BOMB_KEYS, 'bomb'),
    grenades: pickNumbers(asObject(root['grenades'], 'grenades'), GRENADE_KEYS, 'grenades'),
    ai: pickNumbers(asObject(root['ai'], 'ai'), AI_KEYS, 'ai'),
  };
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new TuningError(`tuning: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TuningError(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TuningError(`${path}: expected a finite number, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`);
  }
  return value;
}

function pickNumbers<K extends string>(obj: Record<string, unknown>, keys: readonly K[], path: string): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = asNumber(obj[key], `${path}.${key}`);
  return out;
}

function numberRecord(value: unknown, path: string): Record<string, number> {
  const obj = asObject(value, path);
  const ids = Object.keys(obj).sort();
  if (ids.length === 0) throw new TuningError(`${path}: must have at least one entry`);
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = asNumber(obj[id], `${path}.${id}`);
  return out;
}
