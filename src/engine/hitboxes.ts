/**
 * H1: player hitboxes for the 3D host (src/sim3d) and any other host: a head sphere and capsules for the neck, chest,
 * stomach, arms and legs, posed from a pawn's feet position, yaw and posture, and the ray tests a hitscan bullet needs.
 * Pure (imports only src/contracts), deterministic (plain + − × ÷, sqrt, sin/cos of the yaw, in a fixed order).
 *
 * CS2's real hitboxes are capsules on the animated skeleton (`hitbox_set` in the player models). There is no
 * skeleton here, so the boxes are fixed to a standing / crouched rest pose sized to the Source hull (32 × 32 × 72
 * standing, 54 crouched) and to the heights the rest of the sim already uses for aim (`damage.bandHeights`: head 64 =
 * the eye, chest 48, stomach 36, leg 16), so a bot that aims at a band (src/sim2d/ai.ts `aimPitch`) hits that
 * band's box. Sizes (standing, units above the feet; `f` forward along the yaw, `l` to the left):
 *
 *   | box       | hitgroup | shape   | from (f, l, z)    | to (f, l, z)      | radius |
 *   |-----------|----------|---------|-------------------|-------------------|--------|
 *   | head      | head     | sphere  | (0, 0, 63)        |                   | 5      |
 *   | neck      | neck     | capsule | (0, 0, 55.5)      | (0, 0, 58)        | 3.5    |
 *   | chest     | chest    | capsule | (0, 5.5, 48.5)    | (0, −5.5, 48.5)   | 7      |
 *   | stomach   | stomach  | capsule | (0, 4, 35.5)      | (0, −4, 35.5)     | 6.5    |
 *   | arm_l     | arm      | capsule | (0, 11, 52)       | (12, 5, 41)       | 3      |
 *   | arm_r     | arm      | capsule | (0, −11, 52)      | (12, −5, 41)      | 3      |
 *   | leg_l     | leg      | capsule | (0, 4, 29)        | (0, 4.5, 3)       | 4.5    |
 *   | leg_r     | leg      | capsule | (0, −4, 29)       | (0, −4.5, 3)      | 4.5    |
 *
 * The body spans z 0.5–68 and ±15.5 in width (inside the hull). Crouched, every z is scaled by
 * crouchEyeHeight / eyeHeight (46 / 64), as the bands are (src/sim2d/hitscan.ts `bandHeight`), so the head is at the
 * crouched eye (45.3). The boxes overlap a little where the body parts meet; a ray takes the box it enters first
 * (ties: table order, head first). Approximations against CS2: no animation (the arms don't follow the gun, legs
 * don't stride, no lean while strafing), and the head is a sphere rather than CS2's short capsule.
 */
import type { Hitgroup, Vec3 } from '../contracts/index';

/** One hitbox in a pawn's local frame (standing). A sphere has `a` = `b`. */
export interface HitboxDef {
  readonly name: string;
  readonly group: Hitgroup;
  /** Forward (along the yaw), left, up from the feet. */
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly radius: number;
}

/** The standing hitbox set (see the table above), in test order. */
export const HITBOXES: readonly HitboxDef[] = [
  { name: 'head', group: 'head', a: [0, 0, 63], b: [0, 0, 63], radius: 5 },
  { name: 'neck', group: 'neck', a: [0, 0, 55.5], b: [0, 0, 58], radius: 3.5 },
  { name: 'chest', group: 'chest', a: [0, 5.5, 48.5], b: [0, -5.5, 48.5], radius: 7 },
  { name: 'stomach', group: 'stomach', a: [0, 4, 35.5], b: [0, -4, 35.5], radius: 6.5 },
  { name: 'arm_l', group: 'arm', a: [0, 11, 52], b: [12, 5, 41], radius: 3 },
  { name: 'arm_r', group: 'arm', a: [0, -11, 52], b: [12, -5, 41], radius: 3 },
  { name: 'leg_l', group: 'leg', a: [0, 4, 29], b: [0, 4.5, 3], radius: 4.5 },
  { name: 'leg_r', group: 'leg', a: [0, -4, 29], b: [0, -4.5, 3], radius: 4.5 },
];

/** Eye heights the crouched scale uses (`damage.eyeHeight`, `damage.crouchEyeHeight`). */
export interface HitboxScale {
  readonly eyeHeight: number;
  readonly crouchEyeHeight: number;
}

/** A pawn as the hitboxes see it. */
export interface HitboxPose {
  readonly pos: Vec3;
  readonly yaw: number;
  readonly crouching: boolean;
}

/** A hitbox in world space. */
export interface Hitbox {
  readonly name: string;
  readonly group: Hitgroup;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
}

/** No hitbox reaches further than this from the body axis (units, 2D) or above this height (standing): broad phase. */
export const HITBOX_REACH = 17;
export const HITBOX_TOP = 68;

const DEG = Math.PI / 180;

/** The pose's hitboxes in world space, in HITBOXES order. */
export function poseHitboxes(p: HitboxPose, s: HitboxScale): Hitbox[] {
  const c = Math.cos(p.yaw * DEG);
  const sn = Math.sin(p.yaw * DEG);
  const k = p.crouching ? s.crouchEyeHeight / s.eyeHeight : 1;
  const at = (q: readonly [number, number, number]): Vec3 => ({
    // forward = (c, sn), left = (−sn, c)
    x: p.pos.x + q[0] * c - q[1] * sn,
    y: p.pos.y + q[0] * sn + q[1] * c,
    z: p.pos.z + q[2] * k,
  });
  return HITBOXES.map((h) => ({ name: h.name, group: h.group, a: at(h.a), b: at(h.b), radius: h.radius }));
}

/**
 * Distance along the ray o + t·d (d a unit vector) at which it enters the capsule (segment a–b, radius r), or null
 * when it misses or the entry is beyond `maxT`. A ray starting inside enters at 0.
 */
export function rayCapsule(o: Vec3, d: Vec3, maxT: number, a: Vec3, b: Vec3, r: number): number | null {
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const baz = b.z - a.z;
  const oax = o.x - a.x;
  const oay = o.y - a.y;
  const oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  if (baba === 0) return raySphere(o, d, maxT, a, r);
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  // Infinite cylinder around a–b, then the end caps (Inigo Quilez's capsule intersection).
  const qa = baba - bard * bard;
  const qb = baba * rdoa - baoa * bard;
  const qc = baba * oaoa - baoa * baoa - r * r * baba;
  let best: number | null = null;
  if (qa > 0) {
    const h = qb * qb - qa * qc;
    if (h >= 0) {
      const t = (-qb - Math.sqrt(h)) / qa;
      const y = baoa + t * bard;
      if (y > 0 && y < baba) best = t;
    }
  }
  if (best === null) {
    const ta = raySphere(o, d, Infinity, a, r);
    const tb = raySphere(o, d, Infinity, b, r);
    if (ta !== null) best = ta;
    if (tb !== null && (best === null || tb < best)) best = tb;
  }
  if (best === null) return null;
  if (best < 0) {
    // Behind the origin: inside the capsule only if the origin is within r of the segment.
    const tSeg = Math.max(0, Math.min(1, baoa / baba));
    const px = oax - bax * tSeg;
    const py = oay - bay * tSeg;
    const pz = oaz - baz * tSeg;
    if (px * px + py * py + pz * pz > r * r) return null;
    best = 0;
  }
  return best <= maxT ? best : null;
}

/** Entry distance of the ray o + t·d (unit d) into the sphere (c, r), or null (beyond maxT or a miss; behind the origin: null unless inside). */
export function raySphere(o: Vec3, d: Vec3, maxT: number, c: Vec3, r: number): number | null {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return null;
  const sq = Math.sqrt(h);
  let t = -b - sq;
  if (t < 0) {
    if (-b + sq < 0) return null;
    t = 0;
  }
  return t <= maxT ? t : null;
}

/** The first hitbox of `pose` the ray enters within `maxT`, with its distance, or null. */
export function rayHitboxes(o: Vec3, d: Vec3, maxT: number, pose: HitboxPose, s: HitboxScale): { readonly box: Hitbox; readonly t: number } | null {
  // Broad phase: the ray's closest 2D approach to the body axis.
  const ex = pose.pos.x - o.x;
  const ey = pose.pos.y - o.y;
  const h2 = d.x * d.x + d.y * d.y;
  if (h2 > 0) {
    const along = Math.max(0, (ex * d.x + ey * d.y) / h2);
    const px = ex - d.x * along;
    const py = ey - d.y * along;
    if (px * px + py * py > HITBOX_REACH * HITBOX_REACH) return null;
  } else if (ex * ex + ey * ey > HITBOX_REACH * HITBOX_REACH) return null;
  let best: { box: Hitbox; t: number } | null = null;
  for (const box of poseHitboxes(pose, s)) {
    const t = rayCapsule(o, d, maxT, box.a, box.b, box.radius);
    if (t !== null && (best === null || t < best.t)) best = { box, t };
  }
  return best;
}

/** Unit view direction for Source angles (degrees; yaw counter-clockwise from +x, pitch positive = down). */
export function viewDir(yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw * DEG);
  const sy = Math.sin(yaw * DEG);
  const cp = Math.cos(pitch * DEG);
  const sp = Math.sin(pitch * DEG);
  return { x: cp * cy, y: cp * sy, z: -sp };
}

/** Source angles (yaw, pitch in degrees) looking from `from` to `to` (yaw 0 for a vertical line). */
export function anglesTo(from: Vec3, to: Vec3): { readonly yaw: number; readonly pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const flat = Math.sqrt(dx * dx + dy * dy);
  return { yaw: flat === 0 ? 0 : Math.atan2(dy, dx) / DEG, pitch: -Math.atan2(dz, flat) / DEG };
}
