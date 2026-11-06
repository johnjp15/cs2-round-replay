/**
 * Scene: what the renderer and HUD draw, built tick by tick from the Session. Pure and DOM-free.
 *
 * The app calls `ingest(observe, act, effects)` after every `Session.step()` (several per frame at 4×),
 * so no tick's events are missed, and draws with `alpha = loop.pending / TICK_MS` between the last two
 * observes. It keeps:
 *
 * - the previous and current observe, for interpolation (poses snap across teleports);
 * - each pawn's status from the last Act (mode, trigger, since) and the last 20 Core `log` actions;
 * - the kill feed (from `death` events: the last 5, each for 5 s of round time);
 * - shot tracers (from `shot` events, ending on the pawn the shot damaged, else at the first wall);
 * - grenade effects (smokes, fires, flying grenades) and flash / HE pops;
 * - the bomb (from `bomb` events) and the round end (from `round_end`).
 *
 * Event times: an observe with tick N carries the events of host tick N − 1 → N, so they are stamped
 * N − 1, the tick the render time is in right after the step.
 */
import type { Act, BombEvent, LogLevel, Observe, PawnObs, PawnStatus, PlayerId, RoundEndReason, Team, Vec3, WeaponId } from '../contracts/index';
import type { Effect, Pop, Tracer } from './effects';
import { POP_TICKS, TRACER_TICKS } from './effects';
import type { Point2 } from './radar';

/** A pawn that moves more than this in one tick (units) was teleported: draw it there, don't slide. */
export const SNAP_UNITS_PER_TICK = 48;
export const KILL_FEED_MAX = 5;
/** 5 s of round time. */
export const KILL_FEED_TICKS = 320;
export const LOG_MAX = 20;
/** How far a tracer that hits nothing is drawn (world units), if no wall stops it first. */
export const TRACER_RANGE_UNITS = 1800;
/** Weapons that leave no tracer. */
const NO_TRACER: readonly WeaponId[] = ['knife', 'c4', 'smoke', 'flash', 'he', 'molotov'];

/** Fraction of a tick owed by the loop, for interpolation: `pending / TICK_MS`, clamped to 0..1. */
export function interpolationAlpha(pendingMs: number, tickMs: number): number {
  if (!(tickMs > 0) || !Number.isFinite(pendingMs)) return 0;
  return Math.min(1, Math.max(0, pendingMs / tickMs));
}

/** Degrees in (−180, 180]. */
export function normalizeDeg(a: number): number {
  const r = (((a % 360) + 540) % 360) - 180;
  return r === -180 ? 180 : r;
}

/** Shortest-arc interpolation between two yaws (degrees), in (−180, 180]. */
export function lerpAngle(a: number, b: number, f: number): number {
  return normalizeDeg(a + normalizeDeg(b - a) * f);
}

export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
}

/**
 * A pawn's pose `alpha` of the way from `prev` to `cur`. No interpolation (cur as is) without a
 * previous observe, across a death, or across a jump larger than SNAP_UNITS_PER_TICK.
 */
export function interpolatePose(prev: PawnObs | null | undefined, cur: PawnObs, alpha: number): Pose {
  if (prev === null || prev === undefined || prev.alive !== cur.alive) return { x: cur.pos.x, y: cur.pos.y, yaw: cur.yaw };
  const dx = cur.pos.x - prev.pos.x;
  const dy = cur.pos.y - prev.pos.y;
  if (dx * dx + dy * dy > SNAP_UNITS_PER_TICK * SNAP_UNITS_PER_TICK) return { x: cur.pos.x, y: cur.pos.y, yaw: cur.yaw };
  const f = Math.min(1, Math.max(0, alpha));
  return { x: prev.pos.x + dx * f, y: prev.pos.y + dy * f, yaw: lerpAngle(prev.yaw, cur.yaw, f) };
}

// ---- kill feed ---------------------------------------------------------------------------------

export interface KillEntry {
  readonly tick: number;
  /** null = the world (fall, bomb). */
  readonly killer: PlayerId | null;
  readonly killerTeam: Team | null;
  readonly victim: PlayerId;
  readonly victimTeam: Team;
  readonly weapon: WeaponId | null;
  readonly headshot: boolean;
}

/** CS-style kill feed: the newest `max` kills, each shown for `lifeTicks` of round time. */
export class KillFeed {
  readonly max: number;
  readonly lifeTicks: number;
  private entries: KillEntry[] = [];

  constructor(max = KILL_FEED_MAX, lifeTicks = KILL_FEED_TICKS) {
    this.max = max;
    this.lifeTicks = lifeTicks;
  }

  push(e: KillEntry): void {
    this.entries.push(e);
    // Anything older than the newest entry's life can never show again.
    const cutoff = e.tick - this.lifeTicks;
    this.entries = this.entries.filter((q) => q.tick > cutoff).slice(-this.max);
  }

  /** Entries visible at `tick`, oldest first (newest at the bottom, as in CS). */
  visible(tick: number): KillEntry[] {
    return this.entries.filter((e) => e.tick <= tick && tick - e.tick < this.lifeTicks).slice(-this.max);
  }

  /** 0..1 of an entry's life left at `tick` (for fading the last half second). */
  lifeLeft(e: KillEntry, tick: number): number {
    return Math.min(1, Math.max(0, 1 - (tick - e.tick) / this.lifeTicks));
  }

  clear(): void {
    this.entries = [];
  }
}

// ---- bomb --------------------------------------------------------------------------------------

export type BombPhaseView = 'none' | 'planted' | 'defusing' | 'defused' | 'exploded';

export interface BombState {
  readonly phase: BombPhaseView;
  readonly plantTick: number | null;
  readonly pos: Vec3 | null;
  readonly planter: PlayerId | null;
  readonly defuser: PlayerId | null;
  readonly defuseStartTick: number | null;
  /** Tick it was defused or exploded. */
  readonly endTick: number | null;
}

export const NO_BOMB: BombState = { phase: 'none', plantTick: null, pos: null, planter: null, defuser: null, defuseStartTick: null, endTick: null };

/** The bomb after a `bomb` event at `tick`. */
export function nextBombState(b: BombState, e: BombEvent, tick: number): BombState {
  switch (e.phase) {
    case 'planted':
      return { ...NO_BOMB, phase: 'planted', plantTick: tick, pos: e.pos, planter: e.id };
    case 'defuse_start':
      return { ...b, phase: 'defusing', defuser: e.id, defuseStartTick: tick, pos: b.pos ?? e.pos };
    case 'defuse_stop':
      return { ...b, phase: b.plantTick === null ? 'none' : 'planted', defuser: null, defuseStartTick: null };
    case 'defused':
      return { ...b, phase: 'defused', defuser: e.id ?? b.defuser, endTick: tick, pos: b.pos ?? e.pos };
    case 'exploded':
      return { ...b, phase: 'exploded', endTick: tick, pos: b.pos ?? e.pos };
  }
}

// ---- tracers -----------------------------------------------------------------------------------

/** The engine's 2D line-of-sight query (NavMesh.lineOfSight fits). */
export interface SightQuery {
  lineOfSight(a: Point2, b: Point2): boolean;
}

/** End of a ray from `from` along `yawDeg`: `range` units, or the last point in sight before a wall (bisection). */
export function rayEnd(from: Point2, yawDeg: number, range: number, sight: SightQuery | null): Point2 {
  const r = (yawDeg * Math.PI) / 180;
  const at = (d: number): Point2 => ({ x: from.x + Math.cos(r) * d, y: from.y + Math.sin(r) * d });
  if (sight === null || sight.lineOfSight(from, at(range))) return at(range);
  let lo = 0;
  let hi = range;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (sight.lineOfSight(from, at(mid))) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

// ---- scene -------------------------------------------------------------------------------------

export interface LogLine {
  readonly tick: number;
  readonly level: LogLevel;
  readonly text: string;
}

export interface RoundEnd {
  readonly tick: number;
  readonly winner: Team;
  readonly reason: RoundEndReason;
}

interface Born {
  readonly phase: Effect['phase'];
  readonly tick: number;
}

export class Scene {
  /** Observe before the last step, or null right after a reset. */
  prev: Observe | null = null;
  cur: Observe;
  /** Status of every pawn from the last Act (empty before the first). */
  status: readonly PawnStatus[] = [];
  readonly killFeed = new KillFeed();
  logs: LogLine[] = [];
  tracers: Tracer[] = [];
  pops: Pop[] = [];
  effects: readonly Effect[] = [];
  bomb: BombState = NO_BOMB;
  roundEnd: RoundEnd | null = null;
  /** Tick each pawn died at (from death events). */
  readonly deaths = new Map<PlayerId, number>();
  private readonly sight: SightQuery | null;
  private readonly born = new Map<number, Born>();
  private flying = new Map<number, Effect>();

  constructor(o: Observe, act: Act | null, effects: readonly Effect[] = [], sight: SightQuery | null = null) {
    this.sight = sight;
    this.cur = o;
    this.reset(o, act, effects);
  }

  /** Start over at `o` (new session, restart, or a rewind): no history, no transients. */
  reset(o: Observe, act: Act | null, effects: readonly Effect[] = []): void {
    this.prev = null;
    this.cur = o;
    this.status = act === null ? [] : act.status;
    this.killFeed.clear();
    this.logs = [];
    this.tracers = [];
    this.pops = [];
    this.bomb = NO_BOMB;
    this.roundEnd = null;
    this.deaths.clear();
    this.born.clear();
    this.flying.clear();
    this.setEffects(effects, o.tick);
    for (const p of o.pawns) if (!p.alive) this.deaths.set(p.id, o.tick);
  }

  /** After one Session.step(): the new observe, the Act Core returned for the step, the effects now active. */
  ingest(o: Observe, act: Act, effects: readonly Effect[] = []): void {
    if (o.tick <= this.cur.tick) {
      this.reset(o, act, effects);
      return;
    }
    this.prev = this.cur;
    this.cur = o;
    this.status = act.status;
    const tick = o.tick - 1;
    for (const a of act.actions) {
      if (a.type === 'log') this.logs.push({ tick, level: a.level, text: a.text });
    }
    if (this.logs.length > LOG_MAX) this.logs = this.logs.slice(-LOG_MAX);
    this.readEvents(o, tick);
    this.detectPops(o, effects, tick);
    this.setEffects(effects, tick);
    // Drop transients that have run their course.
    this.tracers = this.tracers.filter((t) => tick - t.tick < TRACER_TICKS);
    this.pops = this.pops.filter((p) => tick - p.tick < POP_TICKS[p.kind]);
  }

  /** Render time in (fractional) ticks: `alpha` of the way from the previous observe to the current one. */
  renderTick(alpha: number): number {
    if (this.prev === null) return this.cur.tick;
    return this.prev.tick + (this.cur.tick - this.prev.tick) * Math.min(1, Math.max(0, alpha));
  }

  pawn(id: PlayerId): PawnObs | null {
    return this.cur.pawns.find((p) => p.id === id) ?? null;
  }

  pose(id: PlayerId, alpha: number): Pose | null {
    const cur = this.pawn(id);
    if (cur === null) return null;
    return interpolatePose(this.prev?.pawns.find((p) => p.id === id), cur, alpha);
  }

  statusOf(id: PlayerId): PawnStatus | null {
    return this.status.find((s) => s.id === id) ?? null;
  }

  /** Tick an effect entered its current phase (for the smoke swelling in), or null. */
  bornTick(e: Effect): number | null {
    const b = this.born.get(e.seq);
    return b !== undefined && b.phase === e.phase ? b.tick : null;
  }

  private readEvents(o: Observe, tick: number): void {
    const team = (id: PlayerId | null): Team | null => (id === null ? null : (o.pawns.find((p) => p.id === id)?.team ?? null));
    for (const e of o.events) {
      switch (e.type) {
        case 'death': {
          const victimTeam = team(e.victim);
          if (victimTeam === null) break;
          this.deaths.set(e.victim, tick);
          this.killFeed.push({ tick, killer: e.attacker, killerTeam: team(e.attacker), victim: e.victim, victimTeam, weapon: e.weapon, headshot: e.headshot });
          break;
        }
        case 'shot':
          this.addTracer(o, e.shooter, e.weapon, tick);
          break;
        case 'bomb':
          this.bomb = nextBombState(this.bomb, e, tick);
          break;
        case 'round_end':
          this.roundEnd = { tick, winner: e.winner, reason: e.reason };
          break;
        default:
          break;
      }
    }
  }

  private addTracer(o: Observe, shooter: PlayerId, weapon: WeaponId, tick: number): void {
    if (NO_TRACER.includes(weapon)) return;
    const p = o.pawns.find((q) => q.id === shooter);
    if (p === undefined) return;
    // The pawn this shot damaged, if any (one shot per shooter per tick).
    let victim: PawnObs | undefined;
    for (const e of o.events) {
      if (e.type === 'damage' && e.attacker === shooter && e.weapon === weapon) {
        victim = o.pawns.find((q) => q.id === e.victim);
        break;
      }
    }
    const from = { x: p.pos.x, y: p.pos.y };
    const to = victim === undefined ? rayEnd(from, p.yaw, TRACER_RANGE_UNITS, this.sight) : { x: victim.pos.x, y: victim.pos.y };
    this.tracers.push({ tick, shooter, team: p.team, from, to, hit: victim !== undefined });
  }

  /** A flying flash or HE that is gone from the list has popped: at its `grenade` sound, else where it was last seen. */
  private detectPops(o: Observe, effects: readonly Effect[], tick: number): void {
    for (const [seq, last] of this.flying) {
      if (effects.some((e) => e.seq === seq)) continue;
      if (last.kind !== 'flash' && last.kind !== 'he') continue;
      const sound = o.events.find((e) => e.type === 'sound' && e.kind === 'grenade' && e.source === last.thrower);
      const pos = sound !== undefined && sound.type === 'sound' ? sound.pos : last.pos;
      this.pops.push({ seq, kind: last.kind, pos: { x: pos.x, y: pos.y }, tick });
    }
  }

  private setEffects(effects: readonly Effect[], tick: number): void {
    this.effects = effects;
    const live = new Set<number>();
    const flying = new Map<number, Effect>();
    for (const e of effects) {
      live.add(e.seq);
      const b = this.born.get(e.seq);
      if (b === undefined || b.phase !== e.phase) this.born.set(e.seq, { phase: e.phase, tick });
      if (e.phase === 'flying') flying.set(e.seq, e);
    }
    for (const seq of [...this.born.keys()]) if (!live.has(seq)) this.born.delete(seq);
    this.flying = flying;
  }
}
