/**
 * EventSchedule: every recorded event of the round as an immutable list sorted by
 * (tick, type order, actor id, build order). Built from parsed RoundData; it is
 * the recording as is (human-agnostic: deciding which entries still apply when the
 * human deviates is later tasks' job). See docs/core.md "Event schedule".
 */
import {
  PLAYER_IDS,
  compareOrdinal,
  type Damage,
  type GrenadeId,
  type Hitgroup,
  type Kill,
  type PlayerId,
  type RoundData,
  type Vec3,
  type WeaponId,
} from '../contracts/index';

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Shots-CSV kinds that become a `shot` entry. */
export type ScheduledShotKind = 'shot' | 'shot_kill' | 'hit';

/** One shot at a known tick (shots-CSV rows `shot`, `shot → kill`, `hit`). */
export interface ShotEntry {
  readonly type: 'shot';
  readonly tick: number;
  readonly shooter: PlayerId;
  readonly weapon: WeaponId;
  readonly target: PlayerId | null;
  readonly kind: ScheduledShotKind;
}

/** `count` shots somewhere in [tick0, tick1] (shots-CSV "N shots (count only)" rows). `tick` = tick0. */
export interface BurstEntry {
  readonly type: 'burst';
  readonly tick: number;
  readonly tick0: number;
  readonly tick1: number;
  readonly shooter: PlayerId;
  readonly weapon: WeaponId;
  readonly count: number;
  readonly target: PlayerId | null;
}

export interface DamageEntry {
  readonly type: 'damage';
  readonly tick: number;
  readonly attacker: PlayerId;
  readonly victim: PlayerId;
  /** HP removed. */
  readonly amount: number;
  /** Armor removed, or null when the recording doesn't show it. */
  readonly armor: number | null;
  readonly weapon: WeaponId;
  /** `head` for a headshot kill; otherwise `chest` (the data has no hitgroups). */
  readonly hitgroup: Hitgroup;
  /** True for the killing hit (on the kill-feed tick, amount = HP left). */
  readonly lethal: boolean;
}

export interface KillEntry {
  readonly type: 'kill';
  readonly tick: number;
  readonly killer: PlayerId;
  readonly victim: PlayerId;
  readonly weapon: WeaponId;
  readonly headshot: boolean;
  readonly assist: PlayerId | null;
  /** After the round had ended (Sp4rtaN → cart at 69.4 s). */
  readonly postRound: boolean;
}

export interface PlantEntry {
  readonly type: 'plant';
  readonly tick: number;
  readonly id: PlayerId;
  readonly pos: Vec3;
}

export interface DefuseStartEntry {
  readonly type: 'defuse_start';
  readonly tick: number;
  readonly id: PlayerId;
}

export interface DefuseEndEntry {
  readonly type: 'defuse_end';
  readonly tick: number;
  readonly id: PlayerId;
}

export interface WeaponSwitchEntry {
  readonly type: 'weapon_switch';
  readonly tick: number;
  readonly id: PlayerId;
  readonly weapon: WeaponId;
}

export interface PickupEntry {
  readonly type: 'pickup';
  readonly tick: number;
  readonly id: PlayerId;
  readonly weapon: WeaponId;
}

export interface UtilityEntry {
  readonly type: 'utility';
  readonly tick: number;
  readonly id: PlayerId;
  readonly kind: GrenadeId;
  /** Where it was thrown from. */
  readonly throwPos: Vec3;
  /** S1: the release view angles that land it on its measured spot (Utility.aim), or null: the default throw look. */
  readonly aim: { readonly pitch: number; readonly yaw: number } | null;
}

export interface RadioEntry {
  readonly type: 'radio';
  readonly tick: number;
  readonly id: PlayerId;
  readonly text: string;
}

export interface ChatEntry {
  readonly type: 'chat';
  readonly tick: number;
  readonly id: PlayerId;
  readonly text: string;
}

export type ScheduledEvent =
  | ShotEntry
  | BurstEntry
  | DamageEntry
  | KillEntry
  | PlantEntry
  | DefuseStartEntry
  | DefuseEndEntry
  | WeaponSwitchEntry
  | PickupEntry
  | UtilityEntry
  | RadioEntry
  | ChatEntry;

export type ScheduledEventType = ScheduledEvent['type'];

/**
 * Order of entry types within one tick: inventory changes first (so a shot on the
 * same tick uses the new weapon), then fire, then its consequences (the lethal
 * damage before its kill), then other actions, then talk (which never changes state).
 */
export const SCHEDULE_TYPE_ORDER = [
  'pickup',
  'weapon_switch',
  'shot',
  'burst',
  'damage',
  'kill',
  'utility',
  'plant',
  'defuse_start',
  'defuse_end',
  'radio',
  'chat',
] as const satisfies readonly ScheduledEventType[];

/** Rank of each type in SCHEDULE_TYPE_ORDER (tests check the two agree). */
const TYPE_RANK: { readonly [K in ScheduledEventType]: number } = {
  pickup: 0,
  weapon_switch: 1,
  shot: 2,
  burst: 3,
  damage: 4,
  kill: 5,
  utility: 6,
  plant: 7,
  defuse_start: 8,
  defuse_end: 9,
  radio: 10,
  chat: 11,
};

/** Position of `type` in SCHEDULE_TYPE_ORDER. */
export function typeRank(type: ScheduledEventType): number {
  return TYPE_RANK[type];
}

/** Schedule order: tick, then type rank, then actor id (ordinal). Ties keep build order. */
export function compareEntries(a: ScheduledEvent, b: ScheduledEvent): number {
  return a.tick - b.tick || TYPE_RANK[a.type] - TYPE_RANK[b.type] || compareOrdinal(actorOf(a), actorOf(b));
}

/** The player who does the thing: shooter, attacker, killer, or `id`. The sort key after type. */
export function actorOf(e: ScheduledEvent): PlayerId {
  switch (e.type) {
    case 'shot':
    case 'burst':
      return e.shooter;
    case 'damage':
      return e.attacker;
    case 'kill':
      return e.killer;
    case 'plant':
    case 'defuse_start':
    case 'defuse_end':
    case 'weapon_switch':
    case 'pickup':
    case 'utility':
    case 'radio':
    case 'chat':
      return e.id;
  }
}

/** True when `id` is the entry's actor, target, victim or assister. */
export function involves(e: ScheduledEvent, id: PlayerId): boolean {
  if (actorOf(e) === id) return true;
  switch (e.type) {
    case 'shot':
    case 'burst':
      return e.target === id;
    case 'damage':
      return e.victim === id;
    case 'kill':
      return e.victim === id || e.assist === id;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export class EventSchedule {
  /** All entries, sorted. */
  readonly events: readonly ScheduledEvent[];

  constructor(round: RoundData) {
    // Explicit build-order tie-break (C# List.Sort is not stable).
    const keyed = buildEntries(round).map((e, seq) => ({ e, seq }));
    keyed.sort((a, b) => compareEntries(a.e, b.e) || a.seq - b.seq);
    this.events = Object.freeze(keyed.map((k) => k.e));
  }

  get length(): number {
    return this.events.length;
  }

  /** Entries whose `tick` equals `tick` (a burst counts at its tick0). */
  at(tick: number): readonly ScheduledEvent[] {
    return this.between(tick, tick);
  }

  /** Entries with tick0 <= tick <= tick1 (both inclusive), in schedule order. */
  between(tick0: number, tick1: number): readonly ScheduledEvent[] {
    const out: ScheduledEvent[] = [];
    for (let i = this.lowerBound(tick0); i < this.events.length; i++) {
      const e = this.events[i] as ScheduledEvent;
      if (e.tick > tick1) break;
      out.push(e);
    }
    return out;
  }

  /** Entries that involve `id` in any role (see `involves`). */
  forPlayer(id: PlayerId): readonly ScheduledEvent[] {
    return this.events.filter((e) => involves(e, id));
  }

  ofType<K extends ScheduledEventType>(type: K): readonly Extract<ScheduledEvent, { readonly type: K }>[] {
    return this.events.filter((e): e is Extract<ScheduledEvent, { readonly type: K }> => e.type === type);
  }

  /** First index whose tick >= `tick`. */
  private lowerBound(tick: number): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((this.events[mid] as ScheduledEvent).tick < tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function buildEntries(round: RoundData): ScheduledEvent[] {
  const out: ScheduledEvent[] = [];
  shotEntries(round, out);
  damageAndKillEntries(round, out);
  bombEntries(round, out);
  inventoryEntries(round, out);
  for (const u of round.utility) out.push({ type: 'utility', tick: u.tick, id: u.thrower, kind: u.kind, throwPos: u.throwPos, aim: u.aim ?? null });
  for (const r of round.radio) out.push({ type: 'radio', tick: r.tick, id: r.who, text: r.text });
  for (const c of round.chat) out.push({ type: 'chat', tick: c.tick, id: c.who, text: c.text });
  return out;
}

/**
 * Shots-CSV rows: `shot`, `shot_kill`, `hit` -> shot; `shot_count` -> burst;
 * `switch` -> weapon_switch. `kill` rows (kill feed only, shot unknown) add nothing:
 * the kill table covers them.
 */
function shotEntries(round: RoundData, out: ScheduledEvent[]): void {
  round.shots.forEach((s, i) => {
    switch (s.kind) {
      case 'shot':
      case 'shot_kill':
      case 'hit':
        if (s.tick === null) throw new ScheduleError(`shots[${i}]: ${s.kind} without a time`);
        out.push({ type: 'shot', tick: s.tick, shooter: s.shooter, weapon: s.weapon, target: s.target, kind: s.kind });
        return;
      case 'shot_count':
        if (s.window === null) throw new ScheduleError(`shots[${i}]: count-only row without a window`);
        out.push({
          type: 'burst',
          tick: s.window.tick0,
          tick0: s.window.tick0,
          tick1: s.window.tick1,
          shooter: s.shooter,
          weapon: s.weapon,
          count: s.count,
          target: s.target,
        });
        return;
      case 'switch':
        if (s.tick === null) throw new ScheduleError(`shots[${i}]: switch without a time`);
        out.push({ type: 'weapon_switch', tick: s.tick, id: s.shooter, weapon: s.weapon });
        return;
      case 'kill':
        return;
    }
  });
}

/**
 * Damage and kills, walking each victim's HP from its start value in tick order.
 *
 * - A recorded hit that leaves the victim with HP > 0 is a normal damage entry.
 * - A recorded hit whose amount is >= the HP left is the killing hit. It is not
 *   scheduled on its own tick: it must be followed by a kill of that victim by that
 *   attacker, and the kill's lethal damage replaces it (this is how the 50.30 s
 *   13-damage `shots_csv` row on donk is handled, so donk is not damaged twice).
 * - Every kill adds a lethal damage entry on the kill-feed tick: amount = HP left,
 *   armor = the replaced hit's armor (else null), hitgroup `head` for a headshot,
 *   otherwise `chest`.
 * Inconsistent data (a hit after death, a killing hit with no matching kill) throws.
 */
function damageAndKillEntries(round: RoundData, out: ScheduledEvent[]): void {
  const walk = new HpWalk(round, out);
  const hits = round.damage
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.tick - b.d.tick || a.i - b.i)
    .map((x) => x.d);
  const kills = round.kills
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.tick - b.k.tick || a.i - b.i)
    .map((x) => x.k);
  let next = 0;
  for (const k of kills) {
    // Hits on the kill tick come first (damage sorts before kill).
    while (next < hits.length && (hits[next] as Damage).tick <= k.tick) walk.hit(hits[next++] as Damage);
    walk.kill(k);
  }
  while (next < hits.length) walk.hit(hits[next++] as Damage);
  walk.finish();
}

/** Per-victim HP bookkeeping for damageAndKillEntries. Maps are lookups only, never iterated. */
class HpWalk {
  private readonly out: ScheduledEvent[];
  private readonly hp = new Map<PlayerId, number>();
  private readonly dead = new Map<PlayerId, boolean>();
  /** Victim -> the recorded hit that brought them to 0, waiting for its kill. */
  private readonly killingHit = new Map<PlayerId, Damage>();

  constructor(round: RoundData, out: ScheduledEvent[]) {
    this.out = out;
    for (const p of round.players) this.hp.set(p.id, p.startHp);
  }

  hit(d: Damage): void {
    const left = this.hp.get(d.victim) ?? 0;
    if (this.dead.get(d.victim) === true) throw new ScheduleError(`damage at tick ${d.tick}: ${d.victim} is already dead`);
    if (this.killingHit.has(d.victim)) throw new ScheduleError(`damage at tick ${d.tick}: ${d.victim} already took a killing hit`);
    if (d.amount >= left) {
      this.killingHit.set(d.victim, d);
      return;
    }
    this.hp.set(d.victim, left - d.amount);
    this.out.push(damageEntry(d.tick, d.attacker, d.victim, d.amount, d.armor, d.weapon, 'chest', false));
  }

  kill(k: Kill): void {
    if (this.dead.get(k.victim) === true) throw new ScheduleError(`kill at tick ${k.tick}: ${k.victim} is already dead`);
    const hit = this.killingHit.get(k.victim);
    if (hit !== undefined && hit.attacker !== k.killer) {
      throw new ScheduleError(`kill at tick ${k.tick}: killing hit on ${k.victim} came from ${hit.attacker}, kill feed says ${k.killer}`);
    }
    this.killingHit.delete(k.victim);
    const left = this.hp.get(k.victim) ?? 0;
    this.out.push(damageEntry(k.tick, k.killer, k.victim, left, hit?.armor ?? null, k.weapon, k.hs ? 'head' : 'chest', true));
    this.out.push({ type: 'kill', tick: k.tick, killer: k.killer, victim: k.victim, weapon: k.weapon, headshot: k.hs, assist: k.assist, postRound: k.postRound });
    this.hp.set(k.victim, 0);
    this.dead.set(k.victim, true);
  }

  finish(): void {
    for (const id of PLAYER_IDS) {
      const hit = this.killingHit.get(id);
      if (hit !== undefined) throw new ScheduleError(`damage at tick ${hit.tick}: killing hit on ${id} with no kill`);
    }
  }
}

function damageEntry(
  tick: number,
  attacker: PlayerId,
  victim: PlayerId,
  amount: number,
  armor: number | null,
  weapon: WeaponId,
  hitgroup: Hitgroup,
  lethal: boolean,
): DamageEntry {
  return { type: 'damage', tick, attacker, victim, amount, armor, weapon, hitgroup, lethal };
}

/**
 * Plant by the carrier at plantTick. The bomb record has no defuser id, so the
 * defuser is the `who` of the narrative `bomb` event at defuseStartTick (and must be
 * the same at defuseTick).
 */
function bombEntries(round: RoundData, out: ScheduledEvent[]): void {
  const b = round.bomb;
  out.push({ type: 'plant', tick: b.plantTick, id: b.carrier, pos: b.pos });
  const defuser = bombEventWho(round, b.defuseStartTick);
  const finisher = bombEventWho(round, b.defuseTick);
  if (finisher !== defuser) throw new ScheduleError(`defuse started by ${defuser} but finished by ${finisher}`);
  out.push({ type: 'defuse_start', tick: b.defuseStartTick, id: defuser });
  out.push({ type: 'defuse_end', tick: b.defuseTick, id: defuser });
}

function bombEventWho(round: RoundData, tick: number): PlayerId {
  const e = round.events.find((x) => x.kind === 'bomb' && x.tick === tick && x.who !== null);
  if (e === undefined || e.who === null) throw new ScheduleError(`no bomb event with a player at tick ${tick}`);
  return e.who;
}

/**
 * Pickups from players[].pickups; weapon switches from timelines.weapon wherever the
 * shown weapon changes to a different known weapon (the t = 0 entry is the start
 * weapon, not a switch; `null` = not shown). A timeline switch that duplicates a
 * shots-CSV switch (same tick, player, weapon) is not added twice.
 */
function inventoryEntries(round: RoundData, out: ScheduledEvent[]): void {
  for (const p of round.players) {
    for (const k of p.pickups) out.push({ type: 'pickup', tick: k.tick, id: p.id, weapon: k.weapon });
  }
  for (const id of PLAYER_IDS) {
    const timeline = round.timelines.weapon[id] ?? [];
    let shown: WeaponId | null = null;
    for (const w of timeline) {
      const weapon = w.weapon;
      if (weapon === null) continue;
      if (shown !== null && weapon !== shown) {
        const dup = out.some((e) => e.type === 'weapon_switch' && e.tick === w.tick && e.id === id && e.weapon === weapon);
        if (!dup) out.push({ type: 'weapon_switch', tick: w.tick, id, weapon });
      }
      shown = weapon;
    }
  }
}
