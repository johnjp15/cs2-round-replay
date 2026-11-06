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
  /**
   * Acceleration is scaled by max(wishspeed, accelScaleFloor × run speed of the held weapon).
   * 0 = plain Source (scale = wishspeed: a crouching pawn cannot beat sv_stopspeed friction);
   * 1 = CS:GO-style (walk/crouch accelerate at the weapon's run rate). See docs/movement.md.
   */
  accelScaleFloor: number;
  /** Run speed (units/s) by weapon id. */
  runSpeedByWeapon: Record<string, number>;
}

/** Puppet (REPLAY pawn) control. See docs/core.md "Puppets". */
export interface ReplayTuning {
  /** Steer at the track this far ahead of now (seconds). */
  lookaheadSec: number;
  /** Behind the track by more than this (units, 2D): run to catch up (no WALK / DUCK). */
  driftNudgeUnits: number;
  /** Behind by more than this (units, 2D), unseen, at a teleport point: snap to the track. */
  driftSnapUnits: number;
  /** Recorded speed (units/s) below which the puppet holds WALK. */
  walkSpeedThreshold: number;
  /** Recorded speed (units/s) below which a moving puppet holds DUCK (instead of WALK). */
  crouchSpeedThreshold: number;
  /** Yaw turn-rate limit (degrees per tick). */
  maxTurnRateDegPerTick: number;
  hearingRangeUnits: number;
  outliveGraceSec: number;
  /** A track step faster than this × the recorded weapon's run speed is over-speed (spike or discontinuity). */
  spikeSpeedFactor: number;
  /** A spike must come back to a reachable path within this long (seconds) to be repaired; else it is a discontinuity. */
  spikeMaxSec: number;
  /** A snap is allowed from a teleport point's last over-speed step until this long (seconds) after it. */
  teleportWindowSec: number;
  /** After its track ends the puppet holds the last position this long (seconds), then gets no move input. */
  holdLastPositionSec: number;
  /** Recorded speed (units/s) below which the puppet counts as standing: no DUCK / WALK, yaw held. */
  standSpeedThreshold: number;
  /** WALK / DUCK stretches of a puppet's button plan shorter than this (seconds) are dropped (no flicker). */
  buttonMinSec: number;
  /** When the line to the lookahead point is not walkable, look back this far (seconds) along the track for one that is. */
  steerFallbackSec: number;
}

/** One gun (`weapons.<id>`). Sources and the damage formula: docs/combat.md. */
export interface WeaponTuning {
  /** Base damage per bullet before range falloff and hitgroup multiplier. */
  damage: number;
  /** Rounds per minute: one shot every 60 / rpm seconds while ready. */
  rpm: number;
  /** Head multiplier (CS2 VData `HeadshotMultiplier`; 4 for most guns). */
  headshotMult: number;
  /** Fraction of the damage that reaches HP on an armored hit (CS `ArmorRatio / 2`). */
  armorPen: number;
  /** Damage × rangeModifier^(distance / damage.falloffUnits). */
  rangeModifier: number;
  /** Magazine size. */
  clip: number;
  /** Reserve rounds at purchase. */
  reserve: number;
  reloadSec: number;
  /** Time after switching to the gun before it can fire. */
  deploySec: number;
  /** true = holding ATTACK keeps firing; false = one shot per ATTACK press. */
  automatic: boolean;
}

/** The C4 (docs/combat.md, "Bomb and round rules"). Seconds and Source units. */
export interface BombTuning {
  /** USE held this long with the c4 drawn inside a bombsite plants it. */
  plantSec: number;
  /** The bomb explodes this long after the plant. */
  timerSec: number;
  /** Defuse time without a kit. */
  defuseSec: number;
  /** Defuse time with a kit (`defuser` in the inventory). */
  defuseKitSec: number;
  /** A CT defuses while within this 2D distance of the bomb. */
  defuseRange: number;
  /** An alive T picks up a dropped c4 within this 2D distance. */
  pickupRange: number;
  /** Explosion damage at the bomb; falls linearly to 0 at `radius`. */
  damage: number;
  /** Explosion radius (CS: 3.5 × damage). */
  radius: number;
  /** armorPen for explosion damage (CS's armor ratio without a weapon). */
  armorPen: number;
  /** Beep interval while more than `beepFastLastSec` are left. */
  beepSec: number;
  /** Beep interval in the last `beepFastLastSec`. */
  beepFastSec: number;
  beepFastLastSec: number;
}

/** Pawn-pawn collision (docs/combat.md, "Collision"). */
export interface CollisionTuning {
  /** Pawn circle radius (units); two solid pawns stay 2 × this apart. */
  pawnRadius: number;
  /** false = teammates pass through each other (`mp_solid_teammates 0`); enemies are always solid. */
  solidTeammates: boolean;
}

/** Round rules. */
export interface RoundTuning {
  /**
   * Round clock at the start (seconds) when the host is not given one; the round times out when it reaches 0.
   * The Session passes `round.meta.clock0` instead.
   */
  timeSec: number;
}

/** Grenades (docs/combat.md, Grenades). Seconds, Source units, degrees. */
export interface GrenadeTuning {
  /** How long a smoke blocks vision after it pops. */
  smokeSec: number;
  /** How long a molotov fire burns. */
  molotovSec: number;
  /** Longest blind time (looking straight at a flash at point blank). */
  flashSec: number;
  /** Smoke, flash and HE pop this long after the throw (a smoke not before it lands). */
  fuseSec: number;
  /** A molotov bursts on landing or after this long, whichever comes first. */
  molotovFuseSec: number;
  /** Time after switching to a grenade before the pin can be pulled. */
  deploySec: number;
  /** Throw speed (units/s) along the adjusted view angle. */
  throwSpeed: number;
  /** Gravity on a flying grenade (units/s²). */
  gravity: number;
  /** Source raises the throw angle: level aim throws this many degrees upward. */
  throwPitchOffsetDeg: number;
  /** Longest horizontal throw distance (units). */
  throwRange: number;
  /** A grenade that hits a wall stops this many units short of it. */
  wallBackoff: number;
  smokeRadius: number;
  molotovRadius: number;
  /** Fire damage per second to anyone inside a molotov (armor does not reduce it). */
  molotovDps: number;
  /** Fire damage is dealt in steps this long (molotovDps × molotovTickSec per step). */
  molotovTickSec: number;
  /** Fire only burns pawns whose floor is within this height of the fire's floor. */
  fireHeight: number;
  /** HE damage at 0 units; falls linearly to 0 at heRadius. */
  heDamage: number;
  heRadius: number;
  /** armorPen for HE damage. */
  heArmorPen: number;
  /** A flash blinds nobody this far away or further (linear falloff). */
  flashRange: number;
  /** Blind time multiplier at the edge of the field of view (1 at its centre). */
  flashEdgeFactor: number;
  /** true = an active smoke between a pawn and the flash protects the pawn. */
  smokeBlocksFlash: boolean;
}

/** Hitscan and damage rules (docs/combat.md). */
export interface DamageTuning {
  /** Range falloff step (units): damage × rangeModifier^(distance / falloffUnits). */
  falloffUnits: number;
  /** Armor taken per point of damage absorbed (CS `flArmorBonus`). */
  armorBonus: number;
  /** Multiplier by hitgroup; the head uses the weapon's headshotMult instead. */
  hitgroupMult: Record<string, number>;
  /** Eye height above pos.z, standing and crouched. */
  eyeHeight: number;
  crouchEyeHeight: number;
  /** Aim-point heights above pos.z of a standing target (crouched: scaled by crouchEyeHeight / eyeHeight). */
  bandHeights: Record<string, number>;
  /** A shot whose pitch is further than this from every band's aim pitch misses. */
  hitToleranceDeg: number;
  /** Pawn hit circle radius (units). */
  pawnRadius: number;
  /** Bullets travel at most this far (units). */
  maxRange: number;
  /** false = bullets pass through teammates and grenades never hurt the thrower's teammates. */
  friendlyFire: boolean;
  /** Deploy time for held items without their own (knife, c4). */
  defaultDeploySec: number;
  /** false = classic reload (top up from reserve); true = CS2 since March 2026 (the old magazine's rounds are lost). */
  reloadDiscardsMagazine: boolean;
}

/** Engine sounds. */
export interface SoundTuning {
  /** Footsteps are audible only above this horizontal speed (units/s). */
  footstepSpeed: number;
  /** At most one footstep per pawn this often (s). */
  footstepIntervalSec: number;
}

export interface AiTuning {
  fovDeg: number;
  reactionSec: number;
  aimErrorDeg: number;
}

/** Nav-mesh geometry tolerances (see docs/nav.md). */
export interface NavTuning {
  /** Max height difference (units) at a crossing point for two areas to be neighbours. */
  stepHeight: number;
  /** Max gap (units) that still counts as touching; walkable space grows by half of it. */
  edgeEpsilon: number;
  /** Line of sight tolerates the segment passing within this many units of walkable space. */
  losMargin: number;
}

export interface Tuning {
  movement: MovementTuning;
  replay: ReplayTuning;
  /** Weapon stats by weapon id. */
  weapons: Record<string, WeaponTuning>;
  bomb: BombTuning;
  grenades: GrenadeTuning;
  damage: DamageTuning;
  sound: SoundTuning;
  ai: AiTuning;
  nav: NavTuning;
  collision: CollisionTuning;
  round: RoundTuning;
}

export class TuningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TuningError';
  }
}

const MOVEMENT_KEYS = ['svAccelerate', 'svFriction', 'svStopSpeed', 'walkFactor', 'crouchFactor', 'accelScaleFloor'] as const;
const REPLAY_KEYS = [
  'lookaheadSec',
  'driftNudgeUnits',
  'driftSnapUnits',
  'walkSpeedThreshold',
  'crouchSpeedThreshold',
  'maxTurnRateDegPerTick',
  'hearingRangeUnits',
  'outliveGraceSec',
  'spikeSpeedFactor',
  'spikeMaxSec',
  'teleportWindowSec',
  'holdLastPositionSec',
  'standSpeedThreshold',
  'buttonMinSec',
  'steerFallbackSec',
] as const;
const WEAPON_KEYS = ['damage', 'rpm', 'headshotMult', 'armorPen', 'rangeModifier', 'clip', 'reserve', 'reloadSec', 'deploySec'] as const;
const BOMB_KEYS = [
  'plantSec',
  'timerSec',
  'defuseSec',
  'defuseKitSec',
  'defuseRange',
  'pickupRange',
  'damage',
  'radius',
  'armorPen',
  'beepSec',
  'beepFastSec',
  'beepFastLastSec',
] as const;
const COLLISION_KEYS = ['pawnRadius'] as const;
const ROUND_KEYS = ['timeSec'] as const;
const GRENADE_KEYS = [
  'smokeSec',
  'molotovSec',
  'flashSec',
  'fuseSec',
  'molotovFuseSec',
  'deploySec',
  'throwSpeed',
  'gravity',
  'throwPitchOffsetDeg',
  'throwRange',
  'wallBackoff',
  'smokeRadius',
  'molotovRadius',
  'molotovDps',
  'molotovTickSec',
  'fireHeight',
  'heDamage',
  'heRadius',
  'heArmorPen',
  'flashRange',
  'flashEdgeFactor',
] as const;
const DAMAGE_KEYS = [
  'falloffUnits',
  'armorBonus',
  'eyeHeight',
  'crouchEyeHeight',
  'hitToleranceDeg',
  'pawnRadius',
  'maxRange',
  'defaultDeploySec',
] as const;
/** Hitgroups that need a multiplier (head uses the weapon's headshotMult) and the aim bands hitscan picks from. */
const HITGROUP_MULT_KEYS = ['chest', 'stomach', 'arm', 'leg', 'neck', 'generic'] as const;
const BAND_KEYS = ['head', 'chest', 'stomach', 'leg'] as const;
const SOUND_KEYS = ['footstepSpeed', 'footstepIntervalSec'] as const;
const AI_KEYS = ['fovDeg', 'reactionSec', 'aimErrorDeg'] as const;
const NAV_KEYS = ['stepHeight', 'edgeEpsilon', 'losMargin'] as const;

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
    const w = asObject(weaponsObj[id], `weapons.${id}`);
    weapons[id] = { ...pickNumbers(w, WEAPON_KEYS, `weapons.${id}`), automatic: asBoolean(w['automatic'], `weapons.${id}.automatic`) };
  }
  const grenadesObj = asObject(root['grenades'], 'grenades');
  const damageObj = asObject(root['damage'], 'damage');
  const grenades: GrenadeTuning = {
    ...pickNumbers(grenadesObj, GRENADE_KEYS, 'grenades'),
    smokeBlocksFlash: asBoolean(grenadesObj['smokeBlocksFlash'], 'grenades.smokeBlocksFlash'),
  };
  const damage: DamageTuning = {
    ...pickNumbers(damageObj, DAMAGE_KEYS, 'damage'),
    hitgroupMult: pickNumbers(asObject(damageObj['hitgroupMult'], 'damage.hitgroupMult'), HITGROUP_MULT_KEYS, 'damage.hitgroupMult'),
    bandHeights: pickNumbers(asObject(damageObj['bandHeights'], 'damage.bandHeights'), BAND_KEYS, 'damage.bandHeights'),
    friendlyFire: asBoolean(damageObj['friendlyFire'], 'damage.friendlyFire'),
    reloadDiscardsMagazine: asBoolean(damageObj['reloadDiscardsMagazine'], 'damage.reloadDiscardsMagazine'),
  };
  const collisionObj = asObject(root['collision'], 'collision');
  const collision: CollisionTuning = {
    ...pickNumbers(collisionObj, COLLISION_KEYS, 'collision'),
    solidTeammates: asBoolean(collisionObj['solidTeammates'], 'collision.solidTeammates'),
  };
  return {
    movement,
    replay: pickNumbers(asObject(root['replay'], 'replay'), REPLAY_KEYS, 'replay'),
    weapons,
    bomb: pickNumbers(asObject(root['bomb'], 'bomb'), BOMB_KEYS, 'bomb'),
    grenades,
    damage,
    sound: pickNumbers(asObject(root['sound'], 'sound'), SOUND_KEYS, 'sound'),
    ai: pickNumbers(asObject(root['ai'], 'ai'), AI_KEYS, 'ai'),
    nav: pickNumbers(asObject(root['nav'], 'nav'), NAV_KEYS, 'nav'),
    collision,
    round: pickNumbers(asObject(root['round'], 'round'), ROUND_KEYS, 'round'),
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

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TuningError(`${path}: expected true or false, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`);
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
