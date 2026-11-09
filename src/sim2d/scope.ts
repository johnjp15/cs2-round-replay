/**
 * V5 (#90): sniper scopes for both hosts, so a puppet's recorded scope (`tracks.<id>.scope`, the Core's ATTACK2
 * presses) narrows its `sees` FOV and slows its walk the same way in Sim2DHost and Sim3DHost (G6: both hosts decide who
 * sees whom identically). This is the zoom part of the 3D host's weapon mechanics (`trackArms` / `trackShot` in
 * src/engine/weapons/arms.ts, which src/sim2d may not import), step for step: ATTACK2 (a new press, the zoom timer
 * run out, not reloading) steps the level 0 → 1 → … → 0; a reload or a weapon switch drops it; a gun that unzooms on
 * firing drops it on the shot and takes it back once the bolt has cycled (the host's next-attack tick). The 3D host
 * keeps its own copy in its arms state for the overlay and the human (tests: the two agree on every tick).
 *
 * Values: CS2 `scripts/weapons.vdata` via data/weapons.json (`zoom.levels`, `zoom.times[1]` = m_flZoomTime1,
 * `zoom.fov` = m_nZoomFOV1/2 at 4:3, `maxSpeed[1]` = m_flMaxSpeed alt), checked against the table by the tests.
 */
import { roundNumber } from '../contracts/index';
import { TICKS_PER_SEC } from './movement';
import { reached } from './weapons';

export interface ScopeDef {
  readonly levels: number;
  /** m_flZoomTime1: seconds before the next ATTACK2 can step the zoom. */
  readonly zoomTimeSec: number;
  /** The scope drops on a shot and comes back when the bolt has cycled (AWP, SSG 08). */
  readonly unzoomsAfterShot: boolean;
  /** FOV (4:3 degrees) at zoom level 1 and 2. */
  readonly fov4x3: readonly number[];
  /** m_flMaxSpeed while scoped (units/s). */
  readonly scopedSpeed: number;
}

/** The scoped guns of the round (data/weapons.json awp, ssg08). */
export const SCOPED_GUNS: Readonly<Record<string, ScopeDef>> = {
  awp: { levels: 2, zoomTimeSec: 0.05, unzoomsAfterShot: true, fov4x3: [40, 10], scopedSpeed: 100 },
  ssg08: { levels: 2, zoomTimeSec: 0.05, unzoomsAfterShot: true, fov4x3: [40, 15], scopedSpeed: 230 },
};

/** A pawn's scope; plain data (host snapshots). */
export interface ScopeState {
  /** The item the state is for (a switch drops the scope). */
  readonly weapon: string;
  /** 0 unscoped. */
  readonly zoom: number;
  /** The level to take back once the bolt has cycled (0: none). */
  readonly resumeZoom: number;
  /** ATTACK2 steps the zoom again from this tick. */
  readonly nextAltTick: number;
  /** ATTACK2 was held last tick (a step needs a new press). */
  readonly altThisPress: boolean;
}

export function freshScope(weapon: string): ScopeState {
  return { weapon, zoom: 0, resumeZoom: 0, nextAltTick: 0, altThisPress: false };
}

/** One tick, before the host's fire step (as `trackArms`): `nextAttackTick` is the held item's, before this tick's step. */
export function stepScope(s0: ScopeState, inp: { readonly tick: number; readonly weapon: string; readonly attack2: boolean; readonly reloading: boolean; readonly nextAttackTick: number }): ScopeState {
  let s = s0.weapon === inp.weapon ? s0 : { ...s0, weapon: inp.weapon, zoom: 0, resumeZoom: 0, altThisPress: false };
  const def = SCOPED_GUNS[s.weapon];
  const t = inp.tick;
  if (inp.reloading && (s.zoom > 0 || s.resumeZoom > 0)) s = { ...s, zoom: 0, resumeZoom: 0 };
  if (s.resumeZoom > 0 && reached(t, inp.nextAttackTick)) s = { ...s, zoom: s.resumeZoom, resumeZoom: 0 };
  if (def !== undefined && inp.attack2 && !s.altThisPress && !inp.reloading && reached(t, s.nextAltTick)) {
    s = { ...s, zoom: (s.zoom + 1) % (def.levels + 1), resumeZoom: 0, nextAltTick: roundNumber(t + def.zoomTimeSec * TICKS_PER_SEC) };
  }
  return s.altThisPress === inp.attack2 ? s : { ...s, altThisPress: inp.attack2 };
}

/** A shot this tick (as `trackShot`): a gun that unzooms on firing drops its scope until the bolt has cycled. */
export function scopeShot(s: ScopeState): ScopeState {
  const def = SCOPED_GUNS[s.weapon];
  return def !== undefined && def.unzoomsAfterShot && s.zoom > 0 ? { ...s, resumeZoom: s.zoom, zoom: 0 } : s;
}

/**
 * The horizontal FOV `sees` uses for a scoped pawn: the scope's 4:3 FOV widened to 16:9 (hor+, as the unscoped 90 →
 * 106.26 of `ai.fovDeg`): AWP zoom 1 (40) → 51.8, zoom 2 (10) → 13.3; null unscoped.
 */
export function scopedFovDeg(s: ScopeState | undefined): number | null {
  if (s === undefined || s.zoom <= 0) return null;
  const f = SCOPED_GUNS[s.weapon]?.fov4x3[Math.min(s.zoom, 2) - 1];
  if (f === undefined) return null;
  return roundNumber((2 * Math.atan(Math.tan((f * Math.PI) / 360) * (4 / 3)) * 180) / Math.PI);
}

/** The scoped walk speed cap (units/s), or null unscoped. */
export function scopedSpeed(s: ScopeState | undefined): number | null {
  if (s === undefined || s.zoom <= 0) return null;
  return SCOPED_GUNS[s.weapon]?.scopedSpeed ?? null;
}
