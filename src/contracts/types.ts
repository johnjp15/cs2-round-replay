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
  'glock',
  'usps',
  'm4a1s',
  'p2000',
  'knife',
  'c4',
  'smoke',
  'flash',
  'he',
  'molotov',
] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

/** Anything `give` can hand out: a weapon (incl. grenades and c4) or the defuse kit. */
export const ITEM_IDS = [...WEAPON_IDS, 'defuser'] as const;
export type ItemId = (typeof ITEM_IDS)[number];

/**
 * Held buttons. `DROP` (W2) is CS2's `drop` command (default key G) as a held flag: the engine drops the active
 * weapon on the tick it is first held. Only the human sends it (the Core's inputs never do).
 */
export const BUTTONS = ['ATTACK', 'ATTACK2', 'USE', 'DUCK', 'WALK', 'JUMP', 'RELOAD', 'DROP'] as const;
export type Button = (typeof BUTTONS)[number];

/**
 * Body part hit. `neck` exists in CS2 (hitgroup 8); the 2D engine never produces it. `generic` = no body part
 * (CS2 hitgroup 0): grenade, fire, bomb and other world damage.
 */
export const HITGROUPS = ['head', 'chest', 'stomach', 'arm', 'leg', 'neck', 'generic'] as const;
export type Hitgroup = (typeof HITGROUPS)[number];

/**
 * Per-pawn control mode. DEAD and HUMAN (B4: the pawn `observe.human` plays, while alive) are reported in
 * status only; set_mode accepts REPLAY | LIVE.
 */
export const MODES = ['REPLAY', 'LIVE', 'DEAD', 'HUMAN'] as const;
export type Mode = (typeof MODES)[number];
export type SettableMode = Exclude<Mode, 'DEAD' | 'HUMAN'>;

export const SOUND_KINDS = ['footstep', 'land', 'shot', 'reload', 'grenade', 'bomb'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

export const BOMB_PHASES = ['planted', 'defuse_start', 'defuse_stop', 'defused', 'exploded'] as const;
export type BombPhase = (typeof BOMB_PHASES)[number];

export const ROUND_END_REASONS = ['elimination', 'bomb_exploded', 'bomb_defused', 'time'] as const;
export type RoundEndReason = (typeof ROUND_END_REASONS)[number];

/** Round phase (C3): `live` until the bomb is planted, `planted` while it ticks, `over` from round_end on. */
export const ROUND_PHASES = ['live', 'planted', 'over'] as const;
export type RoundPhase = (typeof ROUND_PHASES)[number];

/** Where the C4 is (C3). */
export const BOMB_STATES = ['carried', 'dropped', 'planted', 'defused', 'exploded'] as const;
export type BombState = (typeof BOMB_STATES)[number];

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
  /**
   * G3: standing on walkable ground (CS2: FL_ONGROUND / a ground entity). False from a jump's take-off or a ledge
   * until the landing; `vel.z` is then the vertical speed (0 on the ground).
   */
  readonly onGround: boolean;
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
  /** The pawn that made it; null for sounds without one (bomb beeps; CS2 `bomb_beep` has no player). */
  readonly source: PlayerId | null;
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

/**
 * G5: a bullet of the human's pawn (`Observe.human`) hit `victim` while `block_damage {attacker, victim}` was in force,
 * so the engine applied no damage (no `damage` event); this reports that it would have hit, and where. It follows that
 * shot's `shot` and `sound`. Only the human's bullets are reported (the puppets' blocked hits are not: their damage is
 * scripted), and grenades never. CS2: OnTakeDamage blocked the hit. docs/core.md "Recorded duels of the human".
 */
export interface BlockedHitEvent {
  readonly type: 'blocked_hit';
  readonly attacker: PlayerId;
  readonly victim: PlayerId;
  readonly weapon: WeaponId;
  /** Where the bullet would have hit (CS2: the hit group of the trace). */
  readonly hitgroup: Hitgroup;
}

/** Events since the previous tick, in engine emission order (not sorted). */
export type ObsEvent = DamageEvent | ShotEvent | DeathEvent | SoundEvent | BombEvent | RoundEndEvent | BlockedHitEvent;

/** Rounds won per side. */
export interface Score {
  readonly ct: number;
  readonly t: number;
}

/** The C4 (CS2: game rules and the `planted_c4` entity). */
export interface BombObs {
  readonly state: BombState;
  /** The pawn carrying it (state `carried`); null otherwise, and null while nobody has it (before setup). */
  readonly carrier: PlayerId | null;
  /** The carrier's position (carried), where it lies (dropped) or the bomb (planted, defused, exploded); null when nobody carries it. */
  readonly pos: Vec3 | null;
  /** Tick it was planted; null before the plant. */
  readonly plantTick: number | null;
  /** The CT defusing it now; after `defused`, who defused it; null otherwise. */
  readonly defuser: PlayerId | null;
  /** Tick the defuse in progress completes; after `defused`, the tick it did; null otherwise. */
  readonly defuseEndTick: number | null;
}

/** Round state (CS2: game rules). */
export interface RoundObs {
  readonly phase: RoundPhase;
  /** Current score; the round's win is counted from its `round_end` tick on. */
  readonly score: Score;
  /** Set when the round ends (phase `over`); null before. */
  readonly winner: Team | null;
  readonly reason: RoundEndReason | null;
  /** Tick of the round_end; null before. */
  readonly endTick: number | null;
  /**
   * Seconds left: the round clock while live, the bomb timer while planted (and while it still ticks after
   * the round ended). Otherwise frozen at round end: the round clock then, the bomb timer at the defuse, 0
   * after an explosion. Never negative.
   */
  readonly timeLeftSec: number;
  readonly bomb: BombObs;
}

export interface Observe {
  /** Integer tick, 64 per second. */
  readonly tick: number;
  /** Video seconds (tick / 64). */
  readonly t: number;
  /** All ten pawns, sorted by id. */
  readonly pawns: readonly PawnObs[];
  readonly events: readonly ObsEvent[];
  /**
   * The pawn the human controls, or null (spectating / bot-only run). G4: it may change mid-round: from null to a pawn
   * on the tick the player takes control of it (`take_control`; CS2: the native bot takeover), and back to null only
   * through a rewind to before that tick (or, CS2, the player leaving: the Core then makes the pawn LIVE, trigger
   * `released`). docs/core.md "Takeover".
   */
  readonly human: PlayerId | null;
  /** Round phase, score, clock and the bomb (C3). */
  readonly round: RoundObs;
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
  readonly item: ItemId;
  /** Guns: rounds in the magazine. 0 for grenades, c4 and the defuser (one item per give). */
  readonly clip: number;
  readonly reserve: number;
}

export interface SetHpAction {
  readonly type: 'set_hp';
  readonly id: PlayerId;
  readonly hp: number;
  readonly armor: number;
  readonly helmet: boolean;
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

/**
 * B5 (resync rewind): put the engine's clock and round state back to a checkpoint. `tick` is the tick this Act is
 * for: the engine relabels its clock so that its next Observe reports `tick + 1` (2D: its tick counter; CS2: the
 * adapter's tick base and the game rules' round start time). `round` is the checkpoint's `Observe.round`: score,
 * winner / reason / end tick, and the bomb (carried, dropped where, planted on which tick, defused, exploded). A plant
 * or defuse in progress is not restored (the contract doesn't carry it; CS2 can't). Sent first in the Act, before the
 * per-pawn actions.
 */
export interface SetRoundAction {
  readonly type: 'set_round';
  readonly tick: number;
  readonly round: RoundObs;
}

/** B5 (resync rewind): remove every item but the knife (2D: inventory = knife, held; CS2: `RemoveWeapons`). `give`s follow. */
export interface StripAction {
  readonly type: 'strip';
  readonly id: PlayerId;
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
  | SetRoundAction
  | StripAction
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
/**
 * G4: the watching player takes control of pawn `id` (cart) from the next tick on. Engine and driver work, like a
 * checkpoint: the engine hands the pawn to the human before the next observe (2D: the Session's `takeControl`, i.e.
 * `Sim2DHost.setHuman`; CS2: the player's own E press on the spectated bot, which the plugin only allows for cart), and
 * the Core learns of it from `observe.human`. Not sent to the Core and not logged; the log shows it as `human`
 * changing in that tick's observe. docs/core.md "Takeover".
 */
export interface TakeControlControl {
  readonly type: 'take_control';
  readonly id: PlayerId;
}

export type Control =
  | StartControl
  | RestartControl
  | SeekControl
  | CheckpointControl
  | RewindControl
  | PauseControl
  | SpeedControl
  | TakeControlControl;

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
