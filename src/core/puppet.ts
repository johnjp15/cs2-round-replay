/**
 * Puppets: REPLAY pawns that follow their recorded 10 Hz tracks using only per-tick
 * inputs (forward / side / yaw / pitch / buttons), the way CS2 bots will be driven
 * through usercmd injection. Never sets positions, except for an unseen snap at a
 * teleport point. See docs/core.md "Puppets".
 *
 * - `PuppetTrack`: the recorded track preprocessed into a followable reference.
 *   Spikes (a short excursion that comes back) are repaired by interpolation;
 *   discontinuities (a jump that does not come back) become teleport points.
 * - `PuppetController`: per-pawn state and the per-tick input.
 *
 * Portable style (docs/port-notes.md "Puppets"): plain data, integer ticks, no clocks
 * or randomness; trig results are rounded before they are logged.
 */
import {
  roundNumber,
  type Action,
  type Button,
  type MovementTuning,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PlayerId,
  type ReplayTuning,
  type TrackSample,
  type Tuning,
  type Vec3,
  type WalkQuery,
  type WeaponId,
  type ViewSample,
  type YawSample,
} from '../contracts/index';
import { TICK_RATE, tOf } from './clock';
import type { RoundModel } from './round-model';
import type { EventSchedule } from './schedule';

/** Computed yaws are rounded to 1 / YAW_SCALE degrees, so atan2 ulp differences never reach the log. */
const YAW_SCALE = 1000;
/**
 * Recorded yaw is "known" between two yaw samples at most this far apart (seconds).
 * The POV yaw is sampled at 20 Hz, so this allows one missing sample. A data property,
 * not a calibration value.
 */
export const RECORDED_YAW_MAX_GAP_SEC = 0.1;
/**
 * V2: a fitted view (yaw and pitch from the video, `Track.view`) is "known" between two view samples at most this far
 * apart. The fit is on the 10 Hz grid (60 fps around key moments), so this allows no missing sample; the fit's
 * failures are `source: 'radar'` samples, which fall back to the radar yaw. A data property, not a calibration value.
 */
export const RECORDED_VIEW_MAX_GAP_SEC = 0.1;
/** Source clamps view pitch to ±89° (game rule; the same as aim.ts MAX_PITCH_DEG). */
const PITCH_LIMIT_DEG = 89;
/** Tolerance for comparing sample times that are decimal fractions (0.1 s grid). */
const T_EPS = 1e-9;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Yaw in (-180, 180]. */
export function normYaw(deg: number): number {
  const r = (((deg % 360) + 540) % 360) - 180;
  return r <= -180 ? r + 360 : r;
}

/** Shortest signed turn from `from` to `to`, in (-180, 180]. */
export function yawDelta(from: number, to: number): number {
  return normYaw(to - from);
}

/**
 * Normalise a yaw to (-180, 180] and round it to 0.001° (in that order, so the result is
 * the double nearest k / 1000 and survives the log's 6-decimal round trip exactly).
 */
export function roundYaw(deg: number): number {
  const r = Math.round(normYaw(deg) * YAW_SCALE) / YAW_SCALE;
  return r <= -180 ? r + 360 : r;
}

/** Turn from `from` toward `to` by at most `maxStep` degrees; rounded to 0.001°. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = yawDelta(from, to);
  const step = d > maxStep ? maxStep : d < -maxStep ? -maxStep : d;
  return roundYaw(from + step);
}

/** Bearing from a to b (2D), degrees CCW from +x, rounded to 0.001°. */
export function bearing(a: Vec3, b: Vec3): number {
  return roundYaw((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
}

/** 2D distance. */
export function dist2(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface Stick {
  readonly forward: number;
  readonly side: number;
}

/**
 * Stick input that moves along world direction (dx, dy) at `scale` (0..1) of the wish
 * speed, for a pawn looking along `yaw`. forward = (cos yaw, sin yaw); +side = strafe
 * right = yaw − 90° = (sin yaw, −cos yaw). Rounded to 6 decimals (the log's precision).
 */
export function stickToward(dx: number, dy: number, yaw: number, scale: number): Stick {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0 || scale <= 0) return { forward: 0, side: 0 };
  const ux = dx / len;
  const uy = dy / len;
  const c = Math.cos(yaw * DEG);
  const s = Math.sin(yaw * DEG);
  return { forward: roundNumber((ux * c + uy * s) * scale), side: roundNumber((ux * s - uy * c) * scale) };
}

/**
 * The same move as `input` with another look direction: (forward, side) re-expressed in
 * the frame of `yaw`, so the pawn keeps moving in the same world direction. Forward/side
 * are relative to the input's yaw, so B3 must aim through this (or recompute the stick),
 * never by replacing `yaw` alone. Stick rounded to 6 decimals.
 */
export function withLook(input: PawnInput, yaw: number, pitch: number): PawnInput {
  const a = input.yaw * DEG;
  const wx = input.forward * Math.cos(a) + input.side * Math.sin(a);
  const wy = input.forward * Math.sin(a) - input.side * Math.cos(a);
  const c = Math.cos(yaw * DEG);
  const sn = Math.sin(yaw * DEG);
  return { ...input, yaw, pitch, forward: roundNumber(wx * c + wy * sn), side: roundNumber(wx * sn - wy * c) };
}

/**
 * The WALK / DUCK the recorded speed (units/s, over the lookahead) asks for, given the
 * distance behind the track: nothing while more than `driftNudgeUnits` behind or while
 * standing (below `standSpeedThreshold`); DUCK below `crouchSpeedThreshold`; WALK below
 * `walkSpeedThreshold`. Never both: crouch-moving is already silent in CS2, and
 * WALK + DUCK stack to a cap (≈ 38 u/s with an AK) below the crouch threshold.
 * PuppetTrack turns this into a per-tick button plan (`plannedButton`).
 */
export function movementButtons(recordedSpeed: number, behind: number, r: ReplayTuning): Button[] {
  if (behind > r.driftNudgeUnits || recordedSpeed < r.standSpeedThreshold) return [];
  if (recordedSpeed < r.crouchSpeedThreshold) return ['DUCK'];
  if (recordedSpeed < r.walkSpeedThreshold) return ['WALK'];
  return [];
}

/**
 * Run speed of the held item, as the movement model uses it (docs/movement.md):
 * `runSpeedByWeapon[weapon]`, else the knife's entry.
 */
export function runSpeedOf(weapon: string, m: MovementTuning): number {
  const own = m.runSpeedByWeapon[weapon];
  if (own !== undefined) return own;
  const knife = m.runSpeedByWeapon['knife'];
  if (knife === undefined) throw new Error(`movement.runSpeedByWeapon: no entry for ${weapon} and no knife fallback`);
  return knife;
}

/** Speed cap for the held item and buttons: run × (WALK ? walkFactor : 1) × (DUCK ? crouchFactor : 1). */
export function maxSpeedOf(weapon: string, buttons: readonly Button[], m: MovementTuning): number {
  let v = runSpeedOf(weapon, m);
  if (buttons.includes('WALK')) v *= m.walkFactor;
  if (buttons.includes('DUCK')) v *= m.crouchFactor;
  return v;
}

/** True when the human's pawn reports `id` in its `sees`. No human = nobody sees. A human pawn missing from the observe counts as seeing (no snap). */
export function seenByHuman(o: Observe, id: PlayerId): boolean {
  if (o.human === null) return false;
  const h = o.pawns.find((p) => p.id === o.human);
  return h === undefined || h.sees.includes(id);
}

// ---------------------------------------------------------------------------
// Recorded weapon (for the spike speed limit)
// ---------------------------------------------------------------------------

export interface WeaponChange {
  readonly tick: number;
  readonly weapon: WeaponId;
}

/**
 * The weapon the recording shows in hand, as change points from tick 0: the drawn
 * weapon (primary, else secondary, else knife), then every scheduled `weapon_switch`.
 */
export function recordedWeapons(model: RoundModel, schedule: EventSchedule, id: PlayerId): WeaponChange[] {
  const kit = model.player(id).kit;
  const out: WeaponChange[] = [{ tick: 0, weapon: kit.primary ?? kit.secondary ?? 'knife' }];
  for (const e of schedule.ofType('weapon_switch')) if (e.id === id) out.push({ tick: e.tick, weapon: e.weapon });
  return out;
}

/** Weapon at `tick` from change points (the last change at or before it). */
export function weaponAt(changes: readonly WeaponChange[], tick: number): WeaponId {
  let w: WeaponId = (changes[0] as WeaponChange).weapon;
  for (const c of changes) if (c.tick <= tick) w = c.weapon;
  return w;
}

// ---------------------------------------------------------------------------
// PuppetTrack
// ---------------------------------------------------------------------------

export type TrackEventKind = 'spike' | 'discontinuity';

/** One over-speed stretch of a raw track (sample indices into `PuppetTrack.raw`). */
export interface TrackEvent {
  readonly kind: TrackEventKind;
  /** Last sample before the event. */
  readonly i0: number;
  /** Spike: the sample the track comes back at. Discontinuity: the last sample of the jump. */
  readonly i1: number;
  readonly t0: number;
  readonly t1: number;
  readonly tick0: number;
  readonly tick1: number;
  /** Samples replaced by interpolation (spikes), 0 for discontinuities. */
  readonly replaced: number;
  /** 2D distance and height change from sample i0 to sample i1 (raw). */
  readonly dist: number;
  readonly dz: number;
  /** Fastest raw step inside the event (units/s) and the limit it broke (factor × run speed). */
  readonly maxSpeed: number;
  readonly limit: number;
}

/** A window in which an unseen puppet that has drifted too far may snap back to its track. */
export interface TeleportPoint {
  /** Index into `PuppetTrack.events`. */
  readonly event: number;
  readonly kind: TrackEventKind;
  /** First and last tick (inclusive) at which a snap is allowed. */
  readonly openTick: number;
  readonly closeTick: number;
}

export interface PuppetTrackSummary {
  readonly id: PlayerId;
  readonly samples: number;
  readonly spikes: readonly TrackEvent[];
  readonly discontinuities: readonly TrackEvent[];
  readonly teleportPoints: readonly TeleportPoint[];
}

/**
 * A recorded track preprocessed into a physically followable reference.
 *
 * A step between consecutive samples is **over-speed** when its 2D speed exceeds
 * `spikeSpeedFactor` × the run speed of the weapon the recording shows (the larger
 * of the two samples'). Scanning in time order, at each over-speed step into sample i:
 *
 * - **Spike**: if, for some j ≥ i with t[j+1] − t[i−1] ≤ `spikeMaxSec`, the step out of
 *   j is over-speed too and the bridge from i−1 to j+1 is not, then samples i..j are an
 *   excursion: they are replaced by linear interpolation between i−1 and j+1 (the
 *   smallest such j). For one sample this is "implied speed from both neighbours too
 *   high, and the neighbours agree".
 * - **Discontinuity**: otherwise the run of consecutive over-speed steps from i is a jump
 *   that does not come back; it stays in the reference and becomes a teleport point.
 *
 * Every event opens a teleport window: from the start of its last over-speed step
 * (spikes: from the sample before) to `teleportWindowSec` after its end. `raw` keeps the
 * recording untouched (the golden master compares against it).
 */
export class PuppetTrack {
  readonly id: PlayerId;
  readonly raw: readonly TrackSample[];
  /** Reference positions, parallel to `raw` (raw except inside repaired spikes). */
  readonly ref: readonly Vec3[];
  /** Spikes and discontinuities, in time order. */
  readonly events: readonly TrackEvent[];
  /** One per event, same order. */
  readonly teleportPoints: readonly TeleportPoint[];
  /** Recorded yaw samples (may be empty). */
  readonly yaw: readonly YawSample[];
  /** V2: fitted first-person views (may be empty). */
  readonly view: readonly ViewSample[];
  /** V2: per raw sample, true when the recorded weapon there is a scoped rifle (AWP, SSG 08). */
  readonly scopedWeapon: readonly boolean[];
  /** Tick of the first and last sample. */
  readonly startTick: number;
  readonly endTick: number;
  /**
   * WALK / DUCK plan, one entry per tick from `startTick` to `endTick`: `movementButtons`
   * of the recorded speed (|ref(t + lookahead) − ref(t)| / lookahead), with every WALK or
   * DUCK stretch shorter than `buttonMinSec` dropped, so tracking noise and starts / stops
   * don't make the pawn flicker into a crouch. Buttons only cap speed, so dropping a short
   * stretch never costs tracking.
   */
  private readonly plan: readonly (Button | null)[];
  /** G3: the samples a jump takes off from (`TrackSample.jump`, set by the snapped 3D tracks), raw indices in order. */
  readonly takeoffs: readonly number[];

  /**
   * @param runSpeeds run speed (units/s) of the recorded weapon at each sample, parallel to `raw`.
   */
  constructor(
    id: PlayerId,
    raw: readonly TrackSample[],
    runSpeeds: readonly number[],
    yaw: readonly YawSample[],
    tuning: ReplayTuning,
    view: readonly ViewSample[] = [],
    scopedWeapon: readonly boolean[] = [],
  ) {
    if (raw.length === 0) throw new Error(`PuppetTrack ${id}: empty track`);
    if (runSpeeds.length !== raw.length) throw new Error(`PuppetTrack ${id}: ${runSpeeds.length} run speeds for ${raw.length} samples`);
    for (let i = 1; i < raw.length; i++) {
      if (!((raw[i] as TrackSample).t > (raw[i - 1] as TrackSample).t)) throw new Error(`PuppetTrack ${id}: sample times must increase (index ${i})`);
    }
    this.id = id;
    this.raw = raw;
    this.yaw = yaw;
    this.view = view;
    this.scopedWeapon = scopedWeapon;
    this.startTick = (raw[0] as TrackSample).tick;
    this.endTick = (raw[raw.length - 1] as TrackSample).tick;

    const pts: Vec3[] = raw.map((s) => ({ x: s.x, y: s.y, z: s.z }));
    const events: TrackEvent[] = [];
    const n = raw.length;
    const spikeMaxTicks = Math.round(tuning.spikeMaxSec * TICK_RATE);
    const limit = (a: number, b: number): number => tuning.spikeSpeedFactor * Math.max(runSpeeds[a] as number, runSpeeds[b] as number);
    const speed = (a: number, b: number): number => dist2(pts[a] as Vec3, pts[b] as Vec3) / ((raw[b] as TrackSample).t - (raw[a] as TrackSample).t);
    const over = (k: number): boolean => speed(k - 1, k) > limit(k - 1, k);

    let i = 1;
    while (i < n) {
      if (!over(i)) {
        i++;
        continue;
      }
      let back = -1;
      for (let j = i; j + 1 < n && (raw[j + 1] as TrackSample).tick - (raw[i - 1] as TrackSample).tick <= spikeMaxTicks; j++) {
        if (over(j + 1) && !(speed(i - 1, j + 1) > limit(i - 1, j + 1))) {
          back = j;
          break;
        }
      }
      if (back >= 0) {
        const a = i - 1;
        const b = back + 1;
        const ev = this.makeEvent('spike', a, b, back - i + 1, limit);
        const pa = pts[a] as Vec3;
        const pb = pts[b] as Vec3;
        const ta = (raw[a] as TrackSample).t;
        const tb = (raw[b] as TrackSample).t;
        for (let k = i; k <= back; k++) {
          const f = ((raw[k] as TrackSample).t - ta) / (tb - ta);
          pts[k] = { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f, z: pa.z + (pb.z - pa.z) * f };
        }
        events.push(ev);
        i = b + 1;
      } else {
        let k = i;
        while (k + 1 < n && over(k + 1)) k++;
        events.push(this.makeEvent('discontinuity', i - 1, k, 0, limit));
        i = k + 1;
      }
    }
    this.ref = pts;
    this.events = events;

    const windowTicks = Math.round(tuning.teleportWindowSec * TICK_RATE);
    this.teleportPoints = events.map((e, idx) => ({
      event: idx,
      kind: e.kind,
      // Discontinuity: from the start of its last over-speed step (one snap after the
      // jump instead of one per stretch of a long one). Spike: from the sample before.
      openTick: e.kind === 'spike' ? e.tick0 : (raw[e.i1 - 1] as TrackSample).tick,
      closeTick: e.tick1 + windowTicks,
    }));
    this.plan = buttonPlan(this, tuning);
    const takeoffs: number[] = [];
    raw.forEach((q, i) => {
      if (q.jump !== undefined && i + 1 < raw.length) takeoffs.push(i);
    });
    this.takeoffs = takeoffs;
  }

  /**
   * G3: the take-off (raw index) whose jump window holds `tick` (from `windowTicks` before its tick to `windowTicks`
   * after the landing sample's) and that isn't in `used`; −1 if none.
   */
  takeoffAt(tick: number, windowTicks: number, used: readonly number[]): number {
    for (const i of this.takeoffs) {
      if (used.includes(i)) continue;
      const a = (this.raw[i] as TrackSample).tick;
      const b = (this.raw[i + 1] as TrackSample).tick;
      if (tick >= a - windowTicks && tick <= b + windowTicks) return i;
    }
    return -1;
  }

  /** Build from the round model: the player's 10 Hz samples, recorded weapons and recorded yaw. */
  static fromModel(model: RoundModel, schedule: EventSchedule, tuning: Tuning, id: PlayerId): PuppetTrack {
    const samples = model.track(id);
    const weapons = recordedWeapons(model, schedule, id);
    const speeds = samples.map((s) => runSpeedOf(weaponAt(weapons, s.tick), tuning.movement));
    const scoped = samples.map((s) => isScopedRifle(weaponAt(weapons, s.tick)));
    return new PuppetTrack(id, samples, speeds, model.yawTrack(id), tuning.replay, model.viewTrack(id), scoped);
  }

  /** Reference position at video time `t`, linear between samples, clamped to the first / last sample. */
  positionAt(t: number): Vec3 {
    return interpolate(this.raw, this.ref, t);
  }

  /** Reference position at a tick (t = tick / 64). */
  targetAt(tick: number): Vec3 {
    return this.positionAt(tOf(tick));
  }

  /** The recording itself at `t` (no repairs), clamped to the ends. */
  rawAt(t: number): Vec3 {
    return interpolate(this.raw, null, t);
  }

  /**
   * Recorded yaw at `t` (shortest-arc interpolation, rounded to 0.001°), or null when
   * no two yaw samples at most RECORDED_YAW_MAX_GAP_SEC apart bracket `t`.
   */
  recordedYawAt(t: number): number | null {
    const y = this.yaw;
    if (y.length === 0) return null;
    const first = y[0] as YawSample;
    const last = y[y.length - 1] as YawSample;
    if (t < first.t - T_EPS || t > last.t + T_EPS) return null;
    let lo = 0;
    let hi = y.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((y[mid] as YawSample).t <= t) lo = mid;
      else hi = mid - 1;
    }
    const a = y[lo] as YawSample;
    if (Math.abs(a.t - t) <= T_EPS) return roundYaw(a.deg);
    const b = y[lo + 1];
    if (b === undefined || b.t - a.t > RECORDED_YAW_MAX_GAP_SEC + T_EPS) return null;
    const f = (t - a.t) / (b.t - a.t);
    return roundYaw(a.deg + yawDelta(a.deg, b.deg) * f);
  }

  /**
   * V2: the recorded view at `t`: the fitted video view (`Track.view`, shortest-arc yaw and linear pitch between two
   * `source: 'video'` samples at most RECORDED_VIEW_MAX_GAP_SEC apart), else the radar yaw (`recordedYawAt`) with
   * `pitch: null`, else null (not watched at t).
   */
  recordedViewAt(t: number): { readonly yaw: number; readonly pitch: number | null } | null {
    const v = this.view;
    if (v.length > 0 && t >= (v[0] as ViewSample).t - T_EPS && t <= (v[v.length - 1] as ViewSample).t + T_EPS) {
      let lo = 0;
      let hi = v.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if ((v[mid] as ViewSample).t <= t + T_EPS) lo = mid;
        else hi = mid - 1;
      }
      const a = v[lo] as ViewSample;
      if (Math.abs(a.t - t) <= T_EPS) {
        if (a.source === 'video' && a.pitch !== null) return { yaw: roundYaw(a.yaw), pitch: roundPitchDeg(a.pitch) };
      } else {
        const b = v[lo + 1];
        if (b !== undefined && b.t - a.t <= RECORDED_VIEW_MAX_GAP_SEC + T_EPS && a.source === 'video' && b.source === 'video' && a.pitch !== null && b.pitch !== null) {
          const f = (t - a.t) / (b.t - a.t);
          return { yaw: roundYaw(a.yaw + yawDelta(a.yaw, b.yaw) * f), pitch: roundPitchDeg(a.pitch + (b.pitch - a.pitch) * f) };
        }
      }
    }
    const y = this.recordedYawAt(t);
    return y === null ? null : { yaw: y, pitch: null };
  }

  /** V2: true when the recorded weapon at `t` (the sample at or before it) is a scoped rifle. */
  scopedAt(t: number): boolean {
    if (this.scopedWeapon.length === 0) return false;
    const i = Math.max(0, Math.min(this.raw.length - 1, sampleIndexAtOrBefore(this.raw, t)));
    return this.scopedWeapon[i] === true;
  }

  /** The planned WALK / DUCK at `tick`, or null (none, or outside the track). */
  plannedButton(tick: number): Button | null {
    return this.plan[tick - this.startTick] ?? null;
  }

  /** True when `tick` is inside some teleport window. */
  isTeleportPoint(tick: number): boolean {
    return this.teleportPointAt(tick, []) >= 0;
  }

  /** Index of the first teleport point open at `tick` that is not in `used`, or -1. */
  teleportPointAt(tick: number, used: readonly number[]): number {
    for (let k = 0; k < this.teleportPoints.length; k++) {
      const p = this.teleportPoints[k] as TeleportPoint;
      if (tick >= p.openTick && tick <= p.closeTick && !used.includes(k)) return k;
    }
    return -1;
  }

  summary(): PuppetTrackSummary {
    return {
      id: this.id,
      samples: this.raw.length,
      spikes: this.events.filter((e) => e.kind === 'spike'),
      discontinuities: this.events.filter((e) => e.kind === 'discontinuity'),
      teleportPoints: this.teleportPoints,
    };
  }

  private makeEvent(kind: TrackEventKind, i0: number, i1: number, replaced: number, limit: (a: number, b: number) => number): TrackEvent {
    const a = this.raw[i0] as TrackSample;
    const b = this.raw[i1] as TrackSample;
    let maxSpeed = 0;
    let lim = 0;
    for (let k = i0 + 1; k <= i1; k++) {
      const p = this.raw[k - 1] as TrackSample;
      const q = this.raw[k] as TrackSample;
      const v = dist2(p, q) / (q.t - p.t);
      if (v > maxSpeed) {
        maxSpeed = v;
        lim = limit(k - 1, k);
      }
    }
    return {
      kind,
      i0,
      i1,
      t0: a.t,
      t1: b.t,
      tick0: a.tick,
      tick1: b.tick,
      replaced,
      dist: dist2(a, b),
      dz: b.z - a.z,
      maxSpeed,
      limit: lim,
    };
  }
}

/** One-line description of an event, e.g. `discontinuity 44.70-44.80 s: 89 u (dz +154) in 0.1 s, max 890 u/s (limit 344)`. */
export function describeEvent(e: TrackEvent): string {
  const dz = Math.round(e.dz);
  const extra = e.kind === 'spike' ? `, ${e.replaced} sample${e.replaced === 1 ? '' : 's'} repaired` : '';
  return (
    `${e.kind} ${e.t0.toFixed(2)}-${e.t1.toFixed(2)} s: ${Math.round(e.dist)} u (dz ${dz >= 0 ? '+' : ''}${dz}) in ${(e.t1 - e.t0).toFixed(1)} s, ` +
    `max ${Math.round(e.maxSpeed)} u/s (limit ${Math.round(e.limit)})${extra}`
  );
}

function buttonPlan(tr: PuppetTrack, r: ReplayTuning): (Button | null)[] {
  const plan: (Button | null)[] = [];
  for (let k = tr.startTick; k <= tr.endTick; k++) {
    const ref = tr.targetAt(k);
    const speed = dist2(ref, tr.positionAt(tOf(k) + r.lookaheadSec)) / r.lookaheadSec;
    plan.push(movementButtons(speed, 0, r)[0] ?? null);
  }
  // Drop WALK / DUCK stretches shorter than buttonMinSec.
  const minTicks = Math.round(r.buttonMinSec * TICK_RATE);
  let i = 0;
  while (i < plan.length) {
    const b = plan[i] as Button | null;
    let j = i;
    while (j + 1 < plan.length && plan[j + 1] === b) j++;
    if (b !== null && j - i + 1 < minTicks) for (let k = i; k <= j; k++) plan[k] = null;
    i = j + 1;
  }
  return plan;
}

function interpolate(raw: readonly TrackSample[], ref: readonly Vec3[] | null, t: number): Vec3 {
  const n = raw.length;
  const at = (i: number): Vec3 => {
    if (ref !== null) return ref[i] as Vec3;
    const s = raw[i] as TrackSample;
    return { x: s.x, y: s.y, z: s.z };
  };
  if (!(t > (raw[0] as TrackSample).t)) return at(0);
  if (t >= (raw[n - 1] as TrackSample).t) return at(n - 1);
  // Largest i with raw[i].t <= t.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if ((raw[mid] as TrackSample).t <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = at(lo);
  const sa = raw[lo] as TrackSample;
  if (sa.t === t) return a;
  const b = at(lo + 1);
  const f = (t - sa.t) / ((raw[lo + 1] as TrackSample).t - sa.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

// ---------------------------------------------------------------------------
// PuppetController
// ---------------------------------------------------------------------------

/**
 * G3: a puppet jumps running when its run is within this cosine (about 25°) of the jump's bearing; else from nearly
 * standing (at most this speed, u/s) within this of the take-off spot (units).
 */
const JUMP_ALIGN_COS = 0.9;
const JUMP_STANDING_SPEED = 60;
const JUMP_STOP_UNITS = 6;

/** Per-pawn controller state (plain data; ReplayCore snapshots it). */
export interface PuppetState {
  readonly id: PlayerId;
  /** Last commanded yaw (degrees), or null before the first command. */
  yaw: number | null;
  /** 2D distance from the pawn to the reference at the last driven tick (after any snap), 6 decimals. */
  behind: number;
  /** Snaps so far. */
  snaps: number;
  /** Teleport points already used for a snap (indices into `PuppetTrack.teleportPoints`). One snap per point. */
  usedPoints: number[];
  lastSnapTick: number | null;
  /** G3: take-offs already jumped (raw indices into the track), and the one in the air: steer at its landing until this tick. */
  usedJumps: number[];
  jumpFrom: number | null;
  jumpUntil: number | null;
}

export interface PuppetStep {
  readonly input: PawnInput;
  /** `teleport` + `log` when the puppet snaps this tick, else empty. */
  readonly actions: Action[];
}

/**
 * Drives one REPLAY pawn along its PuppetTrack. Per tick (`input`):
 *
 * 1. Outside the track (before its first sample, or more than `holdLastPositionSec` after
 *    its last): no move input, yaw held. Up to then the last position is held.
 * 2. ref = reference at t, behind = |pawn − ref| (2D). Snap (teleport to ref, keep yaw,
 *    log it) when behind > `driftSnapUnits`, no human sees the pawn, and an unused
 *    teleport window is open at this tick.
 * 3. ahead = reference at t + `lookaheadSec`, before = at t − `lookaheadSec`; recorded
 *    speed = |ahead − ref| / lookahead.
 * 4. Yaw: the recorded yaw when known, else the heading of motion (bearing from before
 *    to ahead) while moving (recorded speed ≥ `standSpeedThreshold`), else held; turned
 *    toward that at most `maxTurnRateDegPerTick` per tick. V2: "recorded" is the view fitted
 *    to the video (`PuppetTrack.recordedViewAt`), else the radar yaw; a scoped rifle slower
 *    than a walk holds its angle instead of turning to its heading. Pitch: the fitted
 *    pitch (held while watched without one, level otherwise), turned from the observed
 *    pitch at the same limit. B3's aim overrides both during engagements.
 * 5. Buttons: the track's plan (`PuppetTrack.plannedButton`), none while more than
 *    `driftNudgeUnits` behind.
 * 6. Steer at `ahead` if the line to it is walkable, else at the latest reference point
 *    (back to `steerFallbackSec` ago) that is. Wish speed = min(cap, |ahead − pawn| /
 *    lookahead), converted to forward/side in the frame of this tick's yaw.
 */
export class PuppetController {
  readonly track: PuppetTrack;
  private readonly replay: ReplayTuning;
  private readonly movement: MovementTuning;
  private readonly walk: WalkQuery;
  private st: PuppetState;

  constructor(track: PuppetTrack, tuning: Tuning, walk: WalkQuery) {
    this.track = track;
    this.replay = tuning.replay;
    this.movement = tuning.movement;
    this.walk = walk;
    this.st = initialPuppetState(track.id, null);
  }

  get id(): PlayerId {
    return this.track.id;
  }

  /** Live state (mutated by `input`). */
  get state(): PuppetState {
    return this.st;
  }

  /** Forget everything (start / restart); `yaw` is the pawn's setup yaw, or null to take the first observed one. */
  reset(yaw: number | null): void {
    this.st = initialPuppetState(this.track.id, yaw === null ? null : roundYaw(yaw));
  }

  /** Replace the state (snapshot restore). Copies it. */
  restore(s: PuppetState): void {
    if (s.id !== this.track.id) throw new Error(`PuppetController.restore: state for ${s.id}, controller for ${this.track.id}`);
    this.st = { id: s.id, yaw: s.yaw, behind: s.behind, snaps: s.snaps, usedPoints: [...s.usedPoints], lastSnapTick: s.lastSnapTick, usedJumps: [...s.usedJumps], jumpFrom: s.jumpFrom, jumpUntil: s.jumpUntil };
  }

  /** Input that holds still (no stick, no buttons) at the current yaw. */
  neutral(p: PawnObs): PawnInput {
    if (this.st.yaw === null) this.st.yaw = roundYaw(p.yaw);
    return { id: p.id, forward: 0, side: 0, yaw: this.st.yaw, pitch: 0, buttons: [] };
  }

  input(p: PawnObs, o: Observe, tick: number): PuppetStep {
    const r = this.replay;
    const tr = this.track;
    const s = this.st;
    if (s.yaw === null) s.yaw = roundYaw(p.yaw);
    const holdTicks = Math.round(r.holdLastPositionSec * TICK_RATE);
    if (tick < tr.startTick || tick > tr.endTick + holdTicks) {
      s.behind = 0;
      return { input: this.neutral(p), actions: [] };
    }

    const t = tOf(tick);
    const ref = tr.targetAt(tick);
    let pos = p.pos;
    let behind = dist2(pos, ref);
    const actions: Action[] = [];
    if (behind > r.driftSnapUnits && !seenByHuman(o, p.id)) {
      const k = tr.teleportPointAt(tick, s.usedPoints);
      if (k >= 0) {
        const tp = tr.teleportPoints[k] as TeleportPoint;
        const ev = tr.events[tp.event] as TrackEvent;
        actions.push({ type: 'teleport', id: p.id, pos: { x: ref.x, y: ref.y, z: ref.z }, yaw: s.yaw });
        actions.push({
          type: 'log',
          level: 'info',
          text: `puppet ${p.id}: snap to track at tick ${tick}, ${Math.round(behind)} u behind (${ev.kind} at ticks ${ev.tick0}-${ev.tick1})`,
        });
        s.snaps++;
        s.usedPoints.push(k);
        s.lastSnapTick = tick;
        pos = ref;
        behind = 0;
      }
    }
    s.behind = roundNumber(behind);

    const ahead = tr.positionAt(t + r.lookaheadSec);
    const before = tr.positionAt(t - r.lookaheadSec);
    const recordedSpeed = dist2(ref, ahead) / r.lookaheadSec;

    // V2: the recorded view (video fit, else radar yaw) when watched; else the heading of motion while moving, except
    // that a scoped rifle (AWP, SSG 08) moving slower than a walk holds its angle; else held.
    const recorded = tr.recordedViewAt(t);
    let target = recorded === null ? null : recorded.yaw;
    const holdsAngle = tr.scopedAt(t) && recordedSpeed < r.walkSpeedThreshold;
    if (target === null && !holdsAngle && recordedSpeed >= r.standSpeedThreshold && dist2(before, ahead) > 0) target = bearing(before, ahead);
    const yaw = target === null ? s.yaw : turnToward(s.yaw, target, r.maxTurnRateDegPerTick);
    s.yaw = yaw;
    // Pitch: the fitted pitch when known; held while watched without one (the fit failed: smoke, flash); level
    // otherwise. Turned from the observed pitch at the same rate limit as the yaw.
    const pitchTarget = recorded === null ? 0 : recorded.pitch;
    const pitch = pitchTarget === null ? roundPitchDeg(p.pitch) : turnPitch(p.pitch, pitchTarget, r.maxTurnRateDegPerTick);

    // The track's button plan, unless lagging (then run: never WALK / DUCK while behind).
    const planned = tr.plannedButton(tick);
    const buttons: Button[] = planned === null || behind > r.driftNudgeUnits ? [] : [planned];
    let steer = this.walk.isWalkableLine(pos, ahead) ? ahead : this.fallbackSteer(pos, t, ahead);
    // G3: a jump on the track. In its window, on the ground within jumpReachUnits of the take-off spot: JUMP (and DUCK
    // for a crouch jump, held while in the air), then steer at the landing sample until on the ground near it (or the
    // window is over).
    const windowTicks = Math.round(r.jumpWindowSec * TICK_RATE);
    const k = s.jumpFrom === null ? tr.takeoffAt(tick, windowTicks, s.usedJumps) : -1;
    const off = k >= 0 ? (tr.ref[k] as Vec3) : null;
    const land = k >= 0 ? (tr.ref[k + 1] as Vec3) : null;
    // Lined up (running within JUMP_ALIGN_COS of the take-off → landing bearing): jump within jumpReachUnits of the
    // take-off. Otherwise come to the take-off and slow down there (the stick eases off near it), and jump from
    // (nearly) standing, within JUMP_STOP_UNITS: the snapping checked the jump from standing.
    let jumpNow = false;
    let easeTo = ahead;
    if (off !== null && land !== null && p.onGround && dist2(pos, off) <= r.jumpReachUnits) {
      const dx = land.x - off.x;
      const dy = land.y - off.y;
      const sp = Math.hypot(p.vel.x, p.vel.y);
      const dl = Math.hypot(dx, dy);
      const aligned = dl === 0 || (sp > 0 && (p.vel.x * dx + p.vel.y * dy) / (sp * dl) >= JUMP_ALIGN_COS);
      jumpNow = aligned || (dist2(pos, off) <= JUMP_STOP_UNITS && sp <= JUMP_STANDING_SPEED);
      if (!jumpNow) {
        steer = off;
        easeTo = off;
      }
    }
    if (jumpNow) {
      s.usedJumps.push(k);
      s.jumpFrom = k;
      s.jumpUntil = (tr.raw[k + 1] as TrackSample).tick + windowTicks;
      buttons.length = 0;
      buttons.push('JUMP');
    }
    if (s.jumpFrom !== null) {
      const from = s.jumpFrom;
      if (tick > (s.jumpUntil as number) || (p.onGround && !buttons.includes('JUMP') && dist2(pos, tr.ref[from + 1] as Vec3) <= r.jumpReachUnits)) {
        s.jumpFrom = null;
        s.jumpUntil = null;
      } else {
        steer = tr.ref[from + 1] as Vec3;
        if ((tr.raw[from] as TrackSample).jump === 'crouch' && !buttons.includes('DUCK')) {
          const w = buttons.indexOf('WALK');
          if (w >= 0) buttons.splice(w, 1);
          buttons.push('DUCK');
        }
      }
    }
    const cap = maxSpeedOf(p.weapon, buttons, this.movement);
    const scale = cap > 0 ? Math.min(1, dist2(pos, easeTo) / (cap * r.lookaheadSec)) : 0;
    const stick = stickToward(steer.x - pos.x, steer.y - pos.y, yaw, scale);
    return { input: { id: p.id, forward: stick.forward, side: stick.side, yaw, pitch, buttons }, actions };
  }

  /**
   * The latest reference sample before t + lookahead (back to steerFallbackSec before t) in walkable line from `pos`;
   * `ahead` if none. G3: whole samples, not every tick's interpolated point: consecutive samples are in walkable line
   * on the snapped 3D tracks (tools/snap-tracks.ts), so a corner is a sample to steer at, and it costs a dozen queries
   * at most instead of a hundred (the 3D WalkQuery sweeps a hull).
   */
  private fallbackSteer(pos: Vec3, t: number, ahead: Vec3): Vec3 {
    const r = this.replay;
    const tA = t + r.lookaheadSec;
    const raw = this.track.raw;
    // Latest sample at or before tA (binary search), then back while within steerFallbackSec of t.
    let lo = 0;
    let hi = raw.length - 1;
    if ((raw[0] as TrackSample).t > tA + T_EPS) return ahead;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((raw[mid] as TrackSample).t <= tA + T_EPS) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i >= 0 && (raw[i] as TrackSample).t >= t - r.steerFallbackSec - T_EPS; i--) {
      const q = this.track.ref[i] as Vec3;
      if (this.walk.isWalkableLine(pos, q)) return q;
    }
    return ahead;
  }
}

/** Pitch clamped to ±89° and rounded to 0.001° (as aim.ts `roundPitch`; the Core can't import it in a cycle). */
export function roundPitchDeg(deg: number): number {
  const c = deg > PITCH_LIMIT_DEG ? PITCH_LIMIT_DEG : deg < -PITCH_LIMIT_DEG ? -PITCH_LIMIT_DEG : deg;
  const r = Math.round(c * YAW_SCALE) / YAW_SCALE;
  return r === 0 ? 0 : r;
}

/** Turn a pitch toward `to` by at most `maxStep` degrees; rounded. */
function turnPitch(from: number, to: number, maxStep: number): number {
  const d = to - from;
  return roundPitchDeg(from + (d > maxStep ? maxStep : d < -maxStep ? -maxStep : d));
}

/** AWP and SSG 08: the rifles a player scopes in with (B2's weapon ids). */
function isScopedRifle(w: WeaponId | null): boolean {
  return w === 'awp' || w === 'ssg08';
}

/** Index of the last sample with t <= `t` (0 before the first). */
function sampleIndexAtOrBefore(raw: readonly TrackSample[], t: number): number {
  let lo = 0;
  let hi = raw.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if ((raw[mid] as TrackSample).t <= t + T_EPS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function initialPuppetState(id: PlayerId, yaw: number | null): PuppetState {
  return { id, yaw, behind: 0, snaps: 0, usedPoints: [], lastSnapTick: null, usedJumps: [], jumpFrom: null, jumpUntil: null };
}
