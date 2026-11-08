/**
 * U1: spectating, the pure part (tests/app3d-spectate.test.ts; docs/app3d.md "Spectating").
 *
 * CS2's spectator controls: mouse 1 (or Space) the next player, mouse 2 the previous, V cycles first person (the
 * player's eyes, viewmodel, HUD and crosshair) → third person → free fly. In first person the mouse does nothing
 * (the view is theirs); in third person it orbits, in free fly it looks. Dead, the human spectates their own team
 * while any teammate lives (CS2 competitive's mp_forcecamera 1); watching (nobody controlled), everyone.
 */
import type { PawnObs, PlayerId, Team } from '../contracts/index';

/**
 * H6 (#85, John 11-07 17:47): the death fade. When you die (the human, or the player spectated in first person) you
 * keep your own view, frozen where you were looking (no turn to the killer, no free look), while the eye drops to the
 * ground, and the screen fades to black over 2 s; a headshot fades almost at once (no info for the dead), though not
 * in one frame; then spectating starts (the next living teammate).
 * - 2 s: CS2's `cl_deathcam_audio_mix_phase1_fade_time` 2 ("the amount of time we fade out over" on the death cam fade
 *   out; CS2 console dump) and `spec_freeze_time` 2 (cfg/gamemode_competitive.cfg, GameTracking-CS2).
 * - 0.4 s for a headshot: CS2 documents no headshot fade; 0.4 s is our pick, the length of CS2's second death-cam
 *   audio fade (`cl_deathcam_audio_mix_phase2_fade_time` 0.4).
 * - The drop: to `VEC_DEAD_VIEWHEIGHT` 14 u above the feet (CS:GO's cs_gamerules.cpp) over `CS_DEATH_ANIMATION_TIME`
 *   0.5 s (cs_shareddefs.h), accelerating like a fall.
 */
export const DEATH_FADE = { sec: 2, headshotSec: 0.4, groundEye: 14, dropSec: 0.5 } as const;

export interface DeathFade {
  /** Black over the view, 0..1. */
  readonly black: number;
  /** The eye's height above the feet (units). */
  readonly eyeHeight: number;
  /** The fade is over: spectate the next player. */
  readonly done: boolean;
}

/** The death fade `t` s after the death, from an eye `eyeHeight` u above the feet (64 standing, 46 crouched). */
export function deathFade(t: number, headshot: boolean, eyeHeight: number): DeathFade {
  const s = Math.max(0, t);
  const fall = Math.min(1, s / DEATH_FADE.dropSec);
  const black = Math.min(1, s / (headshot ? DEATH_FADE.headshotSec : DEATH_FADE.sec));
  return { black: black * black * (3 - 2 * black), eyeHeight: eyeHeight + (DEATH_FADE.groundEye - eyeHeight) * fall * fall, done: s >= DEATH_FADE.sec };
}

export type SpectateMode = 'pov' | 'follow' | 'free';

/** V's order, starting from the default (first person). */
export const SPECTATE_MODES: readonly SpectateMode[] = ['pov', 'follow', 'free'];

export function nextSpectateMode(m: SpectateMode): SpectateMode {
  return SPECTATE_MODES[(SPECTATE_MODES.indexOf(m) + 1) % SPECTATE_MODES.length] as SpectateMode;
}

export function spectateModeLabel(m: SpectateMode): string {
  return m === 'pov' ? '1st person' : m === 'follow' ? '3rd person' : 'free camera';
}

/** Who can be spectated: alive pawns, only the human's team while a teammate lives (the human dead). */
export function spectatable(pawns: readonly PawnObs[], humanTeam: Team | null): PlayerId[] {
  const alive = pawns.filter((p) => p.alive);
  if (humanTeam !== null) {
    const mates = alive.filter((p) => p.team === humanTeam);
    if (mates.length > 0) return mates.map((p) => p.id);
  }
  return alive.map((p) => p.id);
}

/** The next (dir 1) or previous (dir −1) of `ids` after `current` (the first when `current` isn't among them). */
export function cycleTarget(ids: readonly PlayerId[], current: PlayerId, dir: 1 | -1): PlayerId {
  if (ids.length === 0) return current;
  const i = ids.indexOf(current);
  if (i < 0) return ids[dir === 1 ? 0 : ids.length - 1] as PlayerId;
  return ids[(i + dir + ids.length) % ids.length] as PlayerId;
}

/**
 * Where the crosshair sits on screen (px from the centre, +x right, +y down) for a view through `camera` with the
 * next bullet going along `aim` (both Source degrees: yaw CCW, pitch + = down), a vertical FOV of `vfovDeg` and a
 * viewport `height` px tall. Zero when they agree (no punch).
 */
export function aimOffsetPx(camera: { yaw: number; pitch: number }, aim: { yaw: number; pitch: number }, vfovDeg: number, height: number): { x: number; y: number } {
  if (camera.yaw === aim.yaw && camera.pitch === aim.pitch) return { x: 0, y: 0 };
  const r = Math.PI / 180;
  const dir = (a: { yaw: number; pitch: number }): [number, number, number] => [Math.cos(a.pitch * r) * Math.cos(a.yaw * r), Math.cos(a.pitch * r) * Math.sin(a.yaw * r), -Math.sin(a.pitch * r)];
  const d = dir(aim);
  const f = dir(camera);
  const cy = camera.yaw * r;
  const cp = camera.pitch * r;
  const right: [number, number, number] = [Math.sin(cy), -Math.cos(cy), 0];
  // up = right × forward
  const up: [number, number, number] = [Math.sin(cp) * Math.cos(cy), Math.sin(cp) * Math.sin(cy), Math.cos(cp)];
  const dot = (a: readonly number[], b: readonly number[]): number => (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);
  const z = dot(d, f);
  if (z <= 1e-6) return { x: 0, y: 0 };
  const t = Math.tan((vfovDeg * r) / 2);
  return { x: ((dot(d, right) / z / t) * height) / 2, y: (-(dot(d, up) / z / t) * height) / 2 };
}

export interface SpectatePanel {
  readonly name: string;
  readonly team: 'T' | 'CT';
  readonly stats: string;
  readonly mode: string;
  readonly hints: string;
}

/** The bottom spectator panel's text (null: not spectating). */
/** @param target H3: the pawn E would take (cart in the recorded round; the spectated one in free play). */
export function spectatePanel(p: PawnObs | null, kills: number, mode: SpectateMode, weapon: string, canTakeControl: boolean, target = 'cart'): SpectatePanel | null {
  if (p === null) return null;
  const hp = p.alive ? Math.round(p.hp) : 0;
  const hints = [mode === 'free' ? 'Mouse 1 / 2 pick a player' : 'Mouse 1 / 2 switch player', 'V mode', canTakeControl ? `E take control of ${target}` : null].filter((x) => x !== null).join(' · ');
  return {
    name: p.id,
    team: p.team,
    stats: `${hp} HP · ${Math.round(p.armor)} armor · ${weapon} · ${kills} ${kills === 1 ? 'kill' : 'kills'}`,
    mode: spectateModeLabel(mode),
    hints,
  };
}
