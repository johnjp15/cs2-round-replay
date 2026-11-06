/**
 * Rejoin (G1): LIVE → REPLAY. A pawn that went LIVE because something off-script reached it (B4's triggers) goes
 * back to its recording once that is over, so the rest of the round plays out as recorded. See docs/core.md
 * "Divergence" → "Rejoin".
 *
 * Per LIVE pawn (not the human), every tick after the triggers:
 *
 * 1. **Unrest** (`unrestReason`): this tick it was hit by anyone, fired a shot itself, has an alive enemy in its `sees`
 *    that isn't the recording (an off-script enemy, or a REPLAY one the recording doesn't have it seeing then; the
 *    human on course and a pair a scheduled encounter owns don't count, as for trigger 2), or heard off-script enemy
 *    gunfire that isn't recorded fire (trigger 3). Unrest restarts the calm clock.
 * 2. **Eligible** when calm for `rejoinCalmSec`, LIVE for `rejoinMinLiveSec` (hysteresis), not busy (holding the c4:
 *    planting or about to; defusing), and its state fits its recorded future at the rejoin tick k (`fitsAt`): the
 *    recording keeps it alive and tracked until k + `rejoinMinTapeSec` (an outlived pawn has no tape left and stays
 *    LIVE); the planter with the bomb unplanted must carry it and k ≤ the recorded plant tick (a later rejoin plants
 *    late, `ScriptedEvents.shiftPlant`); the defuser with the bomb planted needs the bomb within `bomb.defuseRange` of
 *    his recorded defuse spot and k ≤ the scripted defuse's USE start; nobody rejoins once the round is over with the
 *    bomb still ticking (the LIVE AI is leaving the blast).
 * 3. **Switch** (REPLAY) on the first eligible tick its 2D distance to its puppet reference is at most
 *    `offCourseUnits`: the puppet's catch-up absorbs the rest. In this order in the Act: `block_damage` for the pairs
 *    B3 blocked and the LIVE switch lifted (self, then both directions with every enemy that is neither the human nor
 *    LIVE), the reconciliation (`give` for a pickup the recording made while it was LIVE, `set_weapon` to the recorded
 *    weapon or the c4 for a planter in its plant window), `set_mode {id, REPLAY, null}` and the log line.
 * 4. **Approach** otherwise: the earliest point k of its reference track, up to `rejoinHorizonSec` ahead, that fits
 *    and that it can reach in time (nav path length ≤ run speed × `rejoinSpeedFactor` × (k − now − `rejoinLeadSec`)),
 *    as `set_mode {id, LIVE, goal {route: [], role: 'rejoin', hold: that point}}`: the engine's AI runs there (still
 *    fighting what it meets) and the switch happens on the way or when the reference gets there. A plan is made again
 *    when the calm was broken after it, or `rejoinLateSec` after its tick; none found: again after `rejoinRetrySec`.
 *
 * Cycles REPLAY → LIVE → REPLAY → LIVE are allowed (B4's triggers apply to the rejoined puppet as to any other).
 *
 * Portable style (docs/port-notes.md "Rejoin"): plain data in the Core snapshot, integer ticks, ids in PLAYER_IDS
 * order, log texts with integers and ids only.
 */
import { PLAYER_IDS, roundNumber, type Action, type Goal, type Observe, type PawnObs, type PlayerId, type Tuning, type TrackSample, type Vec3, type WalkQuery, type WeaponId } from '../contracts/index';
import { TICK_RATE } from './clock';
import { encounterOwnsSighting, gunfireTrigger, humanOnCourse, intText, isOffScript, tenthsText, trackPosAt, type Divergence } from './divergence';
import { loadoutOf, type PawnLoadout } from './loadout';
import { dist2, runSpeedOf, type PuppetTrack } from './puppet';
import type { RoundModel } from './round-model';
import type { EventSchedule } from './schedule';
import { deployTicksOf, recordedWeaponAt, secTicks, type PawnMode, type ScriptedEvents } from './scripted';

/** `PawnStatus.trigger` of a pawn that rejoined its recording (mode REPLAY). */
export const REJOIN_TRIGGER = 'rejoin';
/** `goal.role` of a LIVE pawn heading back to its recording (docs/ai.md). */
export const REJOIN_ROLE = 'rejoin';
/** At most this many path queries per plan: a cost cap, not a calibration value. */
export const REJOIN_MAX_PATH_QUERIES = 32;

/** A planned way back: the reference position at `tick`, reachable when planned on `plannedTick`. */
export interface RejoinTarget {
  readonly tick: number;
  readonly pos: Vec3;
  readonly plannedTick: number;
  /** Nav path length (units) when planned. */
  readonly pathUnits: number;
}

/** One LIVE pawn's rejoin bookkeeping (plain data; ReplayCore snapshots it). */
export interface RejoinState {
  readonly id: PlayerId;
  /** Tick it went LIVE, and the trigger that did it (for the log line). */
  readonly liveSince: number;
  readonly trigger: string;
  /** First tick of the current calm run (no unrest), or null while there is unrest. */
  calmSince: number | null;
  /** The approach in force, or null. */
  target: RejoinTarget | null;
  /** No plan before this tick (a plan that found nothing waits `rejoinRetrySec`). */
  nextPlanTick: number;
  /** The planter on an approach inside his plant window: the act tick the Core drew the c4 for him, else null. */
  drawTick: number | null;
}

/** A pawn going back to REPLAY this tick. */
export interface RejoinHit {
  readonly id: PlayerId;
  readonly reason: string;
}

function pawnOf(o: Observe, id: PlayerId): PawnObs | undefined {
  return o.pawns.find((p) => p.id === id);
}

function modeOf(modes: readonly PawnMode[], id: PlayerId): PawnMode['mode'] | null {
  return modes.find((m) => m.id === id)?.mode ?? null;
}

function copyVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Why `id` (a LIVE pawn) is not calm this tick, or null: hit by anyone (world and self damage don't count), a shot of
 * its own, an alive enemy in its `sees` that isn't the recording (off script, or a REPLAY enemy the recording doesn't
 * have it engaging or seeing around now; the human on course and a pair a scheduled encounter owns are the recording,
 * as for trigger 2), or unexpected off-script gunfire within hearing range (trigger 3's rule).
 */
export function unrestReason(o: Observe, modes: readonly PawnMode[], id: PlayerId, model: RoundModel, d: Divergence, tuning: Tuning): string | null {
  const me = pawnOf(o, id);
  if (me === undefined) return 'not in the observe';
  for (const e of o.events) {
    if (e.type === 'damage' && e.victim === id && e.attacker !== null && e.attacker !== id) return `hit by ${e.attacker}`;
    if (e.type === 'shot' && e.shooter === id) return 'fired';
  }
  const encs = d.encounters;
  const states = d.state.encounters;
  for (const t of me.sees) {
    if (model.player(t).team === model.player(id).team) continue;
    const tp = pawnOf(o, t);
    if (tp === undefined || !tp.alive) continue;
    if (encounterOwnsSighting(o, encs, states, id, t, tuning)) continue;
    if (t === o.human && humanOnCourse(model, o, tuning)) continue;
    if (!isOffScript(o, modes, t) && d.index.saw(id, t, o.tick)) continue;
    return `sees ${t}`;
  }
  const g = gunfireTrigger(o, modes, id, model, d.index, encs, states, tuning);
  return g === null ? null : g.reason;
}

/**
 * Why `id` can't switch now whatever its position, or null: defusing, or holding the c4 (the LIVE AI plants or is
 * about to) unless the Core drew it for the approach (`drawn`).
 */
export function busyReason(o: Observe, id: PlayerId, drawn: boolean): string | null {
  const me = pawnOf(o, id);
  if (me === undefined || !me.alive) return 'dead';
  if (me.weapon === 'c4' && !drawn) return 'holds the c4';
  if (o.round.bomb.defuser === id) return 'defusing';
  return null;
}

/**
 * The rejoin planner and switch (see the file comment). ReplayCore calls `noteLive` when a pawn goes LIVE and `step`
 * every tick after the triggers, with the modes after this tick's LIVE switches, and makes the returned pawns REPLAY.
 */
export class Rejoin {
  private readonly model: RoundModel;
  private readonly schedule: EventSchedule;
  private readonly tuning: Tuning;
  private readonly divergence: Divergence;
  private readonly script: ScriptedEvents;
  private readonly walk: WalkQuery;
  private st: RejoinState[];

  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning, divergence: Divergence, script: ScriptedEvents, walk: WalkQuery) {
    this.model = model;
    this.schedule = schedule;
    this.tuning = tuning;
    this.divergence = divergence;
    this.script = script;
    this.walk = walk;
    this.st = [];
  }

  /** One entry per LIVE pawn, in PLAYER_IDS order. */
  get state(): readonly RejoinState[] {
    return this.st;
  }

  reset(): void {
    this.st = [];
  }

  restore(s: readonly RejoinState[]): void {
    this.st = s.map((r) => ({
      id: r.id,
      liveSince: r.liveSince,
      trigger: r.trigger,
      calmSince: r.calmSince,
      target: r.target === null ? null : { tick: r.target.tick, pos: copyVec(r.target.pos), plannedTick: r.target.plannedTick, pathUnits: r.target.pathUnits },
      nextPlanTick: r.nextPlanTick,
      drawTick: r.drawTick ?? null,
    }));
  }

  /** A pawn went LIVE on `tick` (B4 trigger `trigger`): start its bookkeeping. */
  noteLive(id: PlayerId, tick: number, trigger: string): void {
    const rest = this.st.filter((r) => r.id !== id);
    rest.push({ id, liveSince: tick, trigger, calmSince: null, target: null, nextPlanTick: tick, drawTick: null });
    this.st = PLAYER_IDS.flatMap((p) => rest.filter((r) => r.id === p));
  }

  /** The approach goal in force for `id` (a resync gives it back), or null. */
  goalOf(id: PlayerId): Goal | null {
    const r = this.st.find((x) => x.id === id);
    return r === undefined || r.target === null ? null : rejoinGoal(r.target.pos);
  }

  /**
   * One tick. `modes`: every pawn's Core mode after this tick's LIVE switches. `tracks`: each pawn's puppet track
   * (PLAYER_IDS order). Appends the approach `set_mode`s and every rejoin's actions to `out`, in id order, and returns
   * the pawns that go back to REPLAY.
   */
  step(o: Observe, modes: readonly PawnMode[], tracks: readonly PuppetTrack[], loadouts: readonly PawnLoadout[], out: Action[]): RejoinHit[] {
    const r = this.tuning.replay;
    const tick = o.tick;
    const hits: RejoinHit[] = [];
    const back: PlayerId[] = [];
    const keep: RejoinState[] = [];
    for (const s of this.st) {
      const me = pawnOf(o, s.id);
      if (me !== undefined && me.alive && s.id !== o.human && modeOf(modes, s.id) === 'LIVE') keep.push(s);
    }
    this.st = keep;
    for (const s of this.st) {
      if (tick <= s.liveSince) continue;
      const me = pawnOf(o, s.id) as PawnObs;
      const track = tracks[PLAYER_IDS.indexOf(s.id)];
      if (unrestReason(o, modes, s.id, this.model, this.divergence, this.tuning) !== null) {
        s.calmSince = null;
        continue;
      }
      if (s.calmSince === null) s.calmSince = tick;
      if (track === undefined || tick - s.liveSince < secTicks(r.rejoinMinLiveSec) || tick - s.calmSince < secTicks(r.rejoinCalmSec)) continue;
      if (busyReason(o, s.id, s.target !== null && s.drawTick !== null) !== null) continue;
      if (this.fitsAt(o, s.id, tick, track) && tick >= track.startTick && tick <= track.endTick) {
        const d = dist2(me.pos, track.targetAt(tick));
        if (d <= r.offCourseUnits) {
          this.rejoinActions(s, o, modes, back, me, d, loadouts, out);
          back.push(s.id);
          hits.push({ id: s.id, reason: `rejoined at tick ${tick}` });
          continue;
        }
      }
      const stale = s.target === null || tick > s.target.tick + secTicks(r.rejoinLateSec) || s.calmSince > s.target.plannedTick;
      if (!stale || tick < s.nextPlanTick) continue;
      const target = this.plan(o, s.id, me, track);
      s.target = target;
      if (target === null) {
        s.nextPlanTick = tick + Math.max(1, secTicks(r.rejoinRetrySec));
        continue;
      }
      out.push({ type: 'set_mode', id: s.id, mode: 'LIVE', goal: rejoinGoal(target.pos) });
      out.push({
        type: 'log',
        level: 'info',
        text: `${s.id} rejoin: heading for its track at tick ${target.tick} (${tenthsText(target.tick - tick, true)} s), ${intText(target.pathUnits)} u by nav; goal ${REJOIN_ROLE}`,
      });
      s.drawTick = null;
    }
    // The planter heading back into his plant window draws the c4 on the way (from the recorded draw tick on), as the
    // tape has him doing, so it is deployed when he is back: a draw lost to a fight is made again once he is calm.
    const pl = this.script.plan.plant;
    for (const s of this.st) {
      if (pl === null || s.id !== pl.id || back.includes(s.id) || s.target === null || s.calmSince === null || tick <= s.liveSince) continue;
      const me = pawnOf(o, s.id) as PawnObs;
      if (o.round.bomb.plantTick !== null || o.round.bomb.carrier !== s.id || tick < pl.selectTick || s.target.tick <= pl.selectTick || s.target.tick > pl.useTo) continue;
      if (me.weapon === 'c4' || (s.drawTick !== null && tick - s.drawTick <= this.tuning.replay.actionLatencyTicks)) continue;
      out.push({ type: 'set_weapon', id: s.id, weapon: 'c4' });
      s.drawTick = tick;
    }
    this.st = this.st.filter((s) => !back.includes(s.id));
    return hits;
  }

  /**
   * Whether `id`'s state fits its recorded future from tick `k` on (see the file comment): tape left, the planter and
   * the bomb, the defuser and the bomb, and not after a round that ended with the bomb ticking.
   */
  fitsAt(o: Observe, id: PlayerId, k: number, track: PuppetTrack): boolean {
    const r = this.tuning.replay;
    const tape = k + secTicks(r.rejoinMinTapeSec);
    const death = this.model.deathTick(id);
    if ((death !== null && tape >= death) || tape > track.endTick) return false;
    const b = o.round.bomb;
    if (o.round.phase === 'over' && b.state === 'planted') return false;
    const plan = this.script.plan;
    const pl = plan.plant;
    if (pl !== null && pl.id === id && b.plantTick === null && (b.carrier !== id || k > pl.useTo)) return false;
    const df = plan.defuse;
    if (df !== null && df.id === id && b.state === 'planted') {
      if (k > df.useFrom) return false;
      if (b.pos === null || dist2(trackPosAt(this.model, id, df.startTick), b.pos) > this.tuning.bomb.defuseRange) return false;
    }
    return true;
  }

  /**
   * The earliest reachable point of `id`'s reference track (samples after now, up to `rejoinHorizonSec`) that fits:
   * its nav path from the pawn is at most run speed (held weapon) × `rejoinSpeedFactor` × (time to it − `rejoinLeadSec`).
   * The straight line is checked first (a lower bound), and at most REJOIN_MAX_PATH_QUERIES paths are asked for.
   */
  plan(o: Observe, id: PlayerId, me: PawnObs, track: PuppetTrack): RejoinTarget | null {
    const r = this.tuning.replay;
    const tick = o.tick;
    const speed = runSpeedOf(me.weapon, this.tuning.movement) * r.rejoinSpeedFactor;
    const horizon = tick + secTicks(r.rejoinHorizonSec);
    let queries = 0;
    for (let i = 0; i < track.raw.length; i++) {
      const k = (track.raw[i] as TrackSample).tick;
      if (k <= tick) continue;
      if (k > horizon) break;
      const sec = (k - tick) / TICK_RATE - r.rejoinLeadSec;
      if (sec <= 0) continue;
      const budget = speed * sec;
      const p = track.ref[i] as Vec3;
      if (dist2(me.pos, p) > budget || !this.fitsAt(o, id, k, track)) continue;
      if (queries >= REJOIN_MAX_PATH_QUERIES) break;
      queries++;
      const len = this.walk.pathLength(me.pos, p);
      if (len === null || len > budget) continue;
      return { tick: k, pos: { x: roundNumber(p.x), y: roundNumber(p.y), z: roundNumber(p.z) }, plannedTick: tick, pathUnits: roundNumber(len) };
    }
    return null;
  }

  /** The switch's actions: blocks back, the reconciliation, `set_mode REPLAY` and the log line. */
  private rejoinActions(s: RejoinState, o: Observe, modes: readonly PawnMode[], backNow: readonly PlayerId[], me: PawnObs, off: number, loadouts: readonly PawnLoadout[], out: Action[]): void {
    const id = s.id;
    const tick = o.tick;
    const team = this.model.player(id).team;
    // The blocks B3 set at the round start and the LIVE switch lifted: self, then both ways with every enemy that is
    // neither the human nor LIVE (dead ones included, as the unblock did). A pawn rejoining earlier this tick counts
    // as REPLAY.
    for (const y of PLAYER_IDS) {
      if (y === id) {
        out.push({ type: 'block_damage', attacker: id, victim: id });
        continue;
      }
      if (y === o.human || this.model.player(y).team === team) continue;
      if (modeOf(modes, y) === 'LIVE' && !backNow.includes(y)) continue;
      out.push({ type: 'block_damage', attacker: id, victim: y });
      out.push({ type: 'block_damage', attacker: y, victim: id });
    }
    // Reconciliation: what the recording gave it while it was LIVE, and the weapon the recording has in its hands.
    const items = loadoutOf(loadouts, id).items.map((q) => q.item as string);
    const plan = this.script.plan;
    for (const it of plan.inventory) {
      if (it.id !== id || it.give === null || it.emitTick < s.liveSince || it.emitTick >= tick || items.includes(it.weapon)) continue;
      out.push({ type: 'give', id, item: it.weapon, clip: it.give.clip, reserve: it.give.reserve });
      items.push(it.weapon);
    }
    const pl = plan.plant;
    const planting = pl !== null && pl.id === id && o.round.bomb.plantTick === null && o.round.bomb.carrier === id && tick > pl.selectTick && tick <= pl.useTo;
    let want: WeaponId = recordedWeaponAt(this.model, this.schedule, id, tick);
    if (planting) want = 'c4';
    if (me.weapon !== want && (want === 'knife' || want === 'c4' || items.includes(want))) out.push({ type: 'set_weapon', id, weapon: want });
    if (planting && pl !== null) {
      // A planter back in his plant window: the USE starts once the c4 is deployed (drawn on the approach, else now)
      // and he is at the recorded spot (the puppet walks there), never before the recorded USE start.
      const drawn = me.weapon === 'c4' && s.drawTick !== null ? s.drawTick : tick;
      const reach = Math.ceil((dist2(me.pos, pl.pos) / runSpeedOf(me.weapon, this.tuning.movement)) * TICK_RATE);
      const useFrom = Math.max(pl.useFrom, drawn + deployTicksOf('c4', this.tuning), tick + reach);
      this.script.shiftPlant(useFrom - pl.useFrom, tick, out);
    }
    out.push({ type: 'set_mode', id, mode: 'REPLAY', goal: null });
    out.push({
      type: 'log',
      level: 'info',
      text: `${id} REPLAY: rejoined at tick ${tick}, ${intText(off)} u from its track, after ${tenthsText(tick - s.liveSince, false)} s LIVE (${s.trigger})`,
    });
  }
}

/** The approach goal: run to `pos` (the rejoin point) and wait there. */
export function rejoinGoal(pos: Vec3): Goal {
  return { route: [], role: REJOIN_ROLE, hold: copyVec(pos) };
}
