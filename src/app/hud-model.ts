/**
 * HUD and overlay logic, pure and DOM-free: mode badges, weapon names, the round clock / bomb timer,
 * the score, view toggles. hud.ts (DOM) and renderer.ts (canvas) only display what these return.
 *
 * Round state: C3 adds `Observe.round` (phase, score, winner, bomb, …). roundStateOf() reads it when
 * present; until then the clock falls back to RoundClock and the Scene's bomb events.
 */
import type { Mode, Observe, PawnObs, PlayerId, RoundEndReason, Team, Vec3 } from '../contracts/index';
import type { RoundClock } from '../core/index';
import type { BombState, RoundEnd } from './scene';

// ---- mode badges -------------------------------------------------------------------------------

export type BadgeTone = 'subtle' | 'alert' | 'dead' | 'human';

export interface Badge {
  readonly text: 'REPLAY' | 'LIVE' | 'DEAD' | 'YOU';
  /** subtle = REPLAY (quiet), alert = LIVE (bright), dead, human = the player's own pawn. */
  readonly tone: BadgeTone;
}

/**
 * The badge for a pawn from its `act.status` mode: Core reports the human's own living pawn as HUMAN (B4),
 * which reads "YOU". No status yet (before the first step) reads as REPLAY, or YOU for the human's pawn.
 */
export function statusBadge(mode: Mode | null, isHuman: boolean, alive = true): Badge {
  if (mode === 'DEAD' || !alive) return { text: 'DEAD', tone: 'dead' };
  if (mode === 'HUMAN' || (mode === null && isHuman)) return { text: 'YOU', tone: 'human' };
  if (mode === 'LIVE') return { text: 'LIVE', tone: 'alert' };
  return { text: 'REPLAY', tone: 'subtle' };
}

// ---- names ---------------------------------------------------------------------------------------

const WEAPON_NAMES: Readonly<Record<string, string>> = {
  ak47: 'AK-47',
  awp: 'AWP',
  ssg08: 'SSG 08',
  deagle: 'Desert Eagle',
  m4a4: 'M4A4',
  glock: 'Glock-18',
  knife: 'Knife',
  c4: 'C4',
  smoke: 'Smoke',
  flash: 'Flashbang',
  he: 'HE grenade',
  molotov: 'Molotov',
};

/** Short display name of a weapon id (unknown ids pass through; null = world damage). */
export function weaponName(w: string | null): string {
  if (w === null) return 'World';
  return WEAPON_NAMES[w] ?? w;
}

/** Weapons that show a clip / reserve count. */
export function hasAmmo(w: string): boolean {
  return !['knife', 'c4', 'smoke', 'flash', 'he', 'molotov'].includes(w);
}

/** HP colour band: healthy, hurt, critical. */
export function hpBand(hp: number): 'ok' | 'hurt' | 'low' {
  return hp > 50 ? 'ok' : hp > 20 ? 'hurt' : 'low';
}

// ---- view toggles --------------------------------------------------------------------------------

export interface Overlays {
  /** Camera follows cart. */
  readonly follow: boolean;
  /** cart's recorded position as a hollow outline. */
  readonly ghost: boolean;
  /** Each pawn's recorded path for the next few seconds. */
  readonly tracks: boolean;
  /** Status panel open. */
  readonly panel: boolean;
}

export type OverlayKey = keyof Overlays;

/** View toggles by `KeyboardEvent.code`: F follow, G ghost, T tracks, Tab panel. */
export function overlayForKey(code: string): OverlayKey | null {
  switch (code) {
    case 'KeyF':
      return 'follow';
    case 'KeyG':
      return 'ghost';
    case 'KeyT':
      return 'tracks';
    case 'Tab':
      return 'panel';
    default:
      return null;
  }
}

export function toggleOverlay(o: Overlays, key: OverlayKey): Overlays {
  return { ...o, [key]: !o[key] };
}

// ---- round state (C3) ----------------------------------------------------------------------------

/** The shape C3 adds as `Observe.round`. Read through roundStateOf(); absent until C3 lands. */
export interface RoundStateLike {
  readonly phase: 'live' | 'planted' | 'over';
  readonly score: { readonly ct: number; readonly t: number };
  readonly winner: Team | null;
  readonly reason: RoundEndReason | null;
  readonly endTick: number | null;
  readonly timeLeftSec: number;
  readonly bomb: {
    readonly state: string;
    readonly carrier: PlayerId | null;
    readonly pos: Vec3 | null;
    readonly plantTick: number | null;
    readonly defuser: PlayerId | null;
    readonly defuseEndTick: number | null;
  };
}

/** `observe.round` if the host reports one (C3), else null. */
export function roundStateOf(o: Observe): RoundStateLike | null {
  const r = (o as { readonly round?: unknown }).round;
  if (typeof r !== 'object' || r === null) return null;
  const s = r as Partial<RoundStateLike>;
  if (typeof s.phase !== 'string' || typeof s.score !== 'object' || s.score === null || typeof s.bomb !== 'object' || s.bomb === null) return null;
  return r as RoundStateLike;
}

// ---- clock and score ---------------------------------------------------------------------------

export type ClockMode = 'round' | 'bomb' | 'defusing' | 'defused' | 'exploded' | 'over';

export interface ClockView {
  /** The big figure: "1:36", "38.4", … */
  readonly text: string;
  readonly mode: ClockMode;
  /** Bomb time left as a fraction of the timer (for the draining bar), or null. */
  readonly bombLeft: number | null;
  /** Who won, once the round is over. */
  readonly winner: Team | null;
  readonly reason: RoundEndReason | null;
}

function mss(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/**
 * The top-centre clock at `tick`: the round clock, then the red bomb timer once the bomb is planted.
 * Reads `observe.round` (C3) when present, else RoundClock and the Scene's bomb and round-end events.
 */
export function clockView(o: Observe, clock: RoundClock, bomb: BombState, roundEnd: RoundEnd | null): ClockView {
  const tick = o.tick;
  const r = roundStateOf(o);
  if (r !== null) {
    const plantTick = r.bomb.plantTick;
    const bombLeft = plantTick === null ? null : Math.max(0, clock.bombRemaining(tick, plantTick) / clock.bombTimerSec);
    if (r.phase === 'over') {
      const mode: ClockMode = r.reason === 'bomb_defused' ? 'defused' : r.reason === 'bomb_exploded' ? 'exploded' : 'over';
      const text = plantTick !== null && r.reason !== 'time' ? clock.hudBomb(r.endTick ?? tick, plantTick) : mss(r.timeLeftSec);
      return { text, mode, bombLeft, winner: r.winner, reason: r.reason };
    }
    if (r.phase === 'planted' && plantTick !== null) {
      const mode: ClockMode = r.bomb.defuser !== null ? 'defusing' : 'bomb';
      return { text: clock.hudBomb(tick, plantTick), mode, bombLeft, winner: null, reason: null };
    }
    return { text: mss(r.timeLeftSec), mode: 'round', bombLeft: null, winner: null, reason: null };
  }
  // Fallback: RoundClock and events.
  const winner = roundEnd?.winner ?? null;
  const reason = roundEnd?.reason ?? null;
  if (bomb.plantTick !== null) {
    const at = bomb.endTick ?? roundEnd?.tick ?? tick;
    const bombLeft = Math.max(0, clock.bombRemaining(at, bomb.plantTick) / clock.bombTimerSec);
    const mode: ClockMode =
      bomb.phase === 'defused' ? 'defused' : bomb.phase === 'exploded' ? 'exploded' : roundEnd !== null ? 'over' : bomb.phase === 'defusing' ? 'defusing' : 'bomb';
    return { text: clock.hudBomb(at, bomb.plantTick), mode, bombLeft, winner, reason };
  }
  if (roundEnd !== null) return { text: clock.hudClock(roundEnd.tick), mode: 'over', bombLeft: null, winner, reason };
  return { text: clock.hudClock(tick), mode: 'round', bombLeft: null, winner: null, reason: null };
}

/** Score to show: `observe.round.score` (C3), else the recorded score before the round plus this round's winner. */
export function scoreView(o: Observe, before: { readonly ct: number; readonly t: number }, roundEnd: RoundEnd | null): { ct: number; t: number } {
  const r = roundStateOf(o);
  if (r !== null) return { ct: r.score.ct, t: r.score.t };
  if (roundEnd === null) return { ct: before.ct, t: before.t };
  return roundEnd.winner === 'CT' ? { ct: before.ct + 1, t: before.t } : { ct: before.ct, t: before.t + 1 };
}

/** Bomb carrier from C3 (for the C4 marker on a pawn), or null. */
export function bombCarrier(o: Observe): PlayerId | null {
  return roundStateOf(o)?.bomb.carrier ?? null;
}

// ---- your status ---------------------------------------------------------------------------------

export interface YouView {
  readonly id: PlayerId;
  readonly team: Team;
  readonly alive: boolean;
  readonly hp: number;
  readonly armor: number;
  readonly weapon: string;
  /** "30 / 90", or null for weapons without ammo. */
  readonly ammo: string | null;
  readonly band: 'ok' | 'hurt' | 'low';
}

export function youView(p: PawnObs): YouView {
  return {
    id: p.id,
    team: p.team,
    alive: p.alive,
    hp: p.alive ? p.hp : 0,
    armor: p.alive ? p.armor : 0,
    weapon: weaponName(p.weapon),
    ammo: hasAmmo(p.weapon) ? `${p.ammo.clip} / ${p.ammo.reserve}` : null,
    band: hpBand(p.alive ? p.hp : 0),
  };
}

// ---- labels clear of the HUD (F) ---------------------------------------------------------------------

/** A screen rectangle (CSS px, canvas = stage coordinates). */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** True if the two rectangles overlap, with `padX` px kept free left and right. */
export function rectsOverlap(a: ScreenRect, b: ScreenRect, padX = 0): boolean {
  return a.x < b.x + b.w + padX && a.x + a.w + padX > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Where a pawn's name label goes, of `candidates` (top-left corners, in preference order) for a `w` × `h` label: the
 * first that overlaps neither a label already placed (2 px apart) nor a HUD rectangle in `avoid`; else the first that
 * keeps clear of the HUD (it may overlap another label, as before); else null: the label would sit under the
 * scoreboard, the kill feed, the panel or the status card, so the text is dropped and only the pawn's dot shows.
 */
export function chooseLabelSpot(
  candidates: readonly { readonly x: number; readonly y: number }[],
  w: number,
  h: number,
  placed: readonly ScreenRect[],
  avoid: readonly ScreenRect[],
): { x: number; y: number } | null {
  const clearOfHud = (c: { x: number; y: number }): boolean => !avoid.some((a) => rectsOverlap({ x: c.x, y: c.y, w, h }, a, 2));
  let fallback: { x: number; y: number } | null = null;
  for (const c of candidates) {
    if (!clearOfHud(c)) continue;
    if (!placed.some((q) => rectsOverlap({ x: c.x, y: c.y, w, h }, q, 2))) return { x: c.x, y: c.y };
    fallback ??= { x: c.x, y: c.y };
  }
  return fallback;
}

// ---- LIVE AI in the status panel (F; 2D debug only) --------------------------------------------------

/** What the status panel reads of `Sim2DHost.aiDebug(id)` (the 2D engine's LIVE AI; CS2 has its own bot state). */
export interface AiDebugView {
  readonly role: string;
  readonly behaviour: string;
  readonly target: PlayerId | null;
  readonly targetVisible: boolean;
  readonly dest: Vec3 | null;
  readonly path: readonly Vec3[];
}

/** Anything that answers aiDebug (Sim2DHost); null for pawns that aren't LIVE. */
export interface AiDebugSource {
  aiDebug(id: PlayerId): (AiDebugView & { readonly id: PlayerId }) | null;
}

/**
 * The status panel's line for a LIVE pawn: its behaviour, target and goal, e.g.
 * "fighting · target sp4rtan · defuse → (-1982, 311)". null when it isn't LIVE (no debug view).
 */
export function aiDebugLine(d: AiDebugView | null): string | null {
  if (d === null) return null;
  const parts: string[] = [d.behaviour];
  if (d.target !== null) parts.push(`target ${d.target}${d.targetVisible ? '' : ' (out of sight)'}`);
  const dest = d.dest === null ? '' : ` → (${Math.round(d.dest.x)}, ${Math.round(d.dest.y)})`;
  parts.push(`${d.role}${dest}`);
  return parts.join(' · ');
}
