/**
 * F1: how a puppet's view moves in and around its fights (docs/fights.md). B3's scripted look (src/core/scripted.ts
 * `input`) decides *what* a puppet looks at during an engagement; this file adds where it looks just before and just
 * after one, and *how* the view gets there:
 *
 * - **Lead-in (pre-aim).** From `aimLeadSec` before the anticipated sight of an engagement's target, the shooter holds
 *   the angle the target will appear from: the target's recorded position, at head height, at the tape's first
 *   sighting of the pair (`sightings[]`, either way round) if that comes at most `aimLeadSec` before the engagement's
 *   aim window, else at the window's start. Once the target is in the shooter's `sees` he tracks it instead.
 * - **After.** For `aimAfterSec` after the engagement's last press the shooter keeps his view on the target (where he
 *   fell; frozen if the target is alive but out of sight), then eases back to the puppet's own look (`release`).
 * - **Motion.** Every look this layer produces moves by a critically damped ease (T. Lowe, "Critically Damped Ease-In/
 *   Ease-Out Smoothing", Game Programming Gems 4, 1.10; Unity's SmoothDamp) on yaw and pitch, at most
 *   `aimTurnRateDegPerTick` per tick: a flick onto a seen target with smooth time `aimFlickSec`, holds, pre-aims and the
 *   ease back with `aimHoldSec`. Before a shot the smooth time shrinks with the ticks left (≥ 1 tick, ≤ half of them),
 *   so the view arrives on the target on the ATTACK tick; a residual of at most `aimShotSnapDeg` is closed on that tick.
 * - **V2b slot.** A shooter with a fitted video view (`Track.view`, src/core/puppet.ts "follow fitted view") keeps it
 *   in the lead-in and after phases: the video is the truth outside the shot windows. Detected by `RoundModel.viewTrack`
 *   when the model has it.
 *
 * The motion state (velocity per pawn) is plain data in the scripted-events state (`ScriptState.aim`), snapshotted with
 * it. Yaw and pitch are rounded to 0.001° (aim.ts), velocities to 6 decimals (docs/port-notes.md "Puppets").
 */
import { roundNumber, type DamageTuning, type PawnObs, type PlayerId, type ReplayTuning, type Vec3 } from '../contracts/index';
import { TICK_RATE } from './clock';
import { bandPoint, pitchTo, roundPitch, type Look } from './aim';
import { bearing, dist2, roundYaw, yawDelta } from './puppet';
import type { RoundModel } from './round-model';

/** Closer than this (units, 2D) the bearing is meaningless: keep the yaw (as aim.ts). */
const MIN_LOOK_DIST = 1;
/**
 * Ease-in: the turn speed grows by at most `aimTurnRateDegPerTick / ACCEL_TICKS` per tick, so a large flick reaches its
 * peak over 3 ticks (47 ms) instead of starting at full speed. Slowing down is the ease's own (no limit: no overshoot).
 */
const ACCEL_TICKS = 3;
/** The ease back to the puppet's own look is over when yaw, pitch and both velocities are within this (degrees, °/tick). */
const SETTLED_DEG = 0.25;
/** A sighting of the pair counts for an engagement when it overlaps [window start − this, window end] (seconds). */
const SIGHTING_SLACK_SEC = 3;
/** V2b: a fitted view sample counts as "known" within this of `t` (seconds; its grid is 10 Hz). */
const VIEW_GAP_SEC = 0.1;

/** A pawn's view motion while this layer moves its look (`ScriptState.aim`). */
export interface AimMotion {
  readonly id: PlayerId;
  /** Velocities (degrees per tick) after the last step. */
  yawVel: number;
  pitchVel: number;
  /** Act tick of the last step: a gap (the pawn was LIVE, dead, or the setup) restarts from rest. */
  tick: number;
}

/** How fast to move toward a goal: `flick` onto a seen target, `hold` for pre-aims, holds and the ease back. */
export type AimPace = 'flick' | 'hold';

/** Where a look goes this tick: a point to look at (or a fixed look) and how fast; `shotIn` = ticks until the next ATTACK. */
export interface AimGoal {
  readonly point: Vec3 | null;
  readonly look?: Look;
  readonly pace: AimPace;
  readonly shotIn: number | null;
}

/** One engagement's lead-in, computed from the plan (only engagements with recorded spots have one). */
export interface AimLead {
  readonly key: string;
  readonly shooter: PlayerId;
  readonly target: PlayerId;
  /** First act tick of the lead-in, the anticipated sight tick and the engagement's window [fromTick, toTick]. */
  readonly fromTick: number;
  readonly sightTick: number;
  readonly windowFrom: number;
  readonly windowTo: number;
  /** Where the target will appear: its recorded feet at `sightTick`, at head height. */
  readonly point: Vec3;
}

/** The part of an engagement the lead-in needs (src/core/scripted.ts `Engagement`). */
export interface LeadEngagement {
  readonly key: string;
  readonly shooter: PlayerId;
  readonly target: PlayerId;
  readonly fromTick: number;
  readonly toTick: number;
  readonly spots?: readonly unknown[];
}

function secTicks(sec: number): number {
  return Math.round(sec * TICK_RATE);
}

/** The recorded position of `id` at `tick`, clamped to the track's ends. */
function recordedFeet(model: RoundModel, id: PlayerId, tick: number): Vec3 | null {
  const at = model.trackAtTick(id, tick);
  if (at !== null) return at.pos;
  const track = model.track(id);
  const first = track[0];
  const last = track[track.length - 1];
  if (first === undefined || last === undefined) return null;
  const s = tick / TICK_RATE <= first.t ? first : last;
  return { x: s.x, y: s.y, z: s.z };
}

/**
 * The lead-ins of the plan's engagements (those with recorded spots: run-time engagements have no recorded approach).
 * Anticipated sight: the earliest tape sighting of the pair overlapping [fromTick − 3 s, toTick], clamped to
 * [fromTick − lead, fromTick]; the window start without one. The lead-in starts `aimLeadSec` before it.
 */
export function buildLeads(model: RoundModel, engagements: readonly LeadEngagement[], r: Pick<ReplayTuning, 'aimLeadSec'>, d: DamageTuning): AimLead[] {
  const lead = secTicks(r.aimLeadSec);
  const slack = secTicks(SIGHTING_SLACK_SEC);
  const out: AimLead[] = [];
  for (const e of engagements) {
    if (e.spots === undefined) continue;
    let sight = e.fromTick;
    for (const s of model.sightings) {
      const pair = (s.who === e.target && s.by.includes(e.shooter)) || (s.who === e.shooter && s.by.includes(e.target));
      if (pair && s.tick1 >= e.fromTick - slack && s.tick0 <= e.toTick) sight = Math.min(sight, s.tick0);
    }
    sight = Math.max(sight, e.fromTick - lead);
    const feet = recordedFeet(model, e.target, sight);
    if (feet === null) continue;
    out.push({ key: e.key, shooter: e.shooter, target: e.target, fromTick: sight - lead, sightTick: sight, windowFrom: e.fromTick, windowTo: e.toTick, point: bandPoint(feet, false, 'head', d) });
  }
  return out;
}

/** V2b: true when `id` has a fitted video view at `t` (`RoundModel.viewTrack`, when the model has one). */
export function fittedViewAt(model: RoundModel, id: PlayerId, t: number): boolean {
  const vt = (model as unknown as { viewTrack?: (id: PlayerId) => readonly { readonly t: number; readonly source?: string }[] }).viewTrack;
  if (typeof vt !== 'function') return false;
  const v = vt.call(model, id);
  for (const s of v) if (Math.abs(s.t - t) <= VIEW_GAP_SEC + 1e-9 && (s.source === undefined || s.source === 'video')) return true;
  return false;
}

/** The look from the eye of `p` at `point` (yaw kept closer than 1 unit). */
export function lookAtPoint(prevYaw: number, pos: Vec3, crouching: boolean, point: Vec3, d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>): Look {
  return { yaw: dist2(pos, point) < MIN_LOOK_DIST ? roundYaw(prevYaw) : bearing(pos, point), pitch: pitchTo(pos, crouching, point, d) };
}

/**
 * One critically damped step on one axis (Lowe's SmoothDamp, dt = 1 tick): from 0 toward `err` with velocity `vel`
 * (degrees per tick) and smooth time `smoothTicks`; no overshoot; the step is at most `maxStep`, and at most
 * `maxStep / ACCEL_TICKS` more than the last one's speed (ease-in). Returns the step and the new velocity.
 */
export function easeStep(err: number, vel: number, smoothTicks: number, maxStep: number): { step: number; vel: number } {
  const omega = 2 / smoothTicks;
  const x = omega;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = -err;
  const temp = vel + omega * change;
  let v = (vel - omega * temp) * exp;
  let out = err + (change + temp) * exp;
  if (err !== 0 && err > 0 === out > err) {
    out = err;
    v = 0;
  }
  // Ease-in: speeding up (in the direction of the last motion, or from rest) by at most maxStep / ACCEL_TICKS a tick.
  const prevSpeed = out * vel > 0 ? Math.abs(vel) : 0;
  const cap = Math.min(maxStep, prevSpeed + maxStep / ACCEL_TICKS);
  if (Math.abs(out) > cap) {
    out = out > 0 ? cap : -cap;
    v = out;
  }
  return { step: out, vel: v };
}

/**
 * The fight aim's per-run side. `move` steps a pawn's look toward a goal; `release` eases it back to the puppet's own
 * look after the layer let go; `leadOrAfter` is the lead-in / after goal of a shooter outside his aim windows.
 */
export class FightAim {
  readonly leads: readonly AimLead[];
  private readonly leadsByShooter: ReadonlyMap<PlayerId, readonly AimLead[]>;
  private readonly model: RoundModel;
  private readonly r: ReplayTuning;
  private readonly d: DamageTuning;

  constructor(model: RoundModel, engagements: readonly LeadEngagement[], r: ReplayTuning, d: DamageTuning) {
    this.model = model;
    this.r = r;
    this.d = d;
    this.leads = buildLeads(model, engagements, r, d);
    const by = new Map<PlayerId, AimLead[]>();
    for (const l of this.leads) by.set(l.shooter, [...(by.get(l.shooter) ?? []), l]);
    this.leadsByShooter = by;
  }

  /**
   * The lead-in or after goal for `p` at act tick `tick`, outside his aim windows, or null. `ok(key)` is false for an
   * engagement that was dropped (or whose shooter went LIVE since). After phases come first (the view stays on the
   * fallen target), then the nearest lead-in. A shooter with a fitted video view keeps it (null).
   */
  leadOrAfter(p: PawnObs, o: { readonly pawns: readonly PawnObs[] }, tick: number, ok: (key: string, from: number, target: PlayerId) => boolean): AimGoal | null {
    const leads = this.leadsByShooter.get(p.id);
    if (leads === undefined) return null;
    if (fittedViewAt(this.model, p.id, tick / TICK_RATE)) return null;
    const after = secTicks(this.r.aimAfterSec);
    for (const l of leads) {
      if (tick <= l.windowTo || tick > l.windowTo + after || !ok(l.key, l.windowFrom, l.target)) continue;
      const t = o.pawns.find((q) => q.id === l.target);
      if (t === undefined) continue;
      if (t.alive && !p.sees.includes(t.id)) return { point: null, look: { yaw: p.yaw, pitch: p.pitch }, pace: 'hold', shotIn: null };
      return { point: bandPoint(t.pos, t.alive && t.crouching, 'head', this.d), pace: 'hold', shotIn: null };
    }
    let best: AimLead | null = null;
    for (const l of leads) {
      if (tick < l.fromTick || tick >= l.windowFrom || !ok(l.key, l.windowFrom, l.target)) continue;
      if (best === null || l.windowFrom < best.windowFrom) best = l;
    }
    if (best === null) return null;
    const t = o.pawns.find((q) => q.id === best.target);
    if (t === undefined || !t.alive) return null;
    if (p.sees.includes(t.id)) return { point: bandPoint(t.pos, t.crouching, 'head', this.d), pace: 'hold', shotIn: null };
    return { point: best.point, pace: 'hold', shotIn: null };
  }

  /** Step `p`'s look from `prev` toward `goal` (eased, rate-limited, on target at a due shot); updates `motions`. */
  move(motions: AimMotion[], p: PawnObs, crouching: boolean, prev: Look, goal: AimGoal, tick: number): Look {
    const want = goal.look ?? (goal.point === null ? prev : lookAtPoint(prev.yaw, p.pos, crouching, goal.point, this.d));
    return this.stepToward(motions, p.id, prev, want, goal.pace, goal.shotIn, tick);
  }

  /**
   * After the layer let go of `id` (no goal this tick): ease from `prev` back to the puppet's own look `base`; null
   * once settled (then the base look applies unchanged and the motion is forgotten).
   */
  release(motions: AimMotion[], id: PlayerId, prev: Look, base: Look, tick: number): Look | null {
    const i = motions.findIndex((m) => m.id === id);
    if (i < 0) return null;
    const m = motions[i] as AimMotion;
    const fresh = m.tick !== tick - 1;
    const ey = yawDelta(prev.yaw, base.yaw);
    const ep = base.pitch - prev.pitch;
    if (fresh || (Math.abs(ey) <= SETTLED_DEG && Math.abs(ep) <= SETTLED_DEG && Math.abs(m.yawVel) <= SETTLED_DEG && Math.abs(m.pitchVel) <= SETTLED_DEG)) {
      motions.splice(i, 1);
      return null;
    }
    return this.stepToward(motions, id, prev, base, 'hold', null, tick);
  }

  private stepToward(motions: AimMotion[], id: PlayerId, prev: Look, want: Look, pace: AimPace, shotIn: number | null, tick: number): Look {
    let m = motions.find((x) => x.id === id);
    if (m === undefined) {
      m = { id, yawVel: 0, pitchVel: 0, tick };
      motions.push(m);
    } else if (m.tick !== tick - 1) {
      m.yawVel = 0;
      m.pitchVel = 0;
    }
    const r = this.r;
    let smooth = (pace === 'flick' ? r.aimFlickSec : r.aimHoldSec) * TICK_RATE;
    if (shotIn !== null && shotIn >= 0) smooth = Math.min(smooth, Math.max(1, shotIn / 2));
    const max = r.aimTurnRateDegPerTick;
    const ey = yawDelta(prev.yaw, want.yaw);
    const ep = want.pitch - prev.pitch;
    let y: { step: number; vel: number };
    let q: { step: number; vel: number };
    if (shotIn === 0 && Math.abs(ey) <= r.aimShotSnapDeg && Math.abs(ep) <= r.aimShotSnapDeg) {
      // On the ATTACK tick: close the last fraction of a degree (the view is on the target when the shot fires).
      y = { step: ey, vel: m.yawVel };
      q = { step: ep, vel: m.pitchVel };
    } else {
      y = easeStep(ey, m.yawVel, smooth, max);
      q = easeStep(ep, m.pitchVel, smooth, max);
    }
    m.yawVel = roundNumber(y.vel);
    m.pitchVel = roundNumber(q.vel);
    m.tick = tick;
    return { yaw: roundYaw(prev.yaw + y.step), pitch: roundPitch(prev.pitch + q.step) };
  }
}

/** A copy of motion states (snapshot restore); snapshots from before F1 have none. */
export function copyMotions(ms: readonly AimMotion[] | undefined): AimMotion[] {
  return (ms ?? []).map((m) => ({ id: m.id, yawVel: m.yawVel, pitchVel: m.pitchVel, tick: m.tick }));
}
