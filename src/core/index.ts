/** Core: engine-agnostic replay brain (ICore); may import only src/contracts so it ports mechanically to C#. */
export { TICK_RATE, tickOf, tOf, RoundClock } from './clock';
export { RoundModel, sightingObservers } from './round-model';
export type { ModelPlayer, ModelSighting, TrackPoint } from './round-model';
export { startActions, startYaw, FACING_PAIRS, MOTION_LOOKAHEAD_TICKS, MOTION_MIN_DIST } from './start-state';
export type { StartYaw, StartYawSource } from './start-state';
export { EventSchedule, ScheduleError, SCHEDULE_TYPE_ORDER, actorOf, involves, typeRank, compareEntries } from './schedule';
export type {
  ScheduledEvent,
  ScheduledEventType,
  ScheduledShotKind,
  ShotEntry,
  BurstEntry,
  DamageEntry,
  KillEntry,
  PlantEntry,
  DefuseStartEntry,
  DefuseEndEntry,
  WeaponSwitchEntry,
  PickupEntry,
  UtilityEntry,
  RadioEntry,
  ChatEntry,
} from './schedule';
export { RELEASED_TRIGGER, ReplayCore } from './replay-core';
export type { ReplayCoreOptions } from './replay-core';
export {
  PuppetTrack,
  PuppetController,
  RECORDED_YAW_MAX_GAP_SEC,
  normYaw,
  yawDelta,
  roundYaw,
  turnToward,
  bearing,
  dist2,
  stickToward,
  withLook,
  movementButtons,
  runSpeedOf,
  maxSpeedOf,
  seenByHuman,
  recordedWeapons,
  weaponAt,
  describeEvent,
} from './puppet';
export type { PuppetState, PuppetStep, PuppetTrackSummary, Stick, TeleportPoint, TrackEvent, TrackEventKind, WeaponChange } from './puppet';
export {
  ScriptPlan,
  ScriptedEvents,
  SPRAY_FIT_SHIFTS,
  cadenceOffsets,
  ceilTicks,
  cycleTicksOf,
  aimSpotAt,
  deployTicksOf,
  fitSpray,
  initialScriptState,
  recordedWeaponAt,
  secTicks,
  simulateHolds,
  tapSpacing,
} from './scripted';
export type {
  AimSpot,
  AttackSpan,
  DamageItem,
  DefuseItem,
  Engagement,
  FireItem,
  FireKind,
  InventoryItem,
  PawnMode,
  PlantItem,
  LiveSpan,
  ScriptDecision,
  ScriptState,
  SprayFit,
  UtilityItem,
} from './scripted';
export { AIM_BANDS, MAX_PITCH_DEG, aimPitchAt, bandHeightOf, bandPoint, eyeHeightOf, lookToward, pitchTo, roundPitch, turnPitchToward } from './aim';
export type { AimBand, Look } from './aim';
export {
  TRIGGER_KINDS,
  Divergence,
  ExpectedEncounters,
  blockedTrigger,
  blockingPawn,
  buildEncounters,
  damageTrigger,
  dwellSpot,
  encounterOwnsSighting,
  gunfireTrigger,
  humanOnCourse,
  humanOnScript,
  distanceToRecording,
  nearRecording,
  recordedPairInSight,
  inEncounterWindow,
  encounterShotTick,
  onCourse,
  intText,
  isOffScript,
  isPuppet,
  liveGoal,
  liveIntent,
  outlivedTrigger,
  recordedFire,
  sightingTrigger,
  tenthsText,
  thinRoute,
  trackPosAt,
} from './divergence';
export type { ContactState, DivergenceState, EncounterPhase, EncounterPlan, EncounterState, FireSpan, LiveIntent, PairSpan, TriggerHit, TriggerKind } from './divergence';
export { HumanDuels, buildDuels } from './duels';
export type { DuelPlan, DuelState } from './duels';
export { REJOIN_MAX_PATH_QUERIES, REJOIN_ROLE, REJOIN_TRIGGER, Rejoin, busyReason, lagTicks, rejoinGoal, trackLength, unrestReason } from './rejoin';
export type { RejoinHit, RejoinPawn, RejoinState, RejoinTarget } from './rejoin';
export { EXECUTE_ROLE, FATE_TRIGGER, RETAKE_ROLE, fateGone, survivorGoal } from './fate';
export type { FateGone } from './fate';
export { CheckpointStore, autoCheckpointId, checkpointInterval } from './checkpoints';
export type { Checkpoint } from './checkpoints';
export { copyLoadouts, initialLoadouts, isGrenadeItem, loadoutOf, noteActions, noteObserve, releaseWindowTicks } from './loadout';
export type { LoadoutItem, LoadoutState, PawnLoadout } from './loadout';
export { blockedPairs, resyncActions, resyncHazards } from './resync';
export type { ResyncPawn, StandingBlock } from './resync';
export { DEFAULT_SUMMARY_OPTIONS, compareKills, deltaText, fixed2, liveSwitchRows, recordedBomb, recordedResult, resultLong, resultShort, secText, summarize } from './summary';
export type { SummaryOptions } from './summary';
