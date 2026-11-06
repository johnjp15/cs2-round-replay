/** Core: engine-agnostic replay brain (ICore); may import only src/contracts so it ports mechanically to C#. */
export { TICK_RATE, tickOf, tOf, RoundClock } from './clock';
export { RoundModel } from './round-model';
export type { ModelPlayer, TrackPoint } from './round-model';
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
export { ReplayCore } from './replay-core';
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
