/** Sim2D: the 2D top-down engine/host (IHost) for Mirage; may import only src/contracts. */
export { NavMesh, NavError, navOptionsFromTuning, areaZ } from './nav';
export type { NavArea, NavData, NavOptions, NavPoint, NavPortal, NavPos } from './nav';
export { NavWalkQuery, HullWalkQuery, hullLineClear } from './walk-query';
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
  stepMove3d,
  settle,
  restingState,
  hullOf,
  fallDamageFor,
  unstick,
} from './movement';
export type { MoveState, MoveInput, MoveStep, Wish } from './movement';
export { MapGeometry, GeometryError, combineMeshes, decodeGeometry, encodeGeometry, STANDING_HULL, CROUCHING_HULL, TRACE_SKIN } from './geometry';
export type { GeometryMesh, Hull, BoxTrace, FloorHit } from './geometry';
export { Sim2DHost, UNSUPPORTED_V0 } from './host';
export type { RosterEntry, InventoryItem, PawnState, HostNote, CombatLogLine, BlockedPair, Sim2DOptions, Sim2DVision, AiDebug } from './host';
export {
  VISMASK_FORMAT,
  VisMask,
  VisMaskError,
  Sight,
  GrenadeSight,
  visOptionsFromTuning,
  sightOptionsFromTuning,
  angleOff,
  computeSees,
  encodeRow,
  decodeVisMaskJson,
} from './vision';
export type { VisMaskGrid, VisOptions, SightTrace, VisMaskJson, SightNav, SightOptions, SeePawn, SeesOptions, SmokeQuery } from './vision';
export { AI_ROLES, freshAiState, roleOf, stepAi, snapToNav, placeCentre, nearestBombsitePoint, holdFacing, guardSpot } from './ai';
export type { AiRole, AiBehaviour, AiState, AiSelf, AiOther, AiContext, AiStep } from './ai';
export {
  BOMBSITE_PREFIX,
  isBombsite,
  freshBomb,
  isTicking,
  nextBeep,
  explosionDamage,
  within2D,
  lockedPawns,
  stepBomb,
  applyBombAction,
} from './bomb';
export type { BombData, PlantProgress, DefuseProgress, BombPawn, BombOutcome, BombStep, BombAction, BombActionResult } from './bomb';
export { dueTick, ticksAfter, freshRound, isOver, checkRoundEnd, endRound, roundPhase, timeLeftSec } from './round';
export type { RoundEnd, RoundState, TeamCounts, BombClock } from './round';
export { contactTime, validEnd, collideMove } from './collision';
export type { Obstacle, CollisionNav, CollideResult } from './collision';
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
