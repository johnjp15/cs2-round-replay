/**
 * Hitscan for the 2D sim. A bullet is a ray from the shooter's eye along `yaw`. In 2D it hits the first
 * enemy whose circle (`damage.pawnRadius`) it crosses with nav line of sight to the impact point; the
 * hitgroup comes from `pitch`: the band (head, chest, stomach, leg) whose aim pitch is closest to the
 * shooter's pitch, within `damage.hitToleranceDeg`, else the bullet passes over or under that pawn and
 * flies on. Bullets ignore smoke. Pitch is Source's: degrees, positive = looking down. docs/combat.md.
 */
import { roundNumber, type DamageTuning, type PlayerId, type Team, type Vec3 } from '../contracts/index';
import type { NavPoint } from './nav';

const DEG = 180 / Math.PI;

/** Aim bands hitscan picks from, top to bottom (ties go to the first). */
export const AIM_BANDS = ['head', 'chest', 'stomach', 'leg'] as const;
export type AimBand = (typeof AIM_BANDS)[number];

/** What hitscan needs to know about a pawn. */
export interface ScanPawn {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
  readonly alive: boolean;
}

/** The nav query hitscan uses (NavMesh fits). */
export interface LosQuery {
  lineOfSight(a: NavPoint, b: NavPoint): boolean;
}

export interface ShotHit {
  readonly victim: PlayerId;
  readonly hitgroup: AimBand;
  /** 3D distance from the shooter's eye to the band's aim point (for range falloff). */
  readonly distance: number;
  /** Where the ray enters the victim's circle (2D; z = aim point height). */
  readonly impact: Vec3;
}

/** Eye height above pos.z. */
export function eyeHeight(crouching: boolean, d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>): number {
  return crouching ? d.crouchEyeHeight : d.eyeHeight;
}

/** Height of a band above pos.z; crouched targets scale by crouchEyeHeight / eyeHeight. */
export function bandHeight(band: AimBand, crouching: boolean, d: Pick<DamageTuning, 'bandHeights' | 'eyeHeight' | 'crouchEyeHeight'>): number {
  const h = d.bandHeights[band] ?? 0;
  return crouching ? (h * d.crouchEyeHeight) / d.eyeHeight : h;
}

type Body = Pick<ScanPawn, 'pos' | 'crouching'>;

/**
 * The pitch (Source: positive = down, degrees, rounded to 6 decimals) at which `from`'s eye looks at
 * `band` of `to`. This is what Core sets to aim at the head, chest, … of a target.
 */
export function aimPitch(from: Body, to: Body, band: AimBand, d: DamageTuning): number {
  const dist = Math.hypot(to.pos.x - from.pos.x, to.pos.y - from.pos.y);
  const dz = to.pos.z + bandHeight(band, to.crouching, d) - (from.pos.z + eyeHeight(from.crouching, d));
  return roundNumber(-Math.atan2(dz, dist) * DEG);
}

/** The band whose aim pitch is closest to `pitch`, or null if none is within hitToleranceDeg. */
export function pickBand(pitch: number, from: Body, to: Body, d: DamageTuning): AimBand | null {
  let best: AimBand | null = null;
  let bestErr = Infinity;
  for (const band of AIM_BANDS) {
    const err = roundNumber(Math.abs(pitch - aimPitch(from, to, band, d)));
    if (err < bestErr) {
      best = band;
      bestErr = err;
    }
  }
  return bestErr <= d.hitToleranceDeg ? best : null;
}

/**
 * Trace one bullet from `shooter` through `pawns` (any order; candidates are taken by ray distance, then
 * id). Skips the shooter, dead pawns and (friendly fire off) teammates. Returns the first pawn hit, or
 * null. A pawn the ray crosses but `nav.lineOfSight(shooter, impact)` rejects is behind a wall, and so is
 * everything further along the ray.
 */
export function traceShot(shooter: ScanPawn, pawns: readonly ScanPawn[], nav: LosQuery, d: DamageTuning): ShotHit | null {
  const rad = shooter.yaw / DEG;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const r2 = d.pawnRadius * d.pawnRadius;
  const cands: { p: ScanPawn; enter: number }[] = [];
  for (const p of pawns) {
    if (p.id === shooter.id || !p.alive) continue;
    if (!d.friendlyFire && p.team === shooter.team) continue;
    const cx = p.pos.x - shooter.pos.x;
    const cy = p.pos.y - shooter.pos.y;
    const along = cx * dx + cy * dy;
    const dist2 = cx * cx + cy * cy;
    const perp2 = Math.max(0, dist2 - along * along);
    if (perp2 > r2) continue;
    let enter: number;
    if (dist2 <= r2) enter = 0;
    else if (along <= 0) continue;
    else enter = along - Math.sqrt(r2 - perp2);
    if (enter > d.maxRange) continue;
    cands.push({ p, enter: roundNumber(enter) });
  }
  cands.sort((a, b) => a.enter - b.enter || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
  const eyeZ = shooter.pos.z + eyeHeight(shooter.crouching, d);
  for (const c of cands) {
    const impact2 = { x: shooter.pos.x + dx * c.enter, y: shooter.pos.y + dy * c.enter };
    if (!nav.lineOfSight(shooter.pos, impact2)) break;
    const band = pickBand(shooter.pitch, shooter, c.p, d);
    if (band === null) continue;
    const flat = Math.hypot(c.p.pos.x - shooter.pos.x, c.p.pos.y - shooter.pos.y);
    const aimZ = c.p.pos.z + bandHeight(band, c.p.crouching, d);
    return {
      victim: c.p.id,
      hitgroup: band,
      distance: roundNumber(Math.hypot(flat, aimZ - eyeZ)),
      impact: { x: roundNumber(impact2.x), y: roundNumber(impact2.y), z: roundNumber(aimZ) },
    };
  }
  return null;
}
