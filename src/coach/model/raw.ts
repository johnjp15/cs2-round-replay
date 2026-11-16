/**
 * Contract 1 of the demo coach: `RawDemo`, what any demo parser must deliver.
 *
 * Two parsers produce it: the native Node adapter (`tools/coach/parse-node.ts`, `@laihoe/demoparser2`) and the
 * browser parser (K1, `src/coach-parser`, WebAssembly). Everything downstream (`src/coach/ingest` and later) reads only
 * this shape, so the two parsers must agree field for field. `docs/coach/contracts.md` explains it in prose; a change
 * to this file bumps `RAW_FORMAT` and is recorded there.
 *
 * Conventions
 * - Units are the demo's own: Source units (x, y, z), degrees (pitch, yaw, punch), units per second (velocity),
 *   seconds (flash duration). Ticks are demo ticks (64 per second in Valve and FACEIT demos).
 * - Players are referred to by **slot**: an index into `RawDemo.players`. Event records never carry names or Steam
 *   IDs. A slot of `-1` means "nobody / the world / someone who is not one of the players" (for example a spectator).
 * - The dense tick grid has `T = ticks.count` rows of sampled ticks and `P = players.length` player slots. Column
 *   arrays marked `[T × P]` are indexed `i = t * P + p`.
 * - Weapon and item names are canonical item names without the `weapon_` prefix (`ak47`, `m4a1_silencer`,
 *   `usp_silencer`, `knife`, `hegrenade`, `c4`, …); see `src/coach/model/items.ts`. Every knife skin is `knife`.
 * - Event lists are sorted by tick, then by the order the demo emitted them.
 * - This file holds types, constants and tiny pure helpers only.
 */

/** The format tag. Bump the number on any change that a reader must know about. */
export const RAW_FORMAT = 'coach-raw@1';

/** Team numbers as the game writes them (`team_num`). */
export const TEAM_NONE = 0;
export const TEAM_SPECTATOR = 1;
export const TEAM_T = 2;
export const TEAM_CT = 3;
export type TeamNum = 0 | 1 | 2 | 3;

/** Bits of `ticks.flags` (Uint16). One bit per boolean the demo has per player and tick. */
export const FLAG = {
  /** `is_alive`. */
  alive: 1 << 0,
  /** `is_scoped`. */
  scoped: 1 << 1,
  /** `is_walking` (the walk key changes the pawn's state; see also `BUTTON.walk`). */
  walking: 1 << 2,
  /** `is_airborne`. */
  airborne: 1 << 3,
  /** `is_defusing`. */
  defusing: 1 << 4,
  /** `is_in_reload`. */
  reloading: 1 << 5,
  /** `has_helmet`. */
  helmet: 1 << 6,
  /** `has_defuser`. */
  kit: 1 << 7,
  /** `in_bomb_zone`. */
  inBombZone: 1 << 8,
  /** `in_buy_zone`. */
  inBuyZone: 1 << 9,
  /** `spotted`: the pawn is shown on the enemy radar (the game's own flag, with its lag). */
  spotted: 1 << 10,
  /** The controller is connected (`is_connected` = 0). Cleared once a player has left. */
  connected: 1 << 11,
  /** `is_controlling_bot`: a human is driving a bot's pawn on this tick. */
  controllingBot: 1 << 12,
} as const;

/**
 * Bits of `ticks.buttons` (Uint32): the low 32 bits of the Source 2 button mask (`buttons`, which the demo stores as
 * a decimal string of a 64-bit mask: `m_nButtonDownMaskPrev`). Example: "65552" = 65536 + 16 = walk + back.
 * Bits above 31 (scoreboard 1<<33, zoom 1<<34, inspect 1<<35) are dropped. GOTV demos record the mask as the server
 * saw it once per tick (no sub-tick detail).
 */
export const BUTTON = {
  /** IN_ATTACK, mouse 1. */
  fire: 1 << 0,
  /** IN_JUMP. */
  jump: 1 << 1,
  /** IN_DUCK. */
  duck: 1 << 2,
  /** IN_FORWARD, W. */
  forward: 1 << 3,
  /** IN_BACK, S. */
  back: 1 << 4,
  /** IN_USE, E. */
  use: 1 << 5,
  /** IN_MOVELEFT, A. */
  left: 1 << 9,
  /** IN_MOVERIGHT, D. */
  right: 1 << 10,
  /** IN_ATTACK2, mouse 2. */
  attack2: 1 << 11,
  /** IN_RELOAD, R. */
  reload: 1 << 13,
  /** IN_SPEED, the walk key (Shift). */
  walk: 1 << 16,
} as const;

/** Bits of `ticks.game` (Uint8, one value per sampled tick, not per player). */
export const GAME_FLAG = {
  /** `is_warmup_period`. */
  warmup: 1 << 0,
  /** `is_freeze_period`. */
  freeze: 1 << 1,
  /** `is_bomb_planted`. */
  bombPlanted: 1 << 2,
  /** `is_match_started`. */
  matchStarted: 1 << 3,
} as const;

/** Sentinels. */
export const SLOT_NONE = -1;
/** `ticks.clip` when the active weapon has no clip or the demo has none. */
export const CLIP_NONE = 255;
/** `projectiles[].path` value for a missing sample. */
export const PATH_NONE = -32768;
/** Projectile paths store one sample every `PATH_STEP` ticks. */
export const PATH_STEP = 4;

export interface RawHeader {
  /** `de_mirage`, … (the demo header's `map_name`). */
  map: string;
  /** The demo header's `server_name`. */
  server: string;
  /** Guessed from the server name and the file name: Valve matchmaking, FACEIT, or anything else. */
  source: 'valve' | 'faceit' | 'other';
  /** True for a SourceTV (GOTV) recording, which is all we support today. */
  gotv: boolean;
  /** The demo header's `patch_version`, or null. */
  patch: number | null;
  /** Ticks per second (64). */
  tickRate: number;
  /** SHA-256 of the demo file as given (compressed bytes if the file was compressed), lowercase hex. */
  demoSha256: string;
  /** Size of that file in bytes. */
  bytes: number;
  /** The parser that made this RawDemo, e.g. `demoparser2-node@0.42.3`. Not part of conformance comparisons. */
  parser: string;
}

export interface RawPlayer {
  /** 64-bit Steam ID as a decimal string; bots get `BOT-<name>`. Only the header and `players` carry it. */
  steamId: string;
  name: string;
  bot: boolean;
}

/**
 * The dense per-tick grid. `count` = T sampled ticks: every tick the demo has from the start of the first live round
 * to the end of the last round (freeze time included, warmup excluded). The demo can skip a tick now and then, so
 * row t is demo tick `tick[t]`, not `tick[0] + t`.
 */
export interface RawTicks {
  count: number;
  /** [T] demo tick of row t, strictly increasing. */
  tick: Int32Array;
  /** [T] `GAME_FLAG` bits. */
  game: Uint8Array;
  /** [T] `total_rounds_played` at that tick. */
  roundsPlayed: Uint8Array;
  /** [T] the T side's and the CT side's score (`team_rounds_total`); 255 when unknown. */
  scoreT: Uint8Array;
  scoreCT: Uint8Array;

  // ---- [T × P] columns, row i = t * P + p ----
  /** 1 when the player has a controller with a pawn on this tick (team 2 or 3), 0 otherwise. All other columns are 0 / NaN where present = 0. */
  present: Uint8Array;
  /** Feet position, Source units. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** View angles, degrees (pitch down positive, yaw counter-clockwise from +x). */
  pitch: Float32Array;
  yaw: Float32Array;
  /** Velocity, units/s; NaN where the demo has none (a few ticks, e.g. right after spawn). */
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  health: Uint8Array;
  armor: Uint8Array;
  /** Duck amount × 255 (0 standing, 255 fully crouched). */
  duck: Uint8Array;
  /** Active weapon: index into `names.weapons` (0 = none). */
  weapon: Uint8Array;
  /** Rounds in the active weapon's clip; `CLIP_NONE` when not applicable. */
  clip: Uint8Array;
  /** `team_num`: 2 = T, 3 = CT, 0 = none. */
  team: Uint8Array;
  /** `last_place_name`: index into `names.places` (0 = unknown). */
  place: Uint8Array;
  /** `FLAG` bits. */
  flags: Uint16Array;
  /** `BUTTON` bits. */
  buttons: Uint32Array;
  /** Bit q set = player slot q is in this pawn's `approximate_spotted_by` (slots ≥ 16 are dropped). */
  spottedBy: Uint16Array;
  /** `flash_duration`, seconds of the current blind (0 when not flashed). */
  flash: Float32Array;
  /** `accuracy_penalty` of the active weapon (radians-like game units, as in the demo). */
  penalty: Float32Array;
  /** `aim_punch_angle` pitch and yaw, degrees. */
  punchPitch: Float32Array;
  punchYaw: Float32Array;
  /** `fl_recoil_idx`. */
  recoilIndex: Float32Array;
  /** `shots_fired` (bullets in the current burst). */
  shotsFired: Uint16Array;
  /** `balance`, dollars. */
  money: Uint16Array;
  /** `current_equip_value`, dollars. */
  equip: Uint16Array;
}

/** Index of row (t, p). */
export function rowIndex(t: number, p: number, playerCount: number): number {
  return t * playerCount + p;
}

/** Row t of the first sampled tick ≥ `tick` (binary search); `count` if none. */
export function rowAtOrAfter(ticks: Pick<RawTicks, 'tick' | 'count'>, tick: number): number {
  let lo = 0;
  let hi = ticks.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((ticks.tick[mid] ?? 0) < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- events

/**
 * Round and match flow, one list. `kind` maps to the game events:
 * `match_start` begin_new_match · `announce_match_start` round_announce_match_start · `restart` cs_pre_restart ·
 * `start` round_start · `freeze_end` round_freeze_end · `end` round_end · `officially_ended` round_officially_ended ·
 * `match_end` cs_win_panel_match · `buytime_ended` buytime_ended.
 */
export interface RawRoundEvent {
  tick: number;
  kind: 'match_start' | 'announce_match_start' | 'restart' | 'start' | 'freeze_end' | 'end' | 'officially_ended' | 'match_end' | 'buytime_ended';
  /** `total_rounds_played` at the event. */
  roundsPlayed: number;
  /** `is_warmup_period` at the event. */
  warmup: boolean;
  /** `end` only: the winning team number (2 = T, 3 = CT), 0 if none. */
  winner: number;
  /** `end` only: the game's round-end reason (`ROUND_END_REASON`), 0 otherwise. */
  reason: number;
  /** `end` only: the round-end message, e.g. `#SFUI_Notice_Target_Bombed`; '' otherwise. */
  message: string;
}

/** CS2 round-end reasons (`round_end.reason`). */
export const ROUND_END_REASON = {
  bomb_exploded: 1,
  bomb_defused: 7,
  t_killed: 8,
  ct_killed: 9,
  draw: 10,
  time_ran_out: 12,
  game_start: 16,
  t_surrender: 17,
  ct_surrender: 18,
} as const;

/** `weapon_fire`: one trigger pull that fired (one per shot; a shotgun shot is one record). */
export interface RawShot {
  tick: number;
  p: number;
  weapon: string;
  silenced: boolean;
}

/** `fire_bullets`: the server's view of one shot: firing origin and angles, and the game's own inaccuracy numbers. */
export interface RawBullet {
  tick: number;
  p: number;
  /** Item definition index (`item_def_index`) and its canonical name. */
  defIndex: number;
  weapon: string;
  /** Firing origin (the eye), Source units. */
  x: number;
  y: number;
  z: number;
  /** Firing angles, degrees (`angles_x` = pitch, `angles_y` = yaw). */
  pitch: number;
  yaw: number;
  /** The weapon's inaccuracy and spread at this shot (game units; both feed the spread cone). */
  inaccuracy: number;
  spread: number;
  /** `recoil_index` at this shot. */
  recoilIndex: number;
  /** The spread random seed. */
  seed: number;
  /** Fire mode: 0 primary, 1 secondary (burst / silencer modes). */
  mode: number;
  /** `num_bullets_remaining` (clip after the shot). */
  clip: number;
}

/** `player_hurt`. */
export interface RawHurt {
  tick: number;
  victim: number;
  /** -1 for world damage (fall, bomb). */
  attacker: number;
  weapon: string;
  /** `generic`, `head`, `chest`, `stomach`, `left_arm`, `right_arm`, `left_leg`, `right_leg`, `neck`, `gear`. */
  hitgroup: string;
  /** Damage as the event reports it (not capped at the remaining health). */
  dmgHealth: number;
  dmgArmor: number;
  /** Health and armor after the hit. */
  health: number;
  armor: number;
}

/** `player_death`. */
export interface RawKill {
  tick: number;
  victim: number;
  attacker: number;
  assister: number;
  weapon: string;
  headshot: boolean;
  /** Walls penetrated (0 = no wallbang). */
  penetrated: number;
  thruSmoke: boolean;
  attackerBlind: boolean;
  noScope: boolean;
  /** The assist was a flash assist. */
  assistedFlash: boolean;
  /** Distance attacker → victim, metres as the game reports it (0 when absent). */
  distance: number;
  hitgroup: string;
}

/** `player_blind`. */
export interface RawBlind {
  tick: number;
  victim: number;
  attacker: number;
  /** Seconds. */
  duration: number;
  /** The flashbang's entity id, matching `RawDetonation.entity`. */
  entity: number;
}

/** Grenade effects: `hegrenade_detonate`, `flashbang_detonate`, `smokegrenade_detonate`, `smokegrenade_expired`, `inferno_startburn`, `inferno_expire`, `decoy_started`, `decoy_detonate`. */
export interface RawDetonation {
  tick: number;
  kind: 'he' | 'flash' | 'smoke' | 'smoke_end' | 'fire' | 'fire_end' | 'decoy' | 'decoy_end';
  p: number;
  entity: number;
  x: number;
  y: number;
  z: number;
}

/** Bomb events. `site` is the bomb-site entity index from the event (-1 when absent); map knowledge turns it into A/B. */
export interface RawBombEvent {
  tick: number;
  kind: 'begin_plant' | 'abort_plant' | 'planted' | 'begin_defuse' | 'abort_defuse' | 'defused' | 'exploded' | 'dropped' | 'pickup';
  p: number;
  site: number;
  /** `begin_defuse` only: the defuser has a kit. */
  hasKit: boolean;
}

/** `player_footstep`, `player_jump`, `weapon_reload`, `weapon_zoom`: who and when. */
export interface RawPlayerTick {
  tick: number;
  p: number;
}

/** `item_pickup`. */
export interface RawPickup {
  tick: number;
  p: number;
  item: string;
  defIndex: number;
  silent: boolean;
}

/** `item_equip` (switching to a weapon). */
export interface RawEquip {
  tick: number;
  p: number;
  item: string;
  defIndex: number;
}

/** `item_purchase` (present in the test demo, contrary to the plan's first table). */
export interface RawPurchase {
  tick: number;
  p: number;
  item: string;
  cost: number;
  /** The item was sold back. */
  sold: boolean;
}

/** `rank_update` (end of a ranked match; Premier rating when `rankType` = 11). */
export interface RawRank {
  tick: number;
  p: number;
  rankOld: number;
  rankNew: number;
  rankChange: number;
  numWins: number;
  rankType: number;
}

/** `player_disconnect` and `player_spawn`. */
export interface RawPresenceEvent {
  tick: number;
  p: number;
  kind: 'spawn' | 'disconnect';
  /** `disconnect` only: the reason code; 0 otherwise. */
  reason: number;
}

export interface RawEvents {
  rounds: RawRoundEvent[];
  shots: RawShot[];
  bullets: RawBullet[];
  hurts: RawHurt[];
  kills: RawKill[];
  blinds: RawBlind[];
  detonations: RawDetonation[];
  bomb: RawBombEvent[];
  footsteps: RawPlayerTick[];
  jumps: RawPlayerTick[];
  reloads: RawPlayerTick[];
  zooms: RawPlayerTick[];
  pickups: RawPickup[];
  equips: RawEquip[];
  purchases: RawPurchase[];
  ranks: RawRank[];
  presence: RawPresenceEvent[];
}

/** One thrown grenade's flight. */
export interface RawProjectile {
  /** `flashbang`, `smoke`, `he_grenade`, `molotov`, `decoy` (molotov covers the incendiary too). */
  type: string;
  thrower: number;
  /** The projectile entity id (matches detonation `entity` when the game reuses it; not guaranteed). */
  entity: number;
  /** First and last demo tick with a sample. */
  t0: number;
  t1: number;
  /** x, y, z interleaved, one triple every `PATH_STEP` ticks from t0 (rounded to whole units; `PATH_NONE` = missing). */
  path: Int16Array;
}

/** A player's inventory (canonical item names, sorted) at a moment that matters. */
export interface RawInventory {
  tick: number;
  p: number;
  /** freeze_end: every player present at each `freeze_end`; death: the victim at the tick before death; round_end: every player present. */
  at: 'freeze_end' | 'death' | 'round_end';
  items: string[];
}

/** The demo's own scoreboard totals for each slot, read at `tick` (the last round's end). Used to reconcile ours. */
export interface RawScoreboard {
  tick: number;
  rows: {
    p: number;
    kills: number;
    deaths: number;
    assists: number;
    damage: number;
    headshotKills: number;
    enemiesFlashed: number;
    utilityDamage: number;
    mvps: number;
    score: number;
  }[];
}

export interface RawDemo {
  format: typeof RAW_FORMAT;
  header: RawHeader;
  /** The players who played: team 2 or 3 with a pawn during the live range. Slot = index. Sorted by first team (T first), then Steam ID. */
  players: RawPlayer[];
  /** Lookup tables for id columns; index 0 is always '' (none / unknown). */
  names: { weapons: string[]; places: string[] };
  ticks: RawTicks;
  events: RawEvents;
  projectiles: RawProjectile[];
  inventories: RawInventory[];
  scoreboard: RawScoreboard;
}

/**
 * The live tick range both parsers must cover with `ticks`, from the round events and the demo's last tick:
 * - start: the tick of the last `match_start` (begin_new_match: it fires when warmup ends, after a knife round on
 *   servers that run one before the match, and on a full restart) ; with none, the first `start` outside warmup; with
 *   none of those either (a demo that begins mid-match), the demo's first tick.
 * - end: the tick of the last `end` at or after start; with none, the demo's last tick.
 * Events are not cut to this range: `events` holds every event of the demo (warmup and post-match included, e.g. the
 * `rank_update`s after the last round), and ingest decides what belongs to a round.
 */
export function liveRange(rounds: readonly RawRoundEvent[], firstTick: number, lastTick: number): { start: number; end: number } {
  let start = -1;
  for (const r of rounds) if (r.kind === 'match_start') start = r.tick;
  if (start < 0) for (const r of rounds) if (r.kind === 'start' && !r.warmup) { start = r.tick; break; }
  if (start < 0) start = firstTick;
  let end = -1;
  for (const r of rounds) if (r.kind === 'end' && r.tick >= start) end = r.tick;
  if (end < 0) end = lastTick;
  return { start, end };
}

/** Names of the [T × P] columns, with their typed-array constructors (codec and conformance tests use this list). */
export const PLAYER_COLUMNS = {
  present: Uint8Array,
  x: Float32Array,
  y: Float32Array,
  z: Float32Array,
  pitch: Float32Array,
  yaw: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  vz: Float32Array,
  health: Uint8Array,
  armor: Uint8Array,
  duck: Uint8Array,
  weapon: Uint8Array,
  clip: Uint8Array,
  team: Uint8Array,
  place: Uint8Array,
  flags: Uint16Array,
  buttons: Uint32Array,
  spottedBy: Uint16Array,
  flash: Float32Array,
  penalty: Float32Array,
  punchPitch: Float32Array,
  punchYaw: Float32Array,
  recoilIndex: Float32Array,
  shotsFired: Uint16Array,
  money: Uint16Array,
  equip: Uint16Array,
} as const;

/** Names of the [T] columns. */
export const TICK_COLUMNS = {
  tick: Int32Array,
  game: Uint8Array,
  roundsPlayed: Uint8Array,
  scoreT: Uint8Array,
  scoreCT: Uint8Array,
} as const;

export type PlayerColumn = keyof typeof PLAYER_COLUMNS;
export type TickColumn = keyof typeof TICK_COLUMNS;

/** Allocate an empty tick grid for T ticks and P players (all zeros; float columns zero, not NaN). */
export function allocTicks(count: number, playerCount: number): RawTicks {
  const n = count * playerCount;
  return {
    count,
    tick: new Int32Array(count),
    game: new Uint8Array(count),
    roundsPlayed: new Uint8Array(count),
    scoreT: new Uint8Array(count),
    scoreCT: new Uint8Array(count),
    present: new Uint8Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    pitch: new Float32Array(n),
    yaw: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    vz: new Float32Array(n),
    health: new Uint8Array(n),
    armor: new Uint8Array(n),
    duck: new Uint8Array(n),
    weapon: new Uint8Array(n),
    clip: new Uint8Array(n),
    team: new Uint8Array(n),
    place: new Uint8Array(n),
    flags: new Uint16Array(n),
    buttons: new Uint32Array(n),
    spottedBy: new Uint16Array(n),
    flash: new Float32Array(n),
    penalty: new Float32Array(n),
    punchPitch: new Float32Array(n),
    punchYaw: new Float32Array(n),
    recoilIndex: new Float32Array(n),
    shotsFired: new Uint16Array(n),
    money: new Uint16Array(n),
    equip: new Uint16Array(n),
  };
}

/** An empty events object. */
export function emptyEvents(): RawEvents {
  return {
    rounds: [], shots: [], bullets: [], hurts: [], kills: [], blinds: [], detonations: [], bomb: [], footsteps: [],
    jumps: [], reloads: [], zooms: [], pickups: [], equips: [], purchases: [], ranks: [], presence: [],
  };
}
