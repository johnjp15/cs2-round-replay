/**
 * Pawn-pawn collision for the 2D sim. Pawns are circles of `collision.pawnRadius` (16); a moving pawn may not
 * end its move overlapping a solid pawn. Solid = alive, and an enemy (teammates too only with
 * `collision.solidTeammates`, which matches the replay server's `mp_solid_teammates 0` when false). Dead pawns
 * are never solid.
 *
 * Sim2DHost moves pawns one at a time in id order, so a pawn collides with the new positions of the pawns
 * before it and the old positions of those after it (deterministic). Each move is first clamped by the nav
 * mesh (stepMove); collideMove then cuts it against the obstacles and slides along the first one touched,
 * like a wall slide. Pure functions; docs/combat.md, "Collision".
 */
import type { PlayerId, Vec3 } from '../contracts/index';
import type { NavPoint } from './nav';

/** Pull contact points this far (units) back along the move so they don't touch the obstacle. */
const BACKOFF = 0.01;
const EPS = 1e-6;

export interface Obstacle {
  readonly id: PlayerId;
  readonly x: number;
  readonly y: number;
}

/** Walkability, for checking the slide (NavMesh fits). */
export interface CollisionNav {
  isWalkable(p: NavPoint): boolean;
  clampMove(from: NavPoint, to: NavPoint): Vec3;
}

export interface CollideResult {
  readonly x: number;
  readonly y: number;
  /** The obstacle that changed the move (the first one hit, by distance then id), or null if it was free. */
  readonly blockedBy: PlayerId | null;
}

interface XY {
  readonly x: number;
  readonly y: number;
}

/**
 * First contact of a point moving from `p` by `d` (t in [0, 1]) with a circle of radius `r` around an
 * obstacle the point is not already inside. null = none.
 */
export function contactTime(p: XY, d: XY, o: XY, r: number): number | null {
  const fx = p.x - o.x;
  const fy = p.y - o.y;
  const a = d.x * d.x + d.y * d.y;
  if (a === 0) return null;
  const b = 2 * (d.x * fx + d.y * fy);
  if (b >= 0) return null; // not approaching
  const c = fx * fx + fy * fy - r * r;
  if (c < 0) return null; // already inside: handled separately
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

function dist(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * True if `q` is an allowed end point: at least `r` from every obstacle, or, for an obstacle the pawn already
 * overlapped at `from` (teleported into it), no closer than it was.
 */
export function validEnd(from: XY, q: XY, obstacles: readonly Obstacle[], r: number): boolean {
  for (const o of obstacles) {
    const dq = dist(q, o);
    if (dq >= r - EPS) continue;
    const df = dist(from, o);
    if (df < r - EPS && dq >= df - EPS) continue;
    return false;
  }
  return true;
}

/**
 * Cut the move `from` → `to` (already nav-clamped, so the segment is walkable) against obstacle circles.
 * Two solid pawns stay `2 × radius` apart. Candidates, first valid wins:
 * 1. `to` (no contact);
 * 2. the slide: move to the first contact, then along the obstacle's tangent with the rest of the move
 *    (the part pointing into it removed), nav-clamped from `from`;
 * 3. the contact point;
 * 4. `from` (no move).
 * An obstacle the pawn already overlaps only removes the part of the move pointing into it.
 * Obstacles are taken in the given order for ties (pass them sorted by id).
 */
export function collideMove(from: XY, to: XY, obstacles: readonly Obstacle[], radius: number, nav: CollisionNav | null): CollideResult {
  const r = 2 * radius;
  if (obstacles.length === 0 || (validEnd(from, to, obstacles, r) && !crosses(from, to, obstacles, r))) {
    return { x: to.x, y: to.y, blockedBy: null };
  }
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  let blockedBy: PlayerId | null = null;
  // Already overlapping: drop the inward part of the move.
  for (const o of obstacles) {
    const nx0 = from.x - o.x;
    const ny0 = from.y - o.y;
    const len = Math.hypot(nx0, ny0);
    if (!(len < r - EPS) || len === 0) continue;
    const nx = nx0 / len;
    const ny = ny0 / len;
    const dn = dx * nx + dy * ny;
    if (dn < 0) {
      dx -= dn * nx;
      dy -= dn * ny;
      blockedBy ??= o.id;
    }
  }
  // First contact along the (possibly reduced) move.
  let hitT: number | null = null;
  let hit: Obstacle | null = null;
  for (const o of obstacles) {
    const t = contactTime(from, { x: dx, y: dy }, o, r);
    if (t !== null && (hitT === null || t < hitT - EPS)) {
      hitT = t;
      hit = o;
    }
  }
  const cands: XY[] = [];
  if (hit === null || hitT === null) {
    cands.push(clampNav(from, { x: from.x + dx, y: from.y + dy }, nav));
  } else {
    blockedBy ??= hit.id;
    const len = Math.hypot(dx, dy);
    const tc = Math.max(0, hitT - BACKOFF / len);
    const contact = { x: from.x + tc * dx, y: from.y + tc * dy };
    const nx0 = contact.x - hit.x;
    const ny0 = contact.y - hit.y;
    const nl = Math.hypot(nx0, ny0);
    let rx = (1 - tc) * dx;
    let ry = (1 - tc) * dy;
    if (nl > 0) {
      const nx = nx0 / nl;
      const ny = ny0 / nl;
      const rn = rx * nx + ry * ny;
      if (rn < 0) {
        rx -= rn * nx;
        ry -= rn * ny;
      }
    }
    // The slide is cut at the next contact (no second slide).
    const t2 = firstContact(contact, { x: rx, y: ry }, obstacles, r);
    const s = t2 === null ? 1 : Math.max(0, t2 - BACKOFF / Math.max(Math.hypot(rx, ry), EPS));
    cands.push(clampNav(from, { x: contact.x + s * rx, y: contact.y + s * ry }, nav));
    cands.push(clampNav(from, contact, nav));
  }
  for (const c of cands) if (validEnd(from, c, obstacles, r)) return { x: c.x, y: c.y, blockedBy };
  return { x: from.x, y: from.y, blockedBy: blockedBy ?? (obstacles[0] as Obstacle).id };
}

/** True if the segment a → b enters an obstacle circle it did not start in. */
function crosses(a: XY, b: XY, obstacles: readonly Obstacle[], r: number): boolean {
  return firstContact(a, { x: b.x - a.x, y: b.y - a.y }, obstacles, r) !== null;
}

function firstContact(p: XY, d: XY, obstacles: readonly Obstacle[], r: number): number | null {
  let best: number | null = null;
  for (const o of obstacles) {
    const t = contactTime(p, d, o, r);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** The nav-clamped end of a straight move from `from` (the move as is without a nav or off the mesh). */
function clampNav(from: XY, to: XY, nav: CollisionNav | null): XY {
  if (nav === null || !nav.isWalkable(from)) return to;
  const c = nav.clampMove(from, to);
  return { x: c.x, y: c.y };
}
