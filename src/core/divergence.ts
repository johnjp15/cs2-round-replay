/**
 * Divergence (B4): REPLAY → LIVE. A puppet follows its recording until something happens that its recorded self never
 * experienced; then that puppet, and only that one, plays LIVE (the engine's AI drives it) and carries its recorded
 * intent forward as a goal. Divergence spreads only through cause and effect from an off-script pawn (the human or a
 * LIVE pawn): damage, sight, gunfire, a body block. A pawn that outlives its recording goes LIVE too. Modes go one way:
 * REPLAY → LIVE → DEAD. See docs/core.md "Divergence".
 *
 * - The five triggers are pure functions over the Observe and Core state (`damageTrigger`, `sightingTrigger`,
 *   `gunfireTrigger`, `outlivedTrigger`, `blockedTrigger`).
 * - `ExpectedEncounters`: what the recording says about who saw and who shot whom when (schedule + `sightings[]`), so a
 *   sighting or a shot that the recording has (give or take a window) is not divergence.
 * - Scheduled encounters (`EncounterPlan`, `EncounterState`): a recorded non-lethal hit on the human (Lokier's 73 on
 *   cart) is time-shifted to the moment the shooter actually sees the human at the recorded spot, instead of diverging.
 * - Goals (`liveIntent`, `liveGoal`, `thinRoute`, `dwellSpot`): the remaining recorded track thinned to decision points,
 *   a role the engine's AI knows, and where to hold.
 *
 * Portable style (docs/port-notes.md "Divergence"): plain data, integer ticks, ids iterated in PLAYER_IDS order, log
 * texts with integers and ids only (tenths of seconds come from integer tick arithmetic).
 */
import { PLAYER_IDS, roundNumber, type Action, type Goal, type Observe, type PawnObs, type PlayerId, type Tuning, type TrackSample, type Vec3, type WeaponId } from '../contracts/index';
import { TICK_RATE } from './clock';
import { bandPoint, type AimBand } from './aim';
import { dist2 } from './puppet';
import type { RoundModel } from './round-model';
import type { DamageEntry, EventSchedule } from './schedule';
import { secTicks, type PawnMode, type ScriptPlan, type ScriptedEvents } from './scripted';

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/**
 * What switched a pawn to LIVE (`PawnStatus.trigger`). G4: `released`: the human let go of his pawn mid-round without
 * a rewind (CS2: the player left; the bot plays on), so it goes on as a LIVE bot (docs/core.md "Takeover").
 */
export const TRIGGER_KINDS = ['damage', 'sighting', 'gunfire', 'outlived', 'blocked', 'encounter', 'released'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export interface TriggerHit {
  readonly id: PlayerId;
  readonly trigger: TriggerKind;
  /** Why, for the log line (`lokier LIVE: outlived recording (+3.0 s)`): integers and ids only. */
  readonly reason: string;
}

function pawnOf(o: Observe, id: PlayerId): PawnObs | undefined {
  return o.pawns.find((p) => p.id === id);
}

function modeOf(modes: readonly PawnMode[], id: PlayerId): PawnMode['mode'] | null {
  return modes.find((m) => m.id === id)?.mode ?? null;
}

/** True for the human's pawn and for LIVE pawns: what they do is not in the recording. */
export function isOffScript(o: Observe, modes: readonly PawnMode[], id: PlayerId): boolean {
  return id === o.human || modeOf(modes, id) === 'LIVE';
}

/** A REPLAY puppet the triggers apply to: alive, not the human, mode REPLAY. */
export function isPuppet(o: Observe, modes: readonly PawnMode[], id: PlayerId): boolean {
  return id !== o.human && pawnOf(o, id)?.alive === true && modeOf(modes, id) === 'REPLAY';
}

function enemies(model: RoundModel, a: PlayerId, b: PlayerId): boolean {
  return model.player(a).team !== model.player(b).team;
}

/** `x` rounded half up to an integer, as text (`Math.Floor(x + 0.5)` in C#). */
export function intText(x: number): string {
  const r = Math.floor(x + 0.5);
  return String(r === 0 ? 0 : r);
}

/** A tick count as signed seconds with one decimal, from integer arithmetic only: 192 → "+3.0", −13 → "-0.2". */
export function tenthsText(ticks: number, signed: boolean): string {
  const neg = ticks < 0;
  const tenths = Math.floor((Math.abs(ticks) * 10) / TICK_RATE + 0.5);
  const body = `${Math.floor(tenths / 10)}.${tenths % 10}`;
  if (tenths === 0) return signed ? `+${body}` : body;
  return neg ? `-${body}` : signed ? `+${body}` : body;
}

/**
 * Trigger 1, unscripted damage: a `damage` event this tick on `id` from the human or a LIVE pawn (any hit, any weapon,
 * grenades included; world damage and self-damage don't count).
 */
export function damageTrigger(o: Observe, modes: readonly PawnMode[], id: PlayerId): TriggerHit | null {
  for (const e of o.events) {
    if (e.type !== 'damage' || e.victim !== id || e.attacker === null || e.attacker === id) continue;
    if (!isOffScript(o, modes, e.attacker)) continue;
    return { id, trigger: 'damage', reason: `hit by ${e.attacker} (${intText(e.amount)} hp${e.weapon === null ? '' : `, ${e.weapon}`})` };
  }
  return null;
}

/**
 * The human is on course (on script) at `tick` when he is within `offCourseUnits` (2D) of his own recorded track. A
 * puppet's view of him is then the recording's view of him, so it is not divergence (exactly as two puppets seeing
 * each other is not).
 */
export function humanOnCourse(model: RoundModel, o: Observe, tuning: Tuning): boolean {
  return o.human !== null && onCourse(model, o, o.human, tuning);
}

/** `id` is alive and within `offCourseUnits` (2D) of its recorded track at this tick (G5: also for a puppet). */
export function onCourse(model: RoundModel, o: Observe, id: PlayerId, tuning: Tuning): boolean {
  const h = pawnOf(o, id);
  const rec = model.trackAtTick(id, o.tick);
  return h !== undefined && h.alive && rec !== null && dist2(h.pos, rec.pos) <= tuning.replay.offCourseUnits;
}

/**
 * G7: the smallest 2D distance from `pos` to `id`'s recorded track between ticks `tick − drift` and `tick + drift`
 * (clamped to the track; the track between its samples is the straight segment, as `trackAtTick` interpolates it).
 * With `drift` 0 it is the distance to the recorded position at `tick`.
 */
export function distanceToRecording(model: RoundModel, id: PlayerId, pos: Vec3, tick: number, drift: number): number {
  const lo = tick - drift;
  const hi = tick + drift;
  let prev = trackPosAt(model, id, lo);
  let best = dist2(pos, prev);
  for (const s of model.track(id)) {
    if (s.tick <= lo) continue;
    if (s.tick >= hi) break;
    const d = segmentDistance(pos, prev, s);
    if (d < best) best = d;
    prev = { x: s.x, y: s.y, z: s.z };
  }
  const end = trackPosAt(model, id, hi);
  const d = segmentDistance(pos, prev, end);
  return d < best ? d : best;
}

/**
 * G7: `id` (alive) is where its recording has it, give or take `driftSec`: within `units` (2D) of its recorded track
 * at some tick within `driftSec` of now.
 */
export function nearRecording(model: RoundModel, o: Observe, id: PlayerId, units: number, driftSec: number): boolean {
  const h = pawnOf(o, id);
  return h !== undefined && h.alive && distanceToRecording(model, id, h.pos, o.tick, secTicks(driftSec)) <= units;
}

/**
 * G7: the human is "the recording" (on script) at this tick: within `offCourseUnits` (2D) of where his recording has
 * him at some tick within `onCourseDriftSec` of now (earlier or later: a human never plays the tape's timing exactly).
 * A puppet's view of him is then the recording's view of him, so it is not divergence (exactly as two puppets seeing
 * each other is not). Beyond that he is off script for every bot that sees him: cart in the Apartments corridor at
 * 10 s, where his recording is 7 s later, is a T in Lokier's scope, not the recording. Replaces `humanOnCourse` (the
 * exact tick, still used for "the hit on its recorded tick") in triggers 2 and in the rejoin's calm.
 */
export function humanOnScript(model: RoundModel, o: Observe, tuning: Tuning): boolean {
  return o.human !== null && nearRecording(model, o, o.human, tuning.replay.offCourseUnits, tuning.replay.onCourseDriftSec);
}

/**
 * G7: a recorded pair explains `viewer` seeing `target` now: the recording has them engaging or sighted around now
 * (`ExpectedEncounters.saw`), and either the target is about where its recording has it (within
 * `humanSpotToleranceUnits`, 2D, of its recorded track within the sighting window of now) or it is beyond
 * `closeRangeUnits` (a long look across the map, where the engine's sight and the 2020 map differ most). Face to face
 * with an enemy who is somewhere else than the tape has him, a recorded pair is not enough: cart walking up to sp4rtan
 * on B in the window the tape has them see each other from the Shop door is not that sighting.
 */
export function recordedPairInSight(model: RoundModel, o: Observe, index: ExpectedEncounters, viewer: PlayerId, target: PlayerId, tuning: Tuning): boolean {
  if (!index.saw(viewer, target, o.tick)) return false;
  const v = pawnOf(o, viewer);
  const t = pawnOf(o, target);
  if (v === undefined || t === undefined) return false;
  if (dist2(v.pos, t.pos) > tuning.replay.closeRangeUnits) return true;
  return nearRecording(model, o, target, tuning.replay.humanSpotToleranceUnits, tuning.replay.expectedSightingWindowSec);
}

/**
 * Trigger 2, unscripted sighting: `id` sees (its `sees`) an enemy that is off script (the human or a LIVE pawn) and the
 * recording doesn't have the pair engaging or sighted around this tick with the enemy about where the tape has it
 * (`recordedPairInSight`, G7). Not counted: the human while he is on script (`humanOnScript`, G7: within the drift of
 * his recorded track), and a pair a scheduled encounter owns (`encounterOwnsSighting`). G7: so a bot that can see an
 * enemy the recording doesn't have it seeing goes LIVE at once and the engine's AI fights (after its reaction time).
 */
export function sightingTrigger(
  o: Observe,
  modes: readonly PawnMode[],
  id: PlayerId,
  model: RoundModel,
  index: ExpectedEncounters,
  encounters: readonly EncounterPlan[],
  states: readonly EncounterState[],
  tuning: Tuning,
): TriggerHit | null {
  const me = pawnOf(o, id);
  if (me === undefined) return null;
  for (const t of me.sees) {
    if (!enemies(model, id, t) || !isOffScript(o, modes, t)) continue;
    const tp = pawnOf(o, t);
    if (tp === undefined || !tp.alive) continue;
    if (t === o.human && humanOnScript(model, o, tuning)) continue;
    if (encounterOwnsSighting(o, encounters, states, id, t, tuning)) continue;
    if (recordedPairInSight(model, o, index, id, t, tuning)) continue;
    return { id, trigger: 'sighting', reason: `sees ${t} (${t === o.human ? 'the human' : 'LIVE'}), not in the recording` };
  }
  return null;
}

/**
 * Trigger 3, unscripted gunfire nearby: a `sound` of kind `shot` this tick from an enemy that is off script, within
 * `replay.hearingRangeUnits` (2D, as the engine's AI hears), that is not recorded fire of that shooter
 * (`recordedFire`).
 */
export function gunfireTrigger(
  o: Observe,
  modes: readonly PawnMode[],
  id: PlayerId,
  model: RoundModel,
  index: ExpectedEncounters,
  encounters: readonly EncounterPlan[],
  states: readonly EncounterState[],
  tuning: Tuning,
): TriggerHit | null {
  const me = pawnOf(o, id);
  if (me === undefined) return null;
  for (const e of o.events) {
    if (e.type !== 'sound' || e.kind !== 'shot' || e.source === null || e.source === id) continue;
    if (!enemies(model, id, e.source) || !isOffScript(o, modes, e.source)) continue;
    const d = dist2(me.pos, e.pos);
    if (d > tuning.replay.hearingRangeUnits) continue;
    if (recordedFire(o, index, encounters, states, e.source, model, tuning, e.pos)) continue;
    return { id, trigger: 'gunfire', reason: `heard ${e.source} fire ${intText(d)} u away` };
  }
  return null;
}

/**
 * Whether a shot by `shooter` this tick is recorded fire: the recording has `shooter` firing within
 * `expectedGunfireWindowSec`, from about where the tape has it then (G7: `from`, the shot's position, within
 * `humanSpotToleranceUnits` (2D) of its recorded track within that window: the same gun going off somewhere else is
 * not the recording), or (the human in a scheduled encounter that has started) firing at the encounter's shooter
 * within that window of the encounter's time shift, from within `humanSpotToleranceUnits` of its spot.
 */
export function recordedFire(
  o: Observe,
  index: ExpectedEncounters,
  encounters: readonly EncounterPlan[],
  states: readonly EncounterState[],
  shooter: PlayerId,
  model: RoundModel,
  tuning: Tuning,
  from: Vec3,
): boolean {
  const tol = tuning.replay.humanSpotToleranceUnits;
  if (index.fired(shooter, null, o.tick, 0) && distanceToRecording(model, shooter, from, o.tick, index.fireWindow) <= tol) return true;
  for (let i = 0; i < encounters.length; i++) {
    const p = encounters[i] as EncounterPlan;
    const s = states[i];
    if (s === undefined || p.victim !== shooter || o.human !== p.victim || s.seenTick === null) continue;
    if (index.fired(shooter, p.shooter, o.tick, s.seenTick - p.recordedSightTick) && dist2(from, p.spot) <= tol) return true;
  }
  return false;
}

/** Trigger 4, outlived its recording: its recorded death (kill feed) was `outliveGraceSec` or more ago, and it is alive. */
export function outlivedTrigger(o: Observe, model: RoundModel, id: PlayerId, tuning: Tuning): TriggerHit | null {
  const death = model.deathTick(id);
  if (death === null) return null;
  if (o.tick < death + secTicks(tuning.replay.outliveGraceSec)) return null;
  return { id, trigger: 'outlived', reason: `outlived recording (${tenthsText(o.tick - death, true)} s)` };
}

/**
 * The solid pawn `id` is in contact with on the side of its reference `ref`, or null: an alive enemy (a teammate too
 * with `collision.solidTeammates`) whose centre is within 2 × `collision.pawnRadius` + `contactSlackUnits` (2D) and
 * whose direction is within 90° of the direction to `ref` (it stands in the way back to the track). First in id order.
 */
export function blockingPawn(o: Observe, id: PlayerId, ref: Vec3, tuning: Tuning): PlayerId | null {
  const me = pawnOf(o, id);
  if (me === undefined || !me.alive) return null;
  const contact = 2 * tuning.collision.pawnRadius + tuning.replay.contactSlackUnits;
  for (const q of o.pawns) {
    if (q.id === id || !q.alive) continue;
    if (q.team === me.team && !tuning.collision.solidTeammates) continue;
    if (dist2(me.pos, q.pos) > contact) continue;
    const dot = (q.pos.x - me.pos.x) * (ref.x - me.pos.x) + (q.pos.y - me.pos.y) * (ref.y - me.pos.y);
    if (dot > 0) return q.id;
  }
  return null;
}

/**
 * Trigger 5, pushed off course while visible: the human sees `id`, it is body-blocked (`blockingPawn`), and either
 * - pushed: the block has added more than `offCourseUnits` to its distance from its puppet reference `ref` (now minus
 *   `contact.behind`, the distance when this contact began), so a puppet that already lags its recording (sp4rtan's
 *   fast inferred track) isn't switched by a touch; or
 * - held: it has stood in that contact (speed below `standSpeedThreshold`) for `blockedSec` while more than
 *   `offCourseUnits` from its reference.
 * Inferred from the observed positions and velocities only (the engine's `blockedBy` is a debug hint the Core can't
 * use): neither the 2D engine nor CS2 pushes players, so a block shows as a pawn held in contact (stopped, or sliding
 * off) while its reference moves on. `contact` is the ContactState Divergence keeps (null: not in contact).
 */
export function blockedTrigger(o: Observe, id: PlayerId, ref: Vec3 | null, contact: ContactState | null, tuning: Tuning): TriggerHit | null {
  if (ref === null || contact === null || o.human === null) return null;
  const r = tuning.replay;
  const human = pawnOf(o, o.human);
  const me = pawnOf(o, id);
  if (human === undefined || me === undefined || !human.alive || !human.sees.includes(id)) return null;
  const by = blockingPawn(o, id, ref, tuning);
  if (by === null) return null;
  const off = dist2(me.pos, ref);
  const pushed = off - contact.behind;
  if (pushed > r.offCourseUnits) return { id, trigger: 'blocked', reason: `blocked by ${by}, pushed ${intText(pushed)} u off course, seen by ${o.human}` };
  const held = contact.stalledSince !== null && o.tick - contact.stalledSince >= secTicks(r.blockedSec);
  if (held && off > r.offCourseUnits) return { id, trigger: 'blocked', reason: `blocked by ${by}, held ${intText(off)} u off course, seen by ${o.human}` };
  return null;
}

// ---------------------------------------------------------------------------
// Expected encounters
// ---------------------------------------------------------------------------

/** A recorded span (ticks, inclusive) in which two players engaged or were sighted; `a` < `b` (ordinal). */
export interface PairSpan {
  readonly a: PlayerId;
  readonly b: PlayerId;
  readonly from: number;
  readonly to: number;
  /** `shot`, `burst`, `damage`, `kill` or `sighting`. */
  readonly source: string;
}

/** A recorded span (ticks, inclusive) in which `shooter` fired, at `target` (null: not known). */
export interface FireSpan {
  readonly shooter: PlayerId;
  readonly target: PlayerId | null;
  readonly from: number;
  readonly to: number;
}

function pairSpan(x: PlayerId, y: PlayerId, from: number, to: number, source: string): PairSpan {
  return x < y ? { a: x, b: y, from, to, source } : { a: y, b: x, from, to, source };
}

/**
 * What the recording says about who saw and who shot at whom, and when. Built once from the schedule and
 * `sightings[]`:
 * - pairs (symmetric: in a recorded engagement both sides count as seeing each other): every `shot` and `burst` with a
 *   target (the burst over its whole window), every `damage` and `kill` (attacker, victim), every `sightings[]` entry
 *   (`who` with each player its `by` names, over [tick0, tick1]);
 * - fire: every `shot`, `burst` (its window) and `kill` (a kill implies a shot) by its shooter.
 */
export class ExpectedEncounters {
  readonly pairs: readonly PairSpan[];
  readonly fire: readonly FireSpan[];
  /** `expectedSightingWindowSec` and `expectedGunfireWindowSec` in ticks. */
  readonly sightWindow: number;
  readonly fireWindow: number;

  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning) {
    const pairs: PairSpan[] = [];
    const fire: FireSpan[] = [];
    for (const e of schedule.events) {
      if (e.type === 'shot') {
        fire.push({ shooter: e.shooter, target: e.target, from: e.tick, to: e.tick });
        if (e.target !== null && e.target !== e.shooter) pairs.push(pairSpan(e.shooter, e.target, e.tick, e.tick, 'shot'));
      } else if (e.type === 'burst') {
        fire.push({ shooter: e.shooter, target: e.target, from: e.tick0, to: e.tick1 });
        if (e.target !== null && e.target !== e.shooter) pairs.push(pairSpan(e.shooter, e.target, e.tick0, e.tick1, 'burst'));
      } else if (e.type === 'damage') {
        if (e.attacker !== e.victim) pairs.push(pairSpan(e.attacker, e.victim, e.tick, e.tick, 'damage'));
      } else if (e.type === 'kill') {
        fire.push({ shooter: e.killer, target: e.victim, from: e.tick, to: e.tick });
        if (e.killer !== e.victim) pairs.push(pairSpan(e.killer, e.victim, e.tick, e.tick, 'kill'));
      }
    }
    for (const s of model.sightings) for (const b of s.by) pairs.push(pairSpan(s.who, b, s.tick0, s.tick1, 'sighting'));
    this.pairs = pairs;
    this.fire = fire;
    this.sightWindow = secTicks(tuning.replay.expectedSightingWindowSec);
    this.fireWindow = secTicks(tuning.replay.expectedGunfireWindowSec);
  }

  /** True when the recording has `x` and `y` engaging or sighted within the sighting window of `tick`. */
  saw(x: PlayerId, y: PlayerId, tick: number): boolean {
    const a = x < y ? x : y;
    const b = x < y ? y : x;
    const w = this.sightWindow;
    for (const p of this.pairs) if (p.a === a && p.b === b && tick >= p.from - w && tick <= p.to + w) return true;
    return false;
  }

  /**
   * True when the recording has `shooter` firing (at `target`, or at anyone when null) within the gunfire window of
   * `tick − shift` (`shift`: how much later than recorded the fire is expected, e.g. a time-shifted encounter).
   */
  fired(shooter: PlayerId, target: PlayerId | null, tick: number, shift: number): boolean {
    const k = tick - shift;
    const w = this.fireWindow;
    for (const f of this.fire) {
      if (f.shooter !== shooter || (target !== null && f.target !== target)) continue;
      if (k >= f.from - w && k <= f.to + w) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduled encounters
// ---------------------------------------------------------------------------

/**
 * A recorded non-lethal hit on the default human (cart) by an enemy puppet, played time-shifted instead of as divergence:
 * Lokier's 73 HP / 7 armor SSG 08 hit at 18.50 s. Active only while that player is the human.
 */
export interface EncounterPlan {
  /** `enc:<i>`; also names its run-time fire item (`fire:enc:<i>`) and engagement (`aim:enc:<i>`). */
  readonly key: string;
  readonly shooter: PlayerId;
  readonly victim: PlayerId;
  readonly damage: DamageEntry;
  readonly band: AimBand;
  readonly weapon: WeaponId;
  /** The latest recorded sighting of the pair that starts at or before the hit (the time shift's origin), else the hit tick. */
  readonly recordedSightTick: number;
  /** The victim's recorded position at the hit (cart at the Apartments window). */
  readonly spot: Vec3;
  /** The plan's recorded fire items and engagements of this hit, suppressed while the encounter is active. */
  readonly fireKeys: readonly string[];
  readonly aimKeys: readonly string[];
  /** From this tick (the recorded aim's start) the shooter holds the angle on the spot until the encounter ends. */
  readonly holdFromTick: number;
}

export type EncounterPhase = 'waiting' | 'seen' | 'fired' | 'done';

/** One encounter's run-time state (plain data; in the Core snapshot). */
export interface EncounterState {
  readonly key: string;
  /** waiting → seen (the shooter sees the human at the spot) → fired (scripted hit) → done; or done from any. */
  phase: EncounterPhase;
  /** Tick the shooter first saw the human at the spot. */
  seenTick: number | null;
  /** Observe tick the scripted hit lands on (seenTick + encounterDelaySec). */
  shotTick: number | null;
  /** True while the `block_damage` shooter → victim sent with the scripted shot is in force. */
  blocked: boolean;
  /**
   * G4: while nobody controls the victim (`observe.human` null: he is a puppet), the first tick the shooter (REPLAY)
   * saw him within `humanSpotToleranceUnits` of the spot, else null. Only noted, nothing acts on it; a takeover before
   * the hit starts the encounter as seen from this tick (`Divergence.takeover`).
   */
  puppetSightTick: number | null;
  /** G5: the puppet was on course (`onCourse`) at `puppetSightTick`, so a takeover gets the hit on its recorded tick. */
  puppetSightOnCourse: boolean;
}

/**
 * G5: the observe tick an encounter's hit is due when the shooter first sees the human at the spot on `seenTick`. On
 * course then (where his recording has him: he is the recording, as for trigger 2), the recorded tick, if it is at least
 * one latency (`lead`) ahead: tape-like play gets the hit of the tape (18.50 s), whatever tick the engine's sight
 * catches him on. Otherwise (early, late, or somewhere else at the spot) `encounterDelaySec` after the sighting (B4).
 */
export function encounterShotTick(p: EncounterPlan, seenTick: number, onCourseThen: boolean, lead: number, tuning: Tuning): number {
  if (onCourseThen && p.damage.tick >= seenTick + lead) return p.damage.tick;
  const delay = secTicks(tuning.replay.encounterDelaySec);
  return seenTick + (delay > lead ? delay : lead);
}

function bandOf(hitgroup: string): AimBand {
  return hitgroup === 'head' || hitgroup === 'stomach' || hitgroup === 'leg' ? hitgroup : 'chest';
}

/**
 * The track position at `tick`, clamped by tick to the first and last sample (a sample's tick is round(t × 64), so
 * tick / 64 can fall just before its t; at or after the last sample's tick this is that sample, exactly).
 */
export function trackPosAt(model: RoundModel, id: PlayerId, tick: number): Vec3 {
  const s = model.track(id);
  const first = s[0] as TrackSample;
  const last = s[s.length - 1] as TrackSample;
  const q = tick <= first.tick ? first : tick >= last.tick ? last : null;
  if (q !== null) return { x: q.x, y: q.y, z: q.z };
  const p = model.trackAtTick(id, tick);
  return p === null ? { x: last.x, y: last.y, z: last.z } : p.pos;
}

/** The scheduled encounters of the round: every non-lethal recorded hit on the default human by an enemy. */
export function buildEncounters(model: RoundModel, schedule: EventSchedule, plan: ScriptPlan, index: ExpectedEncounters, tuning: Tuning): EncounterPlan[] {
  const human = model.players.find((p) => p.isHumanDefault)?.id ?? null;
  if (human === null) return [];
  const li = tuning.replay.inputLatencyTicks;
  const out: EncounterPlan[] = [];
  for (const d of schedule.ofType('damage')) {
    if (d.lethal || d.victim !== human || !enemies(model, d.attacker, d.victim)) continue;
    let sight: number | null = null;
    for (const p of index.pairs) {
      const pair = (p.a === d.attacker && p.b === d.victim) || (p.a === d.victim && p.b === d.attacker);
      if (pair && p.source === 'sighting' && p.from <= d.tick && (sight === null || p.from > sight)) sight = p.from;
    }
    const fireKeys = plan.fire.filter((f) => f.shooter === d.attacker && f.target === d.victim && f.shotTicks.some((k) => k >= d.tick - 1 && k <= d.tick + 1)).map((f) => f.key);
    const aims = plan.engagements.filter((e) => e.shooter === d.attacker && e.target === d.victim && e.fromTick <= d.tick - li && e.toTick >= d.tick - li);
    let holdFrom = d.tick - li - secTicks(tuning.replay.preAimSec);
    for (const e of aims) if (e.fromTick < holdFrom) holdFrom = e.fromTick;
    out.push({
      key: `enc:${out.length}`,
      shooter: d.attacker,
      victim: d.victim,
      damage: d,
      band: bandOf(d.hitgroup),
      weapon: d.weapon,
      recordedSightTick: sight ?? d.tick,
      spot: trackPosAt(model, d.victim, d.tick),
      fireKeys,
      aimKeys: aims.map((e) => e.key),
      holdFromTick: holdFrom,
    });
  }
  return out;
}

/**
 * Whether a scheduled encounter owns `viewer` seeing `target` (so trigger 2 doesn't apply): the encounter is active
 * (its victim is the human), `viewer` is its shooter and `target` its victim, and either it is in its `seen` second
 * (the gate decides), or it is waiting or fired with the victim at the recorded spot (`humanSpotToleranceUnits`): the
 * sighting that starts it, and the recorded duel at the window after the hit. Seen anywhere else, the human is
 * judged by the normal sighting rule (on script, recorded pair, else LIVE). G7: while waiting, only within the
 * encounter window (`inEncounterWindow`): at the spot 6 s early he is a T in the window, not the recording.
 */
/**
 * G7: `tick` is within `encounterWindowSec` of the encounter's recorded sighting (the time shift's origin), earlier or
 * later: a sighting at the spot then starts the time-shifted hit; outside it the encounter is cancelled (a real fight).
 */
export function inEncounterWindow(p: EncounterPlan, tick: number, tuning: Tuning): boolean {
  const w = secTicks(tuning.replay.encounterWindowSec);
  return tick >= p.recordedSightTick - w && tick <= p.recordedSightTick + w;
}

export function encounterOwnsSighting(o: Observe, encounters: readonly EncounterPlan[], states: readonly EncounterState[], viewer: PlayerId, target: PlayerId, tuning: Tuning): boolean {
  const tp = pawnOf(o, target);
  for (let i = 0; i < encounters.length; i++) {
    const p = encounters[i] as EncounterPlan;
    const s = states[i];
    if (s === undefined || p.shooter !== viewer || p.victim !== target || o.human !== p.victim) continue;
    if (s.phase === 'seen') return true;
    if (s.phase === 'waiting' && !inEncounterWindow(p, o.tick, tuning)) continue;
    if ((s.phase === 'waiting' || s.phase === 'fired') && tp !== undefined && dist2(tp.pos, p.spot) <= tuning.replay.humanSpotToleranceUnits) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** Distance (2D) from p to the segment a–b. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist2(p, a);
  let u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (u < 0) u = 0;
  if (u > 1) u = 1;
  return dist2(p, { x: a.x + u * dx, y: a.y + u * dy, z: 0 });
}

/**
 * Ramer–Douglas–Peucker (2D) with an explicit stack: keeps the first and last point and every point further than
 * `tolerance` from the simplified line, so corners and doorways stay and straight runs collapse. The furthest point of a
 * span wins; on a tie the first.
 */
export function thinRoute(points: readonly Vec3[], tolerance: number): Vec3[] {
  const n = points.length;
  if (n <= 2) return points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  const keep: boolean[] = [];
  for (let i = 0; i < n; i++) keep.push(i === 0 || i === n - 1);
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    let best = -1;
    let bestD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i] as Vec3, points[a] as Vec3, points[b] as Vec3);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = true;
      stack.push(a, best, best, b);
    }
  }
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === true) out.push({ x: (points[i] as Vec3).x, y: (points[i] as Vec3).y, z: (points[i] as Vec3).z });
  return out;
}

/**
 * A T's guard spot after the plant: the longest recorded stay from `fromTick` on, i.e. the run of consecutive samples
 * all within `radius` (2D) of the run's first sample that lasts longest (the first on a tie); the spot is the run's
 * middle sample and `tick` its first. Without samples from `fromTick` on: the last sample.
 */
export function dwellSpot(samples: readonly TrackSample[], fromTick: number, radius: number): { pos: Vec3; tick: number } {
  let bi = -1;
  let bj = -1;
  for (let i = 0; i < samples.length; i++) {
    const si = samples[i] as TrackSample;
    if (si.tick < fromTick) continue;
    let j = i;
    while (j + 1 < samples.length && dist2(samples[j + 1] as TrackSample, si) <= radius) j++;
    if (bi < 0 || (samples[j] as TrackSample).tick - si.tick > (samples[bj] as TrackSample).tick - (samples[bi] as TrackSample).tick) {
      bi = i;
      bj = j;
    }
  }
  if (bi < 0) {
    const last = samples[samples.length - 1] as TrackSample;
    return { pos: { x: last.x, y: last.y, z: last.z }, tick: last.tick };
  }
  const mid = samples[Math.floor((bi + bj) / 2)] as TrackSample;
  return { pos: { x: mid.x, y: mid.y, z: mid.z }, tick: (samples[bi] as TrackSample).tick };
}

/** What a pawn means to do from here, from the recording: the AI role, the recorded tick its route runs to, and where it holds. */
export interface LiveIntent {
  /** One of the engine AI's roles (docs/ai.md): hold rotate take_site plant guard_bomb retake defuse hunt. */
  readonly role: string;
  /** The route is the recorded track from now to this tick. */
  readonly anchorTick: number;
  readonly hold: Vec3;
}

/**
 * The role and hold spot for `id` going LIVE now, by team, phase (`observe.round`) and the player's `roles`:
 * - T, bomb not planted: `plant` for the c4 carrier (hold: the recorded bomb position), else `take_site` (hold: where
 *   the recording has it at the plant); the route runs to the recorded plant.
 * - T, bomb planted: `guard_bomb` from the recorded post-plant spot (`dwellSpot`: barely on the Tunnel / underpass
 *   stairs, donk in the Apartments); the route runs to the start of that stay.
 * - CT with a `…retake…` role (sp4rtan's flank_then_retake): `retake`, `defuse` once the bomb is planted; route and
 *   hold to his recorded defuse start (the flank via T side and the Apartments to B).
 * - CT `rotate…` (zwomp): `rotate`; other CTs (`hold_a`, `hold_b`): `hold`; route and hold to the end of the track.
 */
export function liveIntent(model: RoundModel, id: PlayerId, o: Observe, tuning: Tuning): LiveIntent {
  const p = model.player(id);
  const samples = model.track(id);
  const trackEnd = (samples[samples.length - 1] as TrackSample).tick;
  const planted = o.round.bomb.plantTick !== null;
  if (p.team === 'T') {
    if (!planted) {
      const carrier = o.round.bomb.carrier === id;
      const anchor = model.bomb.plantTick;
      return { role: carrier ? 'plant' : 'take_site', anchorTick: anchor, hold: carrier ? { ...model.bomb.pos } : trackPosAt(model, id, anchor) };
    }
    const spot = dwellSpot(samples, model.bomb.plantTick, tuning.replay.dwellUnits);
    return { role: 'guard_bomb', anchorTick: spot.tick, hold: spot.pos };
  }
  const role = p.roles[0] ?? p.role;
  if (role.includes('retake')) {
    const anchor = model.bomb.defuseStartTick;
    return { role: planted ? 'defuse' : 'retake', anchorTick: anchor, hold: trackPosAt(model, id, anchor) };
  }
  return { role: role.startsWith('rotate') ? 'rotate' : 'hold', anchorTick: trackEnd, hold: trackPosAt(model, id, trackEnd) };
}

/**
 * The `set_mode LIVE` goal: `liveIntent`'s role and hold, and as route the recorded track from now to its anchor tick
 * (the pawn's position first), thinned with `thinRoute(routeThinUnits)`, without that first point and without a last
 * point equal to `hold`. Empty when the anchor has passed (an outlived pawn walks straight to its hold spot).
 */
export function liveGoal(model: RoundModel, id: PlayerId, o: Observe, tuning: Tuning): Goal {
  const intent = liveIntent(model, id, o, tuning);
  const me = pawnOf(o, id);
  const pts: Vec3[] = [me === undefined ? trackPosAt(model, id, o.tick) : me.pos];
  for (const s of model.track(id)) if (s.tick > o.tick && s.tick <= intent.anchorTick) pts.push({ x: s.x, y: s.y, z: s.z });
  const thin = thinRoute(pts, tuning.replay.routeThinUnits).slice(1);
  const last = thin[thin.length - 1];
  if (last !== undefined && last.x === intent.hold.x && last.y === intent.hold.y && last.z === intent.hold.z) thin.pop();
  return { route: thin, role: intent.role, hold: { x: intent.hold.x, y: intent.hold.y, z: intent.hold.z } };
}

// ---------------------------------------------------------------------------
// Divergence: the per-tick part
// ---------------------------------------------------------------------------

/** A puppet in body contact (`blockingPawn`) since `sinceTick`, when it was `behind` (2D) from its reference. */
export interface ContactState {
  readonly id: PlayerId;
  readonly sinceTick: number;
  /** Distance to its reference when the contact began (6 decimals). */
  readonly behind: number;
  /** First tick of the current run of contact ticks with 2D speed below `standSpeedThreshold`, or null. */
  readonly stalledSince: number | null;
}

/** Divergence's per-run state (plain data; ReplayCore snapshots it). */
export interface DivergenceState {
  /** One per `Divergence.encounters`, same order. */
  encounters: EncounterState[];
  /** Puppets in body contact now, in PLAYER_IDS order. */
  contacts: ContactState[];
}

function initialDivergenceState(encounters: readonly EncounterPlan[]): DivergenceState {
  return { encounters: encounters.map((e) => ({ key: e.key, phase: 'waiting', seenTick: null, shotTick: null, blocked: false, puppetSightTick: null, puppetSightOnCourse: false })), contacts: [] };
}

/**
 * Runs the triggers and the scheduled encounters each tick. ReplayCore calls `setup` on the setup step and `step` on
 * every other step, after the DEAD / HUMAN status and before B3's scheduled actions, and makes the returned pawns LIVE.
 */
export class Divergence {
  readonly index: ExpectedEncounters;
  readonly encounters: readonly EncounterPlan[];
  private readonly model: RoundModel;
  private readonly tuning: Tuning;
  private st: DivergenceState;

  constructor(model: RoundModel, schedule: EventSchedule, plan: ScriptPlan, tuning: Tuning) {
    this.model = model;
    this.tuning = tuning;
    this.index = new ExpectedEncounters(model, schedule, tuning);
    this.encounters = buildEncounters(model, schedule, plan, this.index, tuning);
    this.st = initialDivergenceState(this.encounters);
  }

  get state(): DivergenceState {
    return this.st;
  }

  reset(): void {
    this.st = initialDivergenceState(this.encounters);
  }

  restore(s: DivergenceState): void {
    this.st = {
      encounters: this.encounters.map((e) => {
        const q = s.encounters.find((x) => x.key === e.key);
        if (q === undefined) throw new Error(`Divergence.restore: no state for ${e.key}`);
        // Snapshots from before G4 have no puppet sight (and before G5 no on-course flag: the B4 delay then).
        return { key: q.key, phase: q.phase, seenTick: q.seenTick, shotTick: q.shotTick, blocked: q.blocked, puppetSightTick: q.puppetSightTick ?? null, puppetSightOnCourse: q.puppetSightOnCourse ?? false };
      }),
      contacts: s.contacts.map((c) => ({ id: c.id, sinceTick: c.sinceTick, behind: c.behind, stalledSince: c.stalledSince })),
    };
  }

  /**
   * Setup step: an encounter whose victim is the human replaces the recorded shot and aim (suppressed in B3), and its
   * shooter holds the angle on the recorded spot (chest height of a standing victim there) from the recorded aim's
   * start until the encounter ends (a B3 hold: Lokier watches the Apartments window).
   */
  setup(o: Observe, script: ScriptedEvents): void {
    for (const e of this.encounters) {
      if (e.victim !== o.human) continue;
      for (const k of e.fireKeys) script.suppress(k);
      for (const k of e.aimKeys) script.suppress(k);
      script.addHold({ key: `hold:${e.key}`, id: e.shooter, point: bandPoint(e.spot, false, e.band, this.tuning.damage), fromTick: e.holdFromTick, toTick: null });
    }
  }

  /**
   * One tick (not the setup step). `modes`: every pawn's Core mode at the start of this tick (DEAD and HUMAN already
   * updated). `refs`: each puppet's reference position at this tick (PLAYER_IDS order; null outside its track or
   * without puppets). Appends the encounters' actions and, for every pawn that goes LIVE, its `unblock_damage`s, the
   * `set_mode` with its goal and a log line to `out`, in id order. Returns the pawns that go LIVE, in id order.
   */
  step(o: Observe, modes: readonly PawnMode[], refs: readonly (Vec3 | null)[], script: ScriptedEvents, out: Action[]): TriggerHit[] {
    const hits: TriggerHit[] = [];
    const encs = this.encounters;
    const states = this.st.encounters;
    this.noteContacts(o, modes, refs);
    for (let i = 0; i < PLAYER_IDS.length; i++) {
      const id = PLAYER_IDS[i] as PlayerId;
      if (!isPuppet(o, modes, id)) continue;
      const contact = this.st.contacts.find((c) => c.id === id) ?? null;
      const hit =
        damageTrigger(o, modes, id) ??
        sightingTrigger(o, modes, id, this.model, this.index, encs, states, this.tuning) ??
        gunfireTrigger(o, modes, id, this.model, this.index, encs, states, this.tuning) ??
        outlivedTrigger(o, this.model, id, this.tuning) ??
        blockedTrigger(o, id, refs[i] ?? null, contact, this.tuning);
      if (hit !== null) hits.push(hit);
    }
    for (let i = 0; i < encs.length; i++) {
      const fail = this.encounterStep(encs[i] as EncounterPlan, states[i] as EncounterState, o, modes, hits, script, out);
      if (fail !== null) hits.push(fail);
    }
    hits.sort((a, b) => PLAYER_IDS.indexOf(a.id) - PLAYER_IDS.indexOf(b.id));
    const live: PlayerId[] = [];
    for (const h of hits) {
      this.liveActions(h, o, modes, live, out);
      live.push(h.id);
    }
    return hits;
  }

  /** Track body contacts: a puppet that touches a solid pawn on its reference's side starts one; losing contact ends it. */
  private noteContacts(o: Observe, modes: readonly PawnMode[], refs: readonly (Vec3 | null)[]): void {
    const next: ContactState[] = [];
    for (let i = 0; i < PLAYER_IDS.length; i++) {
      const id = PLAYER_IDS[i] as PlayerId;
      const ref = refs[i] ?? null;
      const me = pawnOf(o, id);
      if (ref === null || me === undefined || !isPuppet(o, modes, id) || blockingPawn(o, id, ref, this.tuning) === null) continue;
      const had = this.st.contacts.find((c) => c.id === id);
      const slow = Math.sqrt(me.vel.x * me.vel.x + me.vel.y * me.vel.y) < this.tuning.replay.standSpeedThreshold;
      const stalledSince = !slow ? null : had !== undefined && had.stalledSince !== null ? had.stalledSince : o.tick;
      next.push({ id, sinceTick: had !== undefined ? had.sinceTick : o.tick, behind: had !== undefined ? had.behind : roundNumber(dist2(me.pos, ref)), stalledSince });
    }
    this.st.contacts = next;
  }

  /**
   * One encounter, one tick. waiting: the shooter (a REPLAY puppet) sees the human within `humanSpotToleranceUnits` of
   * the recorded spot → seen; the hit is due `encounterDelaySec` later and the shooter aims at the recorded band from
   * now (a run-time engagement). seen, on the act tick of the shot: the gate (the shooter still REPLAY, the human in its
   * `sees` and at the spot); passed → fired: `block_damage` shooter → human (the scripted hit replaces the engine's
   * bullet), the tap (a run-time fire item) and the recorded `damage`; failed → the shooter goes LIVE (`encounter`).
   * The block is lifted once the shot is seen, or when the encounter ends. Ends (done) when the shooter or the human
   * dies or the shooter leaves REPLAY. Returns the shooter's LIVE switch when the gate fails.
   */
  private encounterStep(p: EncounterPlan, s: EncounterState, o: Observe, modes: readonly PawnMode[], hits: readonly TriggerHit[], script: ScriptedEvents, out: Action[]): TriggerHit | null {
    if (s.phase === 'done') return null;
    if (o.human === null) {
      this.notePuppetSight(p, s, o, modes);
      return null;
    }
    if (o.human !== p.victim) return null;
    const r = this.tuning.replay;
    const tick = o.tick;
    const sh = pawnOf(o, p.shooter);
    const vi = pawnOf(o, p.victim);
    const what = `encounter ${p.shooter} -> ${p.victim}`;
    const switching = hits.some((h) => h.id === p.shooter);
    if (
      s.phase === 'waiting' &&
      sh !== undefined &&
      vi !== undefined &&
      sh.alive &&
      vi.alive &&
      modeOf(modes, p.shooter) === 'REPLAY' &&
      sh.sees.includes(p.victim) &&
      dist2(vi.pos, p.spot) <= this.tuning.replay.humanSpotToleranceUnits &&
      !inEncounterWindow(p, tick, this.tuning)
    ) {
      // G7: too early or too late for the recorded hit to make sense: no time shift, a real fight (the encounter doesn't
      // own the sighting outside its window, so trigger 2 makes the shooter LIVE this tick unless the human is on script).
      s.phase = 'done';
      script.endHold(`hold:${p.key}`, tick);
      out.push({
        type: 'log',
        level: 'info',
        text: `${what}: cancelled at tick ${tick}, ${p.victim} in sight at the spot ${tenthsText(tick - p.recordedSightTick, true)} s against the recording, beyond the encounter window (${tenthsText(secTicks(this.tuning.replay.encounterWindowSec), false)} s): a real fight`,
      });
      return null;
    }
    const why =
      sh === undefined || !sh.alive ? `${p.shooter} is dead` : vi === undefined || !vi.alive ? `${p.victim} is dead` : switching || modeOf(modes, p.shooter) !== 'REPLAY' ? `${p.shooter} is LIVE` : null;
    if (why !== null || sh === undefined || vi === undefined) {
      // The LIVE switch lifts a standing block itself (liveActions).
      if (s.blocked && !switching) {
        out.push({ type: 'unblock_damage', attacker: p.shooter, victim: p.victim });
        s.blocked = false;
      }
      s.phase = 'done';
      script.endHold(`hold:${p.key}`, tick);
      out.push({ type: 'log', level: 'info', text: `${what}: over at tick ${tick}, ${why ?? ''}` });
      return null;
    }
    if (s.blocked && o.events.some((e) => e.type === 'shot' && e.shooter === p.shooter)) {
      out.push({ type: 'unblock_damage', attacker: p.shooter, victim: p.victim });
      s.blocked = false;
    }
    const tol = r.humanSpotToleranceUnits;
    const li = r.inputLatencyTicks;
    const la = r.actionLatencyTicks;
    if (s.phase === 'waiting') {
      if (!sh.sees.includes(p.victim) || dist2(vi.pos, p.spot) > tol) return null;
      const lead = li > la ? li : la;
      // G5: on course he is the recording, so the hit lands on the recorded tick (encounterShotTick).
      const shotTick = encounterShotTick(p, tick, humanOnCourse(this.model, o, this.tuning), lead, this.tuning);
      s.phase = 'seen';
      s.seenTick = tick;
      s.shotTick = shotTick;
      script.addEngagement({ key: `aim:${p.key}`, shooter: p.shooter, target: p.victim, band: p.band, fromTick: tick, toTick: shotTick - li });
      out.push({
        type: 'log',
        level: 'info',
        text: `${what}: ${p.victim} in sight at the spot at tick ${tick} (${tenthsText(tick - p.recordedSightTick, true)} s against the recording), scripted hit due at tick ${shotTick}${shotTick === p.damage.tick ? ' (on course: the recorded tick)' : ''}`,
      });
      return null;
    }
    const shotTick = s.shotTick as number;
    if (s.phase === 'seen') {
      const lead = li > la ? li : la;
      if (tick < shotTick - lead) return null;
      const inSight = sh.sees.includes(p.victim);
      const d = dist2(vi.pos, p.spot);
      if (!inSight || d > tol) {
        s.phase = 'done';
        script.endHold(`hold:${p.key}`, tick);
        return { id: p.shooter, trigger: 'encounter', reason: `${what} at tick ${tick}: ${!inSight ? `${p.victim} not in sight` : `${p.victim} ${intText(d)} u from the recorded spot`}` };
      }
      s.phase = 'fired';
      out.push({ type: 'block_damage', attacker: p.shooter, victim: p.victim });
      s.blocked = true;
      const press = shotTick - li;
      script.addFire({
        key: `fire:${p.key}`,
        kind: 'tap',
        shooter: p.shooter,
        target: p.victim,
        weapon: p.weapon,
        attack: [{ from: press, to: press }],
        shotTicks: [shotTick],
        recordedTicks: [p.damage.tick],
        fromTick: press,
        toTick: press,
      });
      out.push({ type: 'log', level: 'info', text: `${what}: scripted hit ${p.damage.amount} hp / ${p.damage.armor ?? 0} armor lands at tick ${shotTick} (recorded ${p.damage.tick})` });
    }
    if (s.phase === 'fired' && tick === shotTick - la) {
      const d = p.damage;
      out.push({ type: 'damage', attacker: p.shooter, victim: p.victim, amount: d.amount, armor: d.armor ?? 0, hitgroup: d.hitgroup, weapon: d.weapon, lethal: false });
    }
    return null;
  }

  /**
   * G4: nobody controls the victim yet (he is a puppet, `observe.human` null): note the first tick the shooter (REPLAY)
   * sees him within `humanSpotToleranceUnits` of the spot. State only: nothing is sent, so the run stays the
   * no-human one; a takeover before the hit starts from it (`takeover`).
   */
  private notePuppetSight(p: EncounterPlan, s: EncounterState, o: Observe, modes: readonly PawnMode[]): void {
    if (s.phase !== 'waiting' || s.puppetSightTick !== null) return;
    const sh = pawnOf(o, p.shooter);
    const vi = pawnOf(o, p.victim);
    if (sh === undefined || vi === undefined || !sh.alive || !vi.alive || modeOf(modes, p.shooter) !== 'REPLAY') return;
    if (sh.sees.includes(p.victim) && dist2(vi.pos, p.spot) <= this.tuning.replay.humanSpotToleranceUnits) {
      s.puppetSightTick = o.tick;
      s.puppetSightOnCourse = onCourse(this.model, o, p.victim, this.tuning);
    }
  }

  /**
   * G4: `o.human` took control of his pawn on this tick, mid-round (a puppet until now; nothing of an encounter of his
   * has been sent). Each of his encounters still waiting becomes active the way it would be had he played the puppet's
   * moves from the round start (docs/core.md "Takeover"):
   * - its shooter dead or not REPLAY: over;
   * - this tick is past the recorded hit's emission tick (B3 sent the hit to the puppet; it has landed): `fired` on
   *   the recorded ticks (no time shift), so the duel at the spot after the hit is the recording's (sightings there
   *   owned, the human's fire at the shooter recorded fire);
   * - otherwise as at the setup: the recorded shot and aim not decided yet are suppressed (an aim already running goes
   *   on to its end) and the shooter holds the angle on the spot from the recorded aim's start; then `seen` from the
   *   puppet sight if the shooter already saw him at the spot (the hit due `encounterDelaySec` after that sight, but at
   *   least one latency from now, with the run-time aim from now), else `waiting`.
   * Called before `step` on the takeover tick; appends one log line per encounter to `out`.
   */
  takeover(o: Observe, modes: readonly PawnMode[], script: ScriptedEvents, out: Action[]): void {
    const r = this.tuning.replay;
    const tick = o.tick;
    const li = r.inputLatencyTicks;
    const la = r.actionLatencyTicks;
    const lead = li > la ? li : la;
    for (let i = 0; i < this.encounters.length; i++) {
      const p = this.encounters[i] as EncounterPlan;
      const s = this.st.encounters[i] as EncounterState;
      if (p.victim !== o.human || s.phase !== 'waiting') continue;
      const what = `encounter ${p.shooter} -> ${p.victim}`;
      const sh = pawnOf(o, p.shooter);
      if (sh === undefined || !sh.alive || modeOf(modes, p.shooter) !== 'REPLAY') {
        s.phase = 'done';
        out.push({ type: 'log', level: 'info', text: `${what}: none after the takeover at tick ${tick}, ${p.shooter} is ${sh?.alive === true ? 'LIVE' : 'dead'}` });
        continue;
      }
      if (tick > p.damage.tick - la) {
        s.phase = 'fired';
        s.seenTick = p.recordedSightTick;
        s.shotTick = p.damage.tick;
        out.push({ type: 'log', level: 'info', text: `${what}: the recorded hit (${p.damage.amount} hp) landed on tick ${p.damage.tick}, before the takeover at tick ${tick}` });
        continue;
      }
      for (const k of p.fireKeys) script.suppress(k);
      for (const k of p.aimKeys) script.suppress(k);
      script.addHold({ key: `hold:${p.key}`, id: p.shooter, point: bandPoint(p.spot, false, p.band, this.tuning.damage), fromTick: p.holdFromTick, toTick: null });
      const sight = s.puppetSightTick;
      if (sight === null) {
        out.push({ type: 'log', level: 'info', text: `${what}: active from the takeover at tick ${tick}, waiting for ${p.shooter} to see ${p.victim} at the spot` });
        continue;
      }
      // G5: the puppet was on course at its sighting (it is the recording): the hit on its recorded tick.
      const due = encounterShotTick(p, sight, s.puppetSightOnCourse, lead, this.tuning);
      const shotTick = due > tick + lead ? due : tick + lead;
      s.phase = 'seen';
      s.seenTick = sight;
      s.shotTick = shotTick;
      script.addEngagement({ key: `aim:${p.key}`, shooter: p.shooter, target: p.victim, band: p.band, fromTick: tick, toTick: shotTick - li });
      out.push({
        type: 'log',
        level: 'info',
        text: `${what}: ${p.victim} in sight at the spot since tick ${sight} (${tenthsText(sight - p.recordedSightTick, true)} s against the recording), before the takeover at tick ${tick}; scripted hit due at tick ${shotTick}${shotTick === p.damage.tick ? ' (on course: the recorded tick)' : ''}`,
      });
    }
  }

  /**
   * The actions of one switch to LIVE: `unblock_damage` for every pair involving the pawn that is still blocked (its
   * self pair, then both directions with each enemy that is neither the human nor LIVE, nor gone LIVE earlier this
   * tick (`liveNow`); plus an encounter's standing block), the `set_mode` with its goal, and a log line.
   */
  private liveActions(h: TriggerHit, o: Observe, modes: readonly PawnMode[], liveNow: readonly PlayerId[], out: Action[]): void {
    const id = h.id;
    for (const y of PLAYER_IDS) {
      if (y === id) {
        out.push({ type: 'unblock_damage', attacker: id, victim: id });
        continue;
      }
      if (y === o.human || !enemies(this.model, id, y) || modeOf(modes, y) === 'LIVE' || liveNow.includes(y)) continue;
      out.push({ type: 'unblock_damage', attacker: id, victim: y });
      out.push({ type: 'unblock_damage', attacker: y, victim: id });
    }
    for (let i = 0; i < this.encounters.length; i++) {
      const p = this.encounters[i] as EncounterPlan;
      const s = this.st.encounters[i] as EncounterState;
      if (p.shooter === id && s.blocked) {
        out.push({ type: 'unblock_damage', attacker: p.shooter, victim: p.victim });
        s.blocked = false;
      }
    }
    const goal = liveGoal(this.model, id, o, this.tuning);
    out.push({ type: 'set_mode', id, mode: 'LIVE', goal });
    out.push({ type: 'log', level: 'info', text: `${id} LIVE: ${h.reason}; goal ${goal.role}, ${goal.route.length} waypoint${goal.route.length === 1 ? '' : 's'}` });
  }
}
