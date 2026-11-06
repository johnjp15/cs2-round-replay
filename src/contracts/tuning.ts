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
  // G3: 3D movement on the CS2 mesh (docs/movement.md "3D movement"; CS2 convar defaults unless marked estimated).
  /** `sv_gravity` (units/s²). */
  gravity: number;
  /** `sv_jump_impulse`: upward speed of a jump (units/s); apex = impulse² / (2 × gravity) = 57. */
  jumpImpulse: number;
  /** `sv_airaccelerate`. */
  airAccelerate: number;
  /** `sv_air_max_wishspeed`: the wish speed air acceleration can reach along the wish direction (units/s). */
  airMaxWishSpeed: number;
  /** `sv_maxvelocity`: per-axis velocity bound (units/s). */
  maxVelocity: number;
  /** `sv_stepsize`: the highest step walked up without a jump (units). */
  stepSize: number;
  /** `sv_standable_normal`: a surface is ground if its normal's z is at least this. */
  standableNormal: number;
  /** Estimated: how far the feet tuck up when a pawn ducks in the air (units; CS:GO's crouch jump clears 9–11 more). */
  airDuckLift: number;
  /** `sv_staminamax`: the largest landing speed penalty (percent). */
  staminaMax: number;
  /** `sv_staminalandcost`: landing penalty (percent) per unit/s of downward speed at landing (formula estimated). */
  staminaLandCost: number;
  /** `sv_staminarecoveryrate`: penalty recovered per second. */
  staminaRecoveryRate: number;
  /** Source SDK `PLAYER_MAX_SAFE_FALL_SPEED`: landing faster than this hurts (units/s). */
  fallSafeSpeed: number;
  /** Source SDK `PLAYER_FATAL_FALL_SPEED`: landing this fast deals 100 HP (linear in between). */
  fallFatalSpeed: number;
  /** `sv_falldamage_scale`. */
  fallDamageScale: number;
  /** `sv_min_jump_landing_sound`: landings at least this fast make a `land` sound (units/s). */
  landSoundSpeed: number;
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
  /** B3 scripted events (docs/core.md "Scripted events"). A shooter aims at its target from this long (seconds) before the first shot of an engagement. */
  preAimSec: number;
  /** Yaw and pitch turn limit while aiming (at a target, or at the bomb for a defuse), degrees per tick. */
  aimTurnRateDegPerTick: number;
  /** Ticks from an input (ATTACK, USE) in an Act to its effect in an Observe (the shot event): scripted inputs are sent this early. 2D sim: 1; CS2: probe P3. */
  inputLatencyTicks: number;
  /** Ticks from an action (damage, set_weapon, give) in an Act to its effect in an Observe: scripted actions are sent this early. 2D sim: 1. */
  actionLatencyTicks: number;
  /** Consecutive shots of an automatic gun at most this many cycle times (60 / rpm) apart are one spray (ATTACK held). */
  sprayGapFactor: number;
  /** Grenade throw pitch (Source degrees, negative = up). The landing spots are not in the data, so throws are cosmetic. */
  throwPitchDeg: number;
  /** ATTACK is held this long (seconds) before the release that throws a grenade (pin pull). */
  throwHoldSec: number;
  /** No `planted` bomb event this many ticks after the recorded plant tick: send a `plant` action. */
  plantFallbackTicks: number;
  /** No `defuse_start` bomb event this many ticks after the recorded defuse start: send a `defuse_start` action. */
  defuseFallbackTicks: number;
  /**
   * B4 divergence (docs/core.md "Divergence"). A pair of players counts as having seen each other in the
   * recording within this long (seconds) of a recorded shot, hit, kill or `sightings[]` entry between them.
   */
  expectedSightingWindowSec: number;
  /** A shot by the human or a LIVE pawn is recorded fire when the recording has that shooter firing within this long (seconds). */
  expectedGunfireWindowSec: number;
  /** A scheduled encounter's scripted hit lands this long (seconds) after the shooter first sees the human at the recorded spot. */
  encounterDelaySec: number;
  /** The human counts as at an encounter's recorded spot within this distance (units, 2D). */
  humanSpotToleranceUnits: number;
  /** LIVE route: the remaining recorded track thinned (Ramer–Douglas–Peucker) to this tolerance (units, 2D). */
  routeThinUnits: number;
  /**
   * A pawn more than this far (units, 2D) from its recorded track is off course: a puppet body-blocked off course while
   * the human sees it goes LIVE, and the human inside it is on script (sightings of him are as recorded).
   */
  offCourseUnits: number;
  /** Two solid pawns are in contact (body block) within 2 × collision.pawnRadius + this (units, 2D). */
  contactSlackUnits: number;
  /** A puppet held in contact (slower than standSpeedThreshold) this long (seconds) while off course is body-blocked. */
  blockedSec: number;
  /** A T's guard spot after the plant is its longest recorded stay within this radius (units, 2D). */
  dwellUnits: number;
  /** B5: the driver takes an automatic checkpoint every this many seconds of round time (at tick multiples). */
  checkpointSec: number;
  /** B5: checkpoints kept (automatic and on demand together); the oldest goes first. */
  checkpointMax: number;
  /**
   * G1 rejoin (docs/core.md "Rejoin"): a LIVE pawn may head back to its recording once nothing off-script has reached
   * it (no damage, no unexpected enemy in sight, no unexpected gunfire heard, no shot of its own) for this long (seconds).
   */
  rejoinCalmSec: number;
  /** G1: a pawn stays LIVE at least this long (seconds) before it may rejoin (hysteresis: no flicker). */
  rejoinMinLiveSec: number;
  /** G1: the recording must keep the pawn alive and tracked this long (seconds) after the tick it rejoins at. */
  rejoinMinTapeSec: number;
  /** G1: a rejoin point counts as reachable when its nav path is at most this fraction of run speed × the time left (0 < f ≤ 1). */
  rejoinSpeedFactor: number;
  /** G1: seconds taken off the time to a rejoin point before the speed check (reaction, acceleration, the AI's easing off). */
  rejoinLeadSec: number;
  /** G1: how far ahead along its recorded track (seconds) the planner looks for a rejoin point. */
  rejoinHorizonSec: number;
  /** G1: an approach that hasn't rejoined this long (seconds) after its target tick is planned again. */
  rejoinLateSec: number;
  /** G1: after a plan finds no reachable point, wait this long (seconds) before planning again. */
  rejoinRetrySec: number;
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

/** Vision and the 2D engine's LIVE AI (C4; docs/vision.md, docs/ai.md). */
export interface AiTuning {
  /** Field of view (full angle, degrees) for `sees` and flashes. */
  fovDeg: number;
  /** Seconds from first seeing an enemy to turning on it (± reactionJitter). */
  reactionSec: number;
  /** Standard deviation (degrees) of the aim offset drawn when a target is acquired; it settles over aimSettleSec. */
  aimErrorDeg: number;
  /** Sight mask: a run of wall cells (radar pixels) along a sight line longer than this blocks. */
  losWallTolerancePx: number;
  /** Sight mask: a wall run touching either end of the line may be up to this long (a pawn's centre inside a wall pixel). */
  losEndpointTolerancePx: number;
  /** Level check: sample spacing (units) along the eye-to-eye line against the nav floors. */
  losLevelStepUnits: number;
  /** Level check: a sample counts as inside a floor only this far below it (units; nav height-model error). */
  losLevelSlackUnits: number;
  /** Cover (boxes): a run of cover cells along a line this long or shorter (cells) never blocks (grazing a corner). */
  losCoverTolerancePx: number;
  /** Cover: an upright pawn (not crouched, planting or defusing) this close (units) to a box sees and shoots over it. */
  losCoverNearUnits: number;
  /** Cover: a line at least this high (units) above the lower end's floor all across a box passes over it. */
  losCoverHeightUnits: number;
  /** LIVE AI (2D engine only; CS2 uses the native bot). The reaction time varies by ± this fraction (seeded). */
  reactionJitter: number;
  /** Share of acquisitions aimed at the head band; the rest aim at the chest. */
  headshotAimRatio: number;
  /** Yaw and pitch turn limit (degrees per tick). */
  turnRateDegPerTick: number;
  /** The acquisition aim offset halves every this many seconds once the bot is on its target. */
  aimSettleSec: number;
  /** Standard deviation (degrees) of the extra error on each shot. */
  aimResidualDeg: number;
  /** Fire only when the view is within this many degrees of where the bot means to aim. */
  fireConeDeg: number;
  /** Semi-automatic guns fire only after this many aimSettleSec on the target (automatic guns at once). */
  semiAutoSettleFactor: number;
  /** Fire when the settling aim offset is within the target's angular radius; automatic guns within this multiple of it. */
  sprayStartFactor: number;
  /** Keep a target out of sight this long (s) before switching to another. */
  targetLostSec: number;
  /** Reload with no enemy in sight once the magazine is at or below this fraction. */
  reloadClipFraction: number;
  /** Hold WALK within this distance (units) of a known enemy position. */
  walkNearEnemyUnits: number;
  /** A seen or heard enemy position counts as known for this long (s). */
  memorySec: number;
  /** Turn toward a heard sound for this long (s). */
  soundLookSec: number;
  /** A waypoint or spot is reached within this distance (units). */
  arriveUnits: number;
  /** No progress along the path (less than stuckProgressUnits) for this long (s): re-path. */
  stuckSec: number;
  stuckProgressUnits: number;
  /** After a re-path, strafe sideways this long (s). */
  unstickSec: number;
  /** Counter-strafe (push against the velocity) while faster than this (units/s) when engaging. */
  counterStrafeSpeed: number;
  /** A bomb carrier in a bombsite plants once within this distance (units) of its plant spot. */
  plantSpotUnits: number;
  /** A defuser walks to within this fraction of bomb.defuseRange before holding USE. */
  defuseRangeFactor: number;
  /** A guard spot is at most this far (units) from the planted bomb. */
  guardMaxUnits: number;
  /** Leaving the bomb's blast: go at least this far (units, 3D) beyond bomb.radius. */
  blastMarginUnits: number;
  /** A CT starts (or keeps going for) a defuse only if it can finish this long (s) before the explosion. */
  defuseMarginSec: number;
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

const MOVEMENT_KEYS = [
  'svAccelerate',
  'svFriction',
  'svStopSpeed',
  'walkFactor',
  'crouchFactor',
  'accelScaleFloor',
  'gravity',
  'jumpImpulse',
  'airAccelerate',
  'airMaxWishSpeed',
  'maxVelocity',
  'stepSize',
  'standableNormal',
  'airDuckLift',
  'staminaMax',
  'staminaLandCost',
  'staminaRecoveryRate',
  'fallSafeSpeed',
  'fallFatalSpeed',
  'fallDamageScale',
  'landSoundSpeed',
] as const;
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
  'preAimSec',
  'aimTurnRateDegPerTick',
  'inputLatencyTicks',
  'actionLatencyTicks',
  'sprayGapFactor',
  'throwPitchDeg',
  'throwHoldSec',
  'plantFallbackTicks',
  'defuseFallbackTicks',
  'expectedSightingWindowSec',
  'expectedGunfireWindowSec',
  'encounterDelaySec',
  'humanSpotToleranceUnits',
  'routeThinUnits',
  'offCourseUnits',
  'contactSlackUnits',
  'blockedSec',
  'dwellUnits',
  'checkpointSec',
  'checkpointMax',
  'rejoinCalmSec',
  'rejoinMinLiveSec',
  'rejoinMinTapeSec',
  'rejoinSpeedFactor',
  'rejoinLeadSec',
  'rejoinHorizonSec',
  'rejoinLateSec',
  'rejoinRetrySec',
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
const AI_KEYS = [
  'fovDeg',
  'reactionSec',
  'aimErrorDeg',
  'losWallTolerancePx',
  'losEndpointTolerancePx',
  'losLevelStepUnits',
  'losLevelSlackUnits',
  'losCoverTolerancePx',
  'losCoverNearUnits',
  'losCoverHeightUnits',
  'reactionJitter',
  'headshotAimRatio',
  'turnRateDegPerTick',
  'aimSettleSec',
  'aimResidualDeg',
  'fireConeDeg',
  'semiAutoSettleFactor',
  'sprayStartFactor',
  'targetLostSec',
  'reloadClipFraction',
  'walkNearEnemyUnits',
  'memorySec',
  'soundLookSec',
  'arriveUnits',
  'stuckSec',
  'stuckProgressUnits',
  'unstickSec',
  'counterStrafeSpeed',
  'plantSpotUnits',
  'defuseRangeFactor',
  'guardMaxUnits',
  'blastMarginUnits',
  'defuseMarginSec',
] as const;
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
    replay: checkReplay(pickNumbers(asObject(root['replay'], 'replay'), REPLAY_KEYS, 'replay')),
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

/**
 * G1: the rejoin keys' ranges (the others only need to be numbers): times and the lead are seconds ≥ 0, the horizon
 * and the retry > 0, and the speed factor in (0, 1] (a pawn can't be planned faster than it runs).
 */
function checkReplay(r: ReplayTuning): ReplayTuning {
  const nonNegative = ['rejoinCalmSec', 'rejoinMinLiveSec', 'rejoinMinTapeSec', 'rejoinLeadSec', 'rejoinLateSec'] as const;
  for (const k of nonNegative) if (r[k] < 0) throw new TuningError(`replay.${k}: must be >= 0, got ${r[k]}`);
  for (const k of ['rejoinHorizonSec', 'rejoinRetrySec'] as const) if (!(r[k] > 0)) throw new TuningError(`replay.${k}: must be > 0, got ${r[k]}`);
  if (!(r.rejoinSpeedFactor > 0 && r.rejoinSpeedFactor <= 1)) throw new TuningError(`replay.rejoinSpeedFactor: must be in (0, 1], got ${r.rejoinSpeedFactor}`);
  return r;
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
