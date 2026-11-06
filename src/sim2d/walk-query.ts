/**
 * NavWalkQuery: the 2D sim's WalkQuery (src/contracts/walk.ts) for the Core's puppet
 * controller: a line is walkable when the whole segment lies in the nav mesh's
 * walkable space (`NavMesh.segmentWalkable`, 2D; z is ignored).
 */
import type { Vec3, WalkQuery } from '../contracts/index';
import type { NavMesh } from './nav';

export class NavWalkQuery implements WalkQuery {
  private readonly nav: NavMesh;

  constructor(nav: NavMesh) {
    this.nav = nav;
  }

  isWalkableLine(a: Vec3, b: Vec3): boolean {
    return this.nav.segmentWalkable(a, b);
  }
}
