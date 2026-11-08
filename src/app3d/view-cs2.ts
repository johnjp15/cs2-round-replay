/**
 * H1: CS2's view (pure; tested in Node): mouse → view angles, field of view, scoped FOV and sensitivity, aim punch
 * and the eye height through a duck. Every number cites where it comes from; docs/app3d.md "View: sources" has the
 * table, with what is verified against a primary source and what is not.
 *
 * Primary sources used:
 *  - [CVARS] CS2's convar dump, SteamDatabase/GameTracking-CS2 `DumpSource2/convars.txt` (commit cce7bf1f, fetched
 *    2026-11-07): `sensitivity 1.25 (min 0.0001, max 8)`, `m_yaw 0.022`, `m_pitch 0.022`, `cl_pitchup 89`,
 *    `cl_pitchdown 89`, `zoom_sensitivity_ratio 1 (min 0.01, max 3)`, `viewmodel_fov 60 (min 60, max 68)`.
 *  - [SDK] Source SDK 2013 (ValveSoftware/source-sdk-2013): `in_mouse.cpp` CInput::ScaleMouse / ApplyMouse (x, y ×=
 *    sensitivity; yaw −= m_yaw × x; pitch += m_pitch × y), `view.cpp` ScaleFOVByWidthRatio (hor+ from a 4:3 FOV) and
 *    the zoomed sensitivity (`(localFOV / defaultFOV) × zoom_sensitivity_ratio × sensitivity`), `gamemovement.cpp`
 *    SetDuckedEyeOffset (SimpleSpline of the duck progress).
 *  - [KZ] KZGlobalTeam/cs2kz-metamod `src/kz/mode/kz_mode_ckz.h` (commit 317449df): CS2's `m_flDuckSpeed`, 8 rested
 *    and 6.0234375 "if you just ducked/unducked for the first time in a while" (M2: the duck speed below).
 */
import type { WeaponId } from '../contracts/index';

/** [CVARS] degrees per mouse count at sensitivity 1. */
export const M_YAW = 0.022;
export const M_PITCH = 0.022;
/** [CVARS] CS2's default `sensitivity` and its range. */
export const DEFAULT_SENSITIVITY = 1.25;
export const SENSITIVITY_MIN = 0.0001;
export const SENSITIVITY_MAX = 8;
/** [CVARS] cl_pitchup / cl_pitchdown. */
export const PITCH_UP = 89;
export const PITCH_DOWN = 89;
/** [CVARS] zoom_sensitivity_ratio default and range. */
export const DEFAULT_ZOOM_RATIO = 1;
/**
 * The player's FOV: 90° horizontal at 4:3, widened for wider screens (hor+, [SDK] ScaleFOVByWidthRatio). CS2 locks it
 * (no `fov` command in matchmaking); the 90 is CS:GO's `default_fov` and what CS2 renders at 4:3. Unverified against a
 * CS2 primary source (CS2's dump lists `fov_desired 75`, which matchmaking doesn't apply).
 */
export const FOV_4X3 = 90;
/** [CVARS] viewmodel_fov default and range (the dump says min 60; CS:GO allowed 54). Also a 4:3 horizontal FOV. */
export const VIEWMODEL_FOV = 60;
export const VIEWMODEL_FOV_MIN = 60;
export const VIEWMODEL_FOV_MAX = 68;

/** [SDK] ScaleFOVByWidthRatio: a FOV defined at 4:3 (degrees) on a screen of `aspect` (width / height), horizontally. */
export function scaleFovByWidthRatio(fovDeg: number, ratio: number): number {
  const half = (fovDeg * Math.PI) / 360;
  return ((Math.atan(Math.tan(half) * ratio) * 180) / Math.PI) * 2;
}

/** The horizontal FOV on screen for a 4:3-defined FOV: 90 → 90 at 4:3, ≈ 106.26 at 16:9. */
export function horizontalFov(fov4x3: number, aspect: number): number {
  return scaleFovByWidthRatio(fov4x3, aspect / (4 / 3));
}

/** The vertical FOV (what a Three.js PerspectiveCamera takes): independent of the aspect (hor+): 90 → ≈ 73.74. */
export function verticalFov(fov4x3: number): number {
  return scaleFovByWidthRatio(fov4x3, 3 / 4);
}

/**
 * Scoped FOVs per zoom level (4:3 degrees, like FOV_4X3). Values: CS:GO / CS2 weapon data `zoom_fov_1` / `zoom_fov_2`
 * (AWP 40 / 10, SSG 08 40 / 15, AUG and SG 553 45, G3SG1 and SCAR-20 40 / 15), as documented by players; to be
 * replaced by H2's weapon table (data/weapons.json) once it lands. Unverified against the CS2 vdata.
 */
export const ZOOM_FOVS: Readonly<Partial<Record<WeaponId | 'aug' | 'sg553' | 'g3sg1' | 'scar20', readonly number[]>>> = {
  awp: [40, 10],
  ssg08: [40, 15],
  aug: [45],
  sg553: [45],
  g3sg1: [40, 15],
  scar20: [40, 15],
};

/** The FOV (4:3 degrees) at a zoom level (0 = unscoped) of a weapon. */
export function zoomFov(weapon: string, level: number): number {
  const z = ZOOM_FOVS[weapon as WeaponId];
  if (z === undefined || level <= 0) return FOV_4X3;
  return z[Math.min(level, z.length) - 1] ?? FOV_4X3;
}

/** The next zoom level after a scope press (mouse 2): unscoped → 1 → 2 → unscoped (one level: 1 → unscoped). */
export function nextZoom(weapon: string, level: number): number {
  const z = ZOOM_FOVS[weapon as WeaponId];
  if (z === undefined) return 0;
  return level >= z.length ? 0 : level + 1;
}

/** [SDK] view.cpp: the sensitivity while zoomed: sensitivity × (zoomed FOV / default FOV) × zoom_sensitivity_ratio (linear in the FOV). */
export function effectiveSensitivity(sensitivity: number, fov4x3: number, zoomRatio = DEFAULT_ZOOM_RATIO): number {
  return fov4x3 >= FOV_4X3 ? sensitivity : sensitivity * (fov4x3 / FOV_4X3) * zoomRatio;
}

export interface Angles {
  readonly yaw: number;
  readonly pitch: number;
}

function wrap(a: number): number {
  const r = (((a % 360) + 540) % 360) - 180;
  return r === -180 ? 180 : r;
}

/**
 * [SDK] CInput::ApplyMouse after ScaleMouse, no acceleration (`m_customaccel 0`), no filtering: yaw −= m_yaw × dx ×
 * sens, pitch += m_pitch × dy × sens, pitch clamped to [−cl_pitchup, cl_pitchdown]. dx, dy are mouse counts (the
 * pointer-lock movementX / movementY).
 */
export function applyMouse(view: Angles, dx: number, dy: number, sensitivity: number): Angles {
  return { yaw: wrap(view.yaw - M_YAW * dx * sensitivity), pitch: Math.max(-PITCH_UP, Math.min(PITCH_DOWN, view.pitch + M_PITCH * dy * sensitivity)) };
}

/**
 * Aim punch (recoil) hook. CS:GO's rules, kept by CS2 as far as is known: bullets leave along view + aimPunch ×
 * weapon_recoil_scale (2.0) and the camera shows view + aimPunch × weapon_recoil_scale × view_recoil_tracking (0.45).
 * Both cvars are hidden in CS2 (not in the dump): CS:GO values, unverified for CS2. The punch itself (per shot, decay)
 * is H2's module (src/engine/weapons), wired in by H2b: the 3D app now takes the camera and crosshair from the host's
 * `aimView` (with the player's recoil-tracking setting); these helpers are kept for the view tests.
 */
export const WEAPON_RECOIL_SCALE = 2;
export const VIEW_RECOIL_TRACKING = 0.45;
export const ZERO_PUNCH: Angles = { yaw: 0, pitch: 0 };

export function firingAngles(view: Angles, aimPunch: Angles = ZERO_PUNCH): Angles {
  return { yaw: view.yaw + aimPunch.yaw * WEAPON_RECOIL_SCALE, pitch: view.pitch + aimPunch.pitch * WEAPON_RECOIL_SCALE };
}

export function cameraAngles(view: Angles, aimPunch: Angles = ZERO_PUNCH): Angles {
  const k = WEAPON_RECOIL_SCALE * VIEW_RECOIL_TRACKING;
  return { yaw: view.yaw + aimPunch.yaw * k, pitch: view.pitch + aimPunch.pitch * k };
}

/** Source view offsets (units above the feet): standing 64, ducked 46 (`damage.eyeHeight` / `crouchEyeHeight`). */
export const EYE_STAND = 64;
export const EYE_DUCK = 46;
/**
 * [KZ] CS2's `m_flDuckSpeed` for a fresh duck or unduck (6.0234375; 8 rested), read as duck amount per second: a
 * full duck or stand-up takes 1 / 6.0234375 = 0.166 s (10.6 ticks), both ways. The per-second unit is an assumption
 * (the field's name and the 0..1 `m_flDuckAmount` it drives; CS2's code is not public), and the slower speed after
 * spamming duck is not modelled. Before M2 the view used Source 1's (HL2) TIME_TO_DUCK 0.4 / TIME_TO_UNDUCK 0.2 s.
 */
export const DUCK_SPEED = 6.0234375;

/** [SDK] SimpleSpline: 3x² − 2x³. */
export function simpleSpline(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return 3 * c * c - 2 * c * c * c;
}

/**
 * The camera's duck amount (0 standing .. 1 ducked) advanced by `dt` seconds toward the pawn's posture at
 * DUCK_SPEED, and the eye height for it ([SDK] SetDuckedEyeOffset: the spline of the duck progress between the two
 * view offsets). The shared movement (src/sim2d/movement.ts) switches the hull and the sim's eye (sight, bullets) at
 * once; this is the view's transition only, so the camera doesn't jump.
 */
export function duckStep(amount: number, crouching: boolean, dt: number): number {
  return crouching ? Math.min(1, amount + dt * DUCK_SPEED) : Math.max(0, amount - dt * DUCK_SPEED);
}

export function eyeHeightFor(amount: number): number {
  return EYE_STAND + (EYE_DUCK - EYE_STAND) * simpleSpline(amount);
}

/** A pawn at one end of the interval a frame is drawn in: an observe, or the human's predicted next tick (M2). */
export interface EyeEnd {
  readonly tick: number;
  readonly crouching: boolean;
  readonly onGround: boolean;
}

/**
 * M2: the camera's eye height above the drawn feet, frame by frame. The duck eases as `duckStep` / `eyeHeightFor`.
 * In the air the shared movement tucks the feet up by `movement.airDuckLift` (9) on the tick DUCK is pressed and
 * lowers them again on an unduck, at once (src/sim2d/movement.ts); the drawn feet follow within that tick, so the
 * plain eased offset made the eye jump 9 units up and then sink 18 over the duck. `step` cancels the feet's jump
 * (ramped in with the interpolation over the tick that has it) and lets the correction run out with the duck's
 * spline, so through an in-air duck the eye sinks 9 smoothly, as CS2's gradual duck. Two ticks run within one frame
 * (below 64 fps) can hide a stance change from it; that frame then jumps as before.
 */
export class ViewEye {
  /** Duck amount, 0 standing .. 1 ducked. */
  duck = 0;
  /** Correction (units) of past stance changes in the air, running out with the duck. */
  private tuck = 0;
  /** Correction of the interval drawn last frame (in full, at its end) and that interval's end tick. */
  private flip = 0;
  private flipEnd = Number.NaN;

  /** At once in posture (a new viewed pawn, an exact render). */
  reset(crouching: boolean): void {
    this.duck = crouching ? 1 : 0;
    this.tuck = 0;
    this.flip = 0;
    this.flipEnd = Number.NaN;
  }

  /**
   * One frame drawn `alpha` of the way from `a` (null: nothing earlier) to `b`, `dt` seconds after the last one;
   * `lift` = `movement.airDuckLift`. Returns the eye height above the drawn (interpolated) feet.
   */
  step(a: EyeEnd | null, b: EyeEnd, alpha: number, dt: number, lift: number): number {
    if (b.tick !== this.flipEnd) {
      this.tuck += this.flip;
      this.flipEnd = b.tick;
    }
    // Recomputed every frame: the human's predicted end can change within its tick.
    this.flip = a !== null && a.tick < b.tick && !a.onGround && a.crouching !== b.crouching ? (b.crouching ? -lift : lift) : 0;
    const target = b.crouching ? 1 : 0;
    const left = target - simpleSpline(this.duck);
    this.duck = duckStep(this.duck, b.crouching, dt);
    if (this.duck === target) this.tuck = 0;
    else if (left !== 0) this.tuck *= (target - simpleSpline(this.duck)) / left;
    return eyeHeightFor(this.duck) + this.tuck + this.flip * Math.min(1, Math.max(0, alpha));
  }
}
