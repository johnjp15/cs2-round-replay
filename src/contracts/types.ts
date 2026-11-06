/**
 * Core <-> engine data contracts: Observe (engine -> Core), Act (Core -> engine)
 * and Control (app -> Core/engine). Human-readable spec: docs/contracts.md.
 *
 * Portable style (see docs/port-notes.md): plain readonly data, discriminated
 * unions on a string `type` field, no optional fields (absent values are `null`),
 * every per-player array sorted by id (ordinal, UTF-16 code units).
 */

// ---------------------------------------------------------------------------
// Enumerations (string unions backed by a const array for runtime checks)
// ---------------------------------------------------------------------------

/** The ten player ids, sorted ordinally (the order every per-player array uses). */
export const PLAYER_IDS = [
  'barely',
  'cart',
  'donk',
  'eradicate',
  'incredibad',
  'lokier',
  'snakelore',
  'snarlbot',
  'sp4rtan',
  'zwomp',
] as const;
export type PlayerId = (typeof PLAYER_IDS)[number];

export const TEAMS = ['CT', 'T'] as const;
export type Team = (typeof TEAMS)[number];

export const WEAPON_IDS = [
  'ak47',
  'awp',
  'ssg08',
  'deagle',
  'm4a4',
  'knife',
  'c4',
  'smoke',
  'flash',
  'he',
  'molotov',
] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export const BUTTONS = ['ATTACK', 'ATTACK2', 'USE', 'DUCK', 'WALK', 'JUMP', 'RELOAD'] as const;
export type Button = (typeof BUTTONS)[number];

export const HITGROUPS = ['head', 'chest', 'stomach', 'arm', 'leg'] as const;
export type Hitgroup = (typeof HITGROUPS)[number];

/** Per-pawn control mode. DEAD is reported in status only; set_mode accepts REPLAY | LIVE. */
export const MODES = ['REPLAY', 'LIVE', 'DEAD'] as const;
export type Mode = (typeof MODES)[number];
export type SettableMode = Exclude<Mode, 'DEAD'>;

export const SOUND_KINDS = ['footstep', 'land', 'shot', 'reload', 'grenade', 'bomb'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

export const BOMB_PHASES = ['planted', 'defuse_start', 'defuse_stop', 'defused', 'exploded'] as const;
export type BombPhase = (typeof BOMB_PHASES)[number];

export const ROUND_END_REASONS = ['elimination', 'bomb_exploded', 'bomb_defused', 'time'] as const;
export type RoundEndReason = (typeof ROUND_END_REASONS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isPlayerId(s: string): s is PlayerId {
  return (PLAYER_IDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Basic shapes
// ---------------------------------------------------------------------------

/** Source units, Mirage world frame (x east, y north, z up). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Ammo {
  readonly clip: number;
  readonly reserve: number;
}

// ---------------------------------------------------------------------------
// Observe (engine -> Core, every tick)
// ---------------------------------------------------------------------------

export interface PawnObs {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  /** Units per second. */
  readonly vel: Vec3;
  /** Degrees CCW from +x (setang convention). */
  readonly yaw: number;
  readonly pitch: number;
  readonly hp: number;
  readonly armor: number;
  readonly alive: boolean;
  /** Active weapon; dead pawns report the last one held. */
  readonly weapon: WeaponId;
  readonly ammo: Ammo;
  readonly crouching: boolean;
  /** Pawns in line of sight and within FOV (engine-computed), sorted. */
  readonly sees: readonly PlayerId[];
}

export interface DamageEvent {
  readonly type: 'damage';
  /** null = world damage (fall, bomb). */
  readonly attacker: PlayerId | null;
  readonly victim: PlayerId;
  /** HP removed. */
  readonly amount: number;
  /** Armor removed. */
  readonly armor: number;
  readonly weapon: WeaponId | null;
  readonly hitgroup: Hitgroup;
  /** True when applied from a Core `damage` action rather than engine ballistics. */
  readonly scripted: boolean;
}

export interface ShotEvent {
  readonly type: 'shot';
  readonly shooter: PlayerId;
  readonly weapon: WeaponId;
}

export interface DeathEvent {
  readonly type: 'death';
  readonly victim: PlayerId;
  readonly attacker: PlayerId | null;
  readonly weapon: WeaponId | null;
  readonly headshot: boolean;
}

export interface SoundEvent {
  readonly type: 'sound';
  readonly source: PlayerId;
  readonly pos: Vec3;
  readonly kind: SoundKind;
}

export interface BombEvent {
  readonly type: 'bomb';
  readonly phase: BombPhase;
  /** Planter (planted) or defuser (defuse_*, defused); null for exploded. */
  readonly id: PlayerId | null;
  /** Bomb position; null when not known. */
  readonly pos: Vec3 | null;
}

export interface RoundEndEvent {
  readonly type: 'round_end';
  readonly winner: Team;
  readonly reason: RoundEndReason;
}

/** Events since the previous tick, in engine emission order (not sorted). */
export type ObsEvent = DamageEvent | ShotEvent | DeathEvent | SoundEvent | BombEvent | RoundEndEvent;

export interface Observe {
  /** Integer tick, 64 per second. */
  readonly tick: number;
  /** Video seconds (tick / 64). */
  readonly t: number;
  /** All ten pawns, sorted by id. */
  readonly pawns: readonly PawnObs[];
  readonly events: readonly ObsEvent[];
  /** The pawn the human controls, or null (spectating / bot-only run). */
  readonly human: PlayerId | null;
}

// ---------------------------------------------------------------------------
// Act (Core -> engine, same tick)
// ---------------------------------------------------------------------------

export interface PawnInput {
  readonly id: PlayerId;
  /** -1..1 relative to the pawn's yaw. */
  readonly forward: number;
  /** -1..1, positive = right. */
  readonly side: number;
  readonly yaw: number;
  readonly pitch: number;
  /** Held buttons, in BUTTONS order (see sortButtons). */
  readonly buttons: readonly Button[];
}

export interface Goal {
  readonly route: readonly Vec3[];
  /** Free-form role tag chosen by Core (e.g. "hold", "rotate"). */
  readonly role: string;
  readonly hold: Vec3 | null;
}

export interface DamageAction {
  readonly type: 'damage';
  readonly attacker: PlayerId | null;
  readonly victim: PlayerId;
  readonly amount: number;
  readonly armor: number;
  readonly hitgroup: Hitgroup;
  readonly weapon: WeaponId | null;
  readonly lethal: boolean;
}

export interface BlockDamageAction {
  readonly type: 'block_damage';
  readonly attacker: PlayerId;
  readonly victim: PlayerId;
}

export interface UnblockDamageAction {
  readonly type: 'unblock_damage';
  readonly attacker: PlayerId;
  readonly victim: PlayerId;
}

export interface SetModeAction {
  readonly type: 'set_mode';
  readonly id: PlayerId;
  readonly mode: SettableMode;
  /** Required for LIVE; null for REPLAY. */
  readonly goal: Goal | null;
}

export interface SetWeaponAction {
  readonly type: 'set_weapon';
  readonly id: PlayerId;
  readonly weapon: WeaponId;
}

export interface GiveAction {
  readonly type: 'give';
  readonly id: PlayerId;
  readonly item: WeaponId;
  readonly clip: number;
  readonly reserve: number;
}

export interface SetHpAction {
  readonly type: 'set_hp';
  readonly id: PlayerId;
  readonly hp: number;
  readonly armor: number;
}

export interface TeleportAction {
  readonly type: 'teleport';
  readonly id: PlayerId;
  readonly pos: Vec3;
  readonly yaw: number;
}

export interface PlantAction {
  readonly type: 'plant';
  readonly id: PlayerId;
  readonly pos: Vec3;
}

export interface DefuseStartAction {
  readonly type: 'defuse_start';
  readonly id: PlayerId;
}

export interface DefuseStopAction {
  readonly type: 'defuse_stop';
  readonly id: PlayerId;
}

export interface EndRoundAction {
  readonly type: 'end_round';
  readonly winner: Team;
  readonly reason: RoundEndReason;
}

export interface LogAction {
  readonly type: 'log';
  readonly level: LogLevel;
  readonly text: string;
}

/** Engine applies actions in array order. */
export type Action =
  | DamageAction
  | BlockDamageAction
  | UnblockDamageAction
  | SetModeAction
  | SetWeaponAction
  | GiveAction
  | SetHpAction
  | TeleportAction
  | PlantAction
  | DefuseStartAction
  | DefuseStopAction
  | EndRoundAction
  | LogAction;

export type ActionType = Action['type'];

export interface PawnStatus {
  readonly id: PlayerId;
  readonly mode: Mode;
  /** Name of the trigger that set the current mode, or null. */
  readonly trigger: string | null;
  /** Tick the current mode began. */
  readonly sinceTick: number;
}

export interface Act {
  /** One per REPLAY pawn, sorted by id. */
  readonly inputs: readonly PawnInput[];
  readonly actions: readonly Action[];
  /** One per pawn (all ten), sorted by id. */
  readonly status: readonly PawnStatus[];
}

// ---------------------------------------------------------------------------
// Control (app -> Core / engine)
// ---------------------------------------------------------------------------

export interface StartControl {
  readonly type: 'start';
}
export interface RestartControl {
  readonly type: 'restart';
}
export interface SeekControl {
  readonly type: 'seek';
  /** Video seconds. */
  readonly t: number;
}
export interface CheckpointControl {
  readonly type: 'checkpoint';
  /** App-chosen checkpoint name, used by `rewind`. */
  readonly id: string;
}
export interface RewindControl {
  readonly type: 'rewind';
  /** Checkpoint id to return to. */
  readonly id: string;
}
export interface PauseControl {
  readonly type: 'pause';
  /** true = pause, false = resume (explicit, not a toggle). */
  readonly paused: boolean;
}
export interface SpeedControl {
  readonly type: 'speed';
  /** Playback multiplier (1 = real time). */
  readonly x: number;
}

export type Control =
  | StartControl
  | RestartControl
  | SeekControl
  | CheckpointControl
  | RewindControl
  | PauseControl
  | SpeedControl;

export type ControlType = Control['type'];

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------

/** Ordinal (UTF-16 code unit) comparison; never locale-dependent. */
export function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** New array sorted by `id` (ordinal). Stable; input untouched. */
export function sortById<T extends { readonly id: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => compareOrdinal(a.id, b.id));
}

/** New array of unique ids sorted ordinally (for `sees`). */
export function sortIds<T extends string>(xs: readonly T[]): T[] {
  return [...new Set(xs)].sort(compareOrdinal);
}

/** New array of unique buttons in BUTTONS order. */
export function sortButtons(xs: readonly Button[]): Button[] {
  return BUTTONS.filter((b) => xs.includes(b));
}
