/** Sim2D: the 2D top-down engine/host (IHost) for Mirage; may import only src/contracts. */
export { NavMesh, NavError, navOptionsFromTuning, areaZ } from './nav';
export type { NavArea, NavData, NavOptions, NavPoint, NavPortal, NavPos } from './nav';
export {
  TICKS_PER_SEC,
  TICK_DT,
  MovementError,
  runSpeed,
  maxSpeed,
  wishFromInput,
  applyFriction,
  accelerate,
  stepMove,
} from './movement';
export type { MoveState, MoveInput, MoveStep, Wish } from './movement';
export { Sim2DHost, UNSUPPORTED_V0 } from './host';
export type { RosterEntry, InventoryItem, PawnState, HostNote, CombatLogLine, BlockedPair } from './host';
export {
  GRENADE_KINDS,
  isGrenade,
  gunStats,
  deploySec,
  cycleTicks,
  fallbackWeapon,
  reached,
  rawDamage,
  hitgroupMult,
  isArmored,
  armorDamage,
  bulletDamage,
  freshWeaponState,
  deployState,
  stepWeapon,
} from './weapons';
export type { GrenadeKind, HitDamage, WeaponState, WeaponStepInput, WeaponStep } from './weapons';
export { AIM_BANDS, eyeHeight, bandHeight, aimPitch, pickBand, traceShot } from './hitscan';
export type { AimBand, ScanPawn, LosQuery, ShotHit } from './hitscan';
export { throwElevation, throwGrenade, flightPos, smokeBlocks, activeEffects, flashSeconds, stepGrenades } from './grenades';
export type { Grenade, GrenadeNav, Thrower, EffectPawn, GrenadeOutcome, GrenadeEffect, GrenadeWorld } from './grenades';
