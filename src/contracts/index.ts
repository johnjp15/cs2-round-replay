/** Contracts: shared data types, round data, the seeded PRNG and tuning loader; imports nothing else from src/. */
export { Rng } from './rng';
export { parseTuning, TuningError } from './tuning';
export type {
  Tuning,
  MovementTuning,
  ReplayTuning,
  WeaponTuning,
  BombTuning,
  GrenadeTuning,
  DamageTuning,
  SoundTuning,
  AiTuning,
  NavTuning,
  CollisionTuning,
  RoundTuning,
} from './tuning';

export {
  PLAYER_IDS,
  TEAMS,
  WEAPON_IDS,
  ITEM_IDS,
  BUTTONS,
  HITGROUPS,
  MODES,
  SOUND_KINDS,
  BOMB_PHASES,
  ROUND_END_REASONS,
  ROUND_PHASES,
  BOMB_STATES,
  LOG_LEVELS,
  isPlayerId,
  compareOrdinal,
  sortById,
  sortIds,
  sortButtons,
} from './types';
export type {
  PlayerId,
  Team,
  WeaponId,
  ItemId,
  Button,
  Hitgroup,
  Mode,
  SettableMode,
  SoundKind,
  BombPhase,
  RoundEndReason,
  RoundPhase,
  BombState,
  LogLevel,
  Vec3,
  Ammo,
  PawnObs,
  DamageEvent,
  ShotEvent,
  DeathEvent,
  SoundEvent,
  BombEvent,
  RoundEndEvent,
  ObsEvent,
  Score,
  BombObs,
  RoundObs,
  Observe,
  PawnInput,
  Goal,
  DamageAction,
  BlockDamageAction,
  UnblockDamageAction,
  SetModeAction,
  SetWeaponAction,
  GiveAction,
  SetHpAction,
  TeleportAction,
  PlantAction,
  DefuseStartAction,
  DefuseStopAction,
  EndRoundAction,
  SetRoundAction,
  StripAction,
  LogAction,
  Action,
  ActionType,
  PawnStatus,
  Act,
  StartControl,
  RestartControl,
  SeekControl,
  CheckpointControl,
  RewindControl,
  PauseControl,
  SpeedControl,
  Control,
  ControlType,
} from './types';

export { ALL_CAPABILITIES, CS2_CAPABILITIES } from './host';
export type { IHost, ICore, HostSnapshot, CoreSnapshot, HostCapabilities } from './host';
export type { WalkQuery } from './walk';

export { TICKS_PER_SEC, toTick, CONFIDENCES, GRENADE_IDS, SHOT_KINDS, RoundDataError, parseRound } from './round';
export type {
  Confidence,
  GrenadeId,
  ShotKind,
  Vec2,
  MapTransform,
  RoundMeta,
  Kit,
  Pickup,
  Player,
  TrackSample,
  YawSample,
  Track,
  Shot,
  Kill,
  Damage,
  Utility,
  Radio,
  Chat,
  Sighting,
  LastKnown,
  PovSegment,
  RoundEvent,
  Bomb,
  TimelinePoint,
  WeaponTimelinePoint,
  RoundData,
} from './round';

export {
  JsonError,
  stableStringify,
  parseJsonLine,
  formatNumber,
  roundNumber,
  canonicalize,
  toJsonValue,
  fnv1a32Hex,
} from './json';
export type { JsonValue, JsonPrimitive, JsonObject } from './json';

export { SessionLog } from './session-log';
export type { LogEntry } from './session-log';

export { replay, MAX_REPLAY_DIFFS } from './replayer';
export type { ReplayResult, ReplayDiff } from './replayer';

export { toReplayTrace, DISPLAY_IDS, TRACE_SAMPLE_TICKS } from './trace';
export type { ReplayTrace, TraceSample, TraceKill, TraceEvent, TracePlayer } from './trace';

export { KILL_STATUSES } from './summary';
export type { KillStatus, KillRow, SwitchRow, RoundResult, BombSummary, PlayerStats, SummaryVerdict, RoundSummary } from './summary';
