/**
 * Flashbang blindness (docs/grenades.md, Flash). The structure is Source Counter-Strike's `RadiusFlash`: every
 * pawn within `flashRadius` gets strength = flashBase × (1 − distance / flashRadius) × exposure, where exposure is 1
 * if the line from the flash to the eye is clear, else the share of three probe points beside and above the eye that
 * are; then by the angle between the view and the flash (front / side / back bands) the strength becomes a hold time
 * (full white) and a total fade time. CS2's exact constants are not public: the band factors are Source's, the
 * scale is fitted to "up to ~5 s" (unverified, tunable).
 */
import type { GrenadeCs2Tuning, Vec3 } from '../../contracts/index';
import { forward, TICK_RATE } from './math';
import { smokeBlocks } from './smoke';
import type { Blind, GrenadePawn, GrenadeState, GrenadeWorld } from './types';

export interface FlashExposure {
  readonly distance: number;
  /** 0..1 */
  readonly exposure: number;
  /** cos of the angle between the view direction and the direction to the flash. */
  readonly dot: number;
}

/** How much of the flash at `src` reaches the pawn's eye. */
export function flashExposure(src: Vec3, p: Pick<GrenadePawn, 'eye' | 'yaw' | 'pitch'>, world: GrenadeWorld, state: GrenadeState, tick: number, t: GrenadeCs2Tuning): FlashExposure {
  const e = p.eye;
  const lx = src.x - e.x;
  const ly = src.y - e.y;
  const lz = src.z - e.z;
  const distance = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const f = forward(p.pitch, p.yaw);
  const dot = distance > 0 ? (f.x * lx + f.y * ly + f.z * lz) / distance : 1;
  let exposure = 0;
  if (world.traceLine(src.x, src.y, src.z, e.x, e.y, e.z) >= 1) {
    exposure = 1;
  } else if (distance > 0) {
    // Right and up of the flash → eye direction.
    const dx = -lx / distance;
    const dy = -ly / distance;
    const h = Math.sqrt(dx * dx + dy * dy);
    const rx = h > 0 ? dy / h : 1;
    const ry = h > 0 ? -dx / h : 0;
    const o = t.flashProbeOffset;
    const probes: Vec3[] = [
      { x: e.x + rx * o, y: e.y + ry * o, z: e.z },
      { x: e.x - rx * o, y: e.y - ry * o, z: e.z },
      { x: e.x, y: e.y, z: e.z + o },
    ];
    for (const q of probes) if (world.traceLine(src.x, src.y, src.z, q.x, q.y, q.z) >= 1) exposure += t.flashProbeWeight;
  }
  if (exposure > 0 && t.flashSmokeFactor < 1 && smokeBlocks(state, src, e, tick, t)) exposure *= t.flashSmokeFactor;
  return { distance, exposure: Math.min(1, exposure), dot };
}

/** Blind from an exposure, or null if none. */
export function blindFromExposure(x: FlashExposure, tick: number, t: GrenadeCs2Tuning): Blind | null {
  if (x.exposure <= 0 || x.distance >= t.flashRadius) return null;
  const strength = t.flashBase * (1 - x.distance / t.flashRadius) * x.exposure;
  if (strength <= 0) return null;
  let fade: number;
  let hold: number;
  let alpha = 1;
  if (x.dot >= t.flashFrontDot) {
    fade = t.flashFrontFade;
    hold = t.flashFrontHold;
  } else if (x.dot >= t.flashSideDot) {
    fade = t.flashSideFade;
    hold = t.flashSideHold;
  } else {
    fade = t.flashBackFade;
    hold = t.flashBackHold;
    alpha = t.flashBackAlpha;
  }
  return { startTick: tick, holdSec: strength * hold, fadeSec: strength * fade, maxAlpha: alpha };
}

/** Screen white (0..1) of a blind at `tick`: maxAlpha through the hold, then linear to 0 at the end of the fade. */
export function flashAlpha(b: Blind, tick: number): number {
  const s = (tick - b.startTick) / TICK_RATE;
  if (s < 0) return 0;
  if (s <= b.holdSec) return b.maxAlpha;
  if (s >= b.fadeSec || b.fadeSec <= b.holdSec) return 0;
  return b.maxAlpha * (1 - (s - b.holdSec) / (b.fadeSec - b.holdSec));
}

/** Blind (for AI and the kill feed's blind kill) while the alpha is at least `flashBlindAlpha`. */
export function isBlind(b: Blind | null, tick: number, t: Pick<GrenadeCs2Tuning, 'flashBlindAlpha'>): boolean {
  return b !== null && flashAlpha(b, tick) >= t.flashBlindAlpha;
}

/** Combine a new flash with an existing one: keep whichever is whiter longer (the later end of the full-white hold). */
export function mergeBlind(old: Blind | null, next: Blind): Blind {
  if (old === null) return next;
  const oldHoldEnd = old.startTick + old.holdSec * TICK_RATE;
  const newHoldEnd = next.startTick + next.holdSec * TICK_RATE;
  return newHoldEnd >= oldHoldEnd ? next : old;
}
