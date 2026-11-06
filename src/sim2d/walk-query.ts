/**
 * NavWalkQuery: the 2D sim's WalkQuery (src/contracts/walk.ts) for the Core: a line is walkable when the whole
 * segment lies in the nav mesh's walkable space (`NavMesh.segmentWalkable`, 2D; z is ignored), and a path length is
 * the 2D length of `NavMesh.path` (the route the LIVE AI walks), rounded to 6 decimals.
 */
import { roundNumber, type Vec3, type WalkQuery } from '../contracts/index';
import { NavMesh } from './nav';

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
