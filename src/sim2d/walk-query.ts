/**
 * The 2D sim's WalkQuery implementations (src/contracts/walk.ts) for the Core.
 *
 * - `NavWalkQuery`: a line is walkable when the whole segment lies in the nav mesh's walkable space
 *   (`NavMesh.segmentWalkable`, 2D; z is ignored), and a path length is the 2D length of `NavMesh.path` (the route the
 *   LIVE AI walks), rounded to 6 decimals.
 * - `HullWalkQuery` (G3): with 3D movement, a line is walkable when a standing hull can sweep from `a` to `b` on the
 *   movement mesh (world + player clips), raised by a step so stairs and small steps don't count as walls
 *   (`hullLineClear`); paths are still the nav's (`pathLength` keeps NavWalkQuery's meaning).
 */
import { roundNumber, type Vec3, type WalkQuery } from '../contracts/index';
import { STANDING_HULL, TRACE_SKIN, type MapGeometry } from './geometry';
import { NavMesh } from './nav';

/** hullLineClear: a sweep that stops this close to its end (units) reaches it (the trace's skin is 1/32). */
const LINE_REACH = 0.125;

export class NavWalkQuery implements WalkQuery {
  private readonly nav: NavMesh;

  constructor(nav: NavMesh) {
    this.nav = nav;
  }

  isWalkableLine(a: Vec3, b: Vec3): boolean {
    return this.nav.segmentWalkable(a, b);
  }

  pathLength(a: Vec3, b: Vec3): number | null {
    const p = this.nav.path(a, b);
    return p === null ? null : roundNumber(NavMesh.pathLength(p));
  }
}

/**
 * Can a standing hull move in a straight line from feet position `a` to `b`? The hull is swept `step` units above the
 * line from `a` to `b` (stairs and small steps on the way pass under it; a climb steeper than that hits the obstacle),
 * or level at `a`'s height when `b` is lower (walking off a ledge); if that hits a low ceiling (a door's lintel), again
 * only 2 units up, then where the movement keeps a pawn (TRACE_SKIN above the floor). The line is clear if a sweep gets all the way. Pure (geometry queries only).
 */
export function hullLineClear(g: MapGeometry, a: Vec3, b: Vec3, step: number): boolean {
  const bz = Math.max(a.z, b.z);
  const len = Math.hypot(b.x - a.x, b.y - a.y, bz - a.z);
  for (const lift of [step, 2, TRACE_SKIN]) {
    const t = g.traceBox({ x: a.x, y: a.y, z: a.z + lift }, { x: b.x, y: b.y, z: bz + lift }, STANDING_HULL);
    // A target that touches a wall is reached when the sweep stops a skin short of it.
    if (!t.startSolid && (1 - t.fraction) * len <= LINE_REACH) return true;
  }
  return false;
}

export class HullWalkQuery implements WalkQuery {
  private readonly g: MapGeometry;
  private readonly navQuery: NavWalkQuery;
  private readonly step: number;

  /** @param step the movement's step height (`tuning.movement.stepSize`). */
  constructor(g: MapGeometry, nav: NavMesh, step: number) {
    this.g = g;
    this.navQuery = new NavWalkQuery(nav);
    this.step = step;
  }

  isWalkableLine(a: Vec3, b: Vec3): boolean {
    return hullLineClear(this.g, a, b, this.step);
  }

  pathLength(a: Vec3, b: Vec3): number | null {
    return this.navQuery.pathLength(a, b);
  }
}
