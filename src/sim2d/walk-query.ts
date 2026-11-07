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
import { NavMesh, areaZ, type Nav3d, type NavArea, type NavPortal } from './nav';

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

/** nav3dFor: crossing points along a portal (every this many units), and how far into each area the hull starts and ends. */
const PORTAL_STEP = 8;
/** A drop portal's landing check looks this far down (units; past the nav's dropHeight). */
const LAND_SEARCH = 512;
const PORTAL_DEPTHS: readonly number[] = [20, 32];

/**
 * G3: the nav's 3D hooks (`NavMesh.with3d`). `crossing` keeps level portals as they are (the movement slides along
 * CS2's walls and the AI replans when stuck) and tests each drop portal (`to` lower by more than a step at its ends
 * and middle) every PORTAL_STEP units along it: a standing hull, free at a CS2 floor a little inside `from`, must
 * walk off toward a point a little inside `to` in a straight line (`hullLineClear`, level at the start's height). The
 * portal becomes the longest run of such points (its midpoint is where paths cross), or is dropped when there are
 * none. The 2020 nav knows nothing of CS2's walls at its ledges: B Apartments' window over B site, for one, is a wall
 * with a sill 20 units up (a jump) where the 2020 nav drops onto an awning; the Balcony's open edge to the west is
 * the way down. `line` is `hullLineClear` (path smoothing and `segmentWalkable`); `free` is "a standing hull fits on
 * the CS2 floor there" (`NavMesh` moves a portal's crossing point off CS2's walls with it).
 */
export function nav3dFor(g: MapGeometry, step: number): Nav3d {
  // Paths are pulled through the same portal midpoints again and again (a LIVE pawn repaths to the same goal): the
  // answers are pure, so they are kept (by exact endpoints; a few thousand at most in a round).
  const lines = new Map<string, boolean>();
  return {
    line: (a, b) => {
      const k = `${a.x},${a.y},${a.z},${b.x},${b.y},${b.z}`;
      let v = lines.get(k);
      if (v === undefined) {
        v = hullLineClear(g, a, b, step);
        lines.set(k, v);
      }
      return v;
    },
    crossing: (from, to, p) => portalCrossing(g, step, from, to, p),
    free: (p) => !g.hullBlocked(p.x, p.y, floorNear(g, p.x, p.y, p.z), STANDING_HULL),
  };
}

function portalCrossing(g: MapGeometry, step: number, from: NavArea, to: NavArea, p: NavPortal): NavPortal | null {
  // Level portals keep the 2D nav's meaning (the movement slides along CS2's walls and the AI replans when stuck);
  // only drops (to lower by more than a step everywhere) are where the two maps disagree in ways the AI can't recover
  // from: walking off a ledge that CS2 walls in, or toward a drop that isn't there.
  if (!isDrop(from, to, p, step)) return p;
  const dx = p.bx - p.ax;
  const dy = p.by - p.ay;
  const len = Math.hypot(dx, dy);
  // Direction from `from` into `to`: across the portal segment, or centre to centre for an overlap (a point portal).
  let nx = len > 0 ? -dy / len : (to.x1 + to.x2 - from.x1 - from.x2) / 2;
  let ny = len > 0 ? dx / len : (to.y1 + to.y2 - from.y1 - from.y2) / 2;
  const cx = (from.x1 + from.x2) / 2;
  const cy = (from.y1 + from.y2) / 2;
  if (len > 0 && nx * (p.mx - cx) + ny * (p.my - cy) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const nl = Math.hypot(nx, ny);
  if (nl === 0) return p;
  nx /= nl;
  ny /= nl;
  const n = Math.max(1, Math.round(len / PORTAL_STEP));
  let bestLo = -1;
  let bestHi = -1;
  let runLo = -1;
  for (let k = 0; k <= n; k++) {
    const f = len > 0 ? k / n : 0.5;
    const px = p.ax + dx * f;
    const py = p.ay + dy * f;
    let clear = false;
    for (const d of PORTAL_DEPTHS) {
      const ax = clampTo(px - nx * d, from.x1, from.x2);
      const ay = clampTo(py - ny * d, from.y1, from.y2);
      const bx = clampTo(px + nx * d, to.x1, to.x2);
      const by = clampTo(py + ny * d, to.y1, to.y2);
      const a = { x: ax, y: ay, z: floorNear(g, ax, ay, areaZ(from, ax, ay)) };
      const b = { x: bx, y: by, z: floorNear(g, bx, by, areaZ(to, bx, by)) };
      // Only the start must be free: the sweep runs at the higher end's height, so a 2020 area with no CS2 floor at
      // its height (b inside something) fails the sweep or, for a drop, is fallen past.
      if (g.hullBlocked(a.x, a.y, a.z, STANDING_HULL)) continue;
      // A drop must land on `to`'s floor: the floor under b seen from the start's height is b's, not a higher one the
      // hull would walk on instead (a 2020 drop where CS2 has floor over the lower level).
      const land = g.floorBelow(b.x, b.y, a.z + step, STANDING_HULL.halfWidth, 0, LAND_SEARCH);
      if (land === null || land.z > b.z + step) continue;
      if (hullLineClear(g, a, b, step)) {
        clear = true;
        break;
      }
    }
    if (clear) {
      if (runLo < 0) runLo = k;
      if (bestLo < 0 || k - runLo > bestHi - bestLo) {
        bestLo = runLo;
        bestHi = k;
      }
    } else {
      runLo = -1;
    }
    if (len === 0) break;
  }
  if (bestLo < 0) return null;
  if (len === 0) return p;
  const ax = p.ax + (dx * bestLo) / n;
  const ay = p.ay + (dy * bestLo) / n;
  const bx = p.ax + (dx * bestHi) / n;
  const by = p.ay + (dy * bestHi) / n;
  return { to: p.to, ax, ay, bx, by, mx: (ax + bx) / 2, my: (ay + by) / 2 };
}

function isDrop(from: NavArea, to: NavArea, p: NavPortal, step: number): boolean {
  for (const [x, y] of [[p.ax, p.ay], [p.mx, p.my], [p.bx, p.by]] as const) {
    const za = areaZ(from, clampTo(x, from.x1, from.x2), clampTo(y, from.y1, from.y2));
    const zb = areaZ(to, clampTo(x, to.x1, to.x2), clampTo(y, to.y1, to.y2));
    if (za - zb <= step) return false;
  }
  return true;
}

/** The CS2 floor under the hull near a 2020 nav height (which is off by up to ~27 on stairs), a skin above it. */
function floorNear(g: MapGeometry, x: number, y: number, z: number): number {
  const f = g.floorBelow(x, y, z + 32, STANDING_HULL.halfWidth, 0, 64);
  return (f === null ? z : f.z) + TRACE_SKIN;
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
