/**
 * Mirage nav mesh for the 2D sim: walkability, height, place names, adjacency, A* paths with
 * string pulling, line of sight and wall-sliding movement clamps. Pure and deterministic (no DOM,
 * no randomness, no object-key iteration). Built from data/mirage-nav.json; see docs/nav.md.
 */
import type { NavTuning, Tuning, Vec3 } from '../contracts/index';
import { RectGrid, rectContains, type Rect } from './nav-grid';

/**
 * Input position: the shared contracts `Vec3`, with `z` optional (without it, stacked-area lookups
 * ignore height). Any `Vec3` is a `NavPoint`.
 */
export type NavPoint = Pick<Vec3, 'x' | 'y'> & Partial<Pick<Vec3, 'z'>>;

/** Output position: a contracts `Vec3` that always carries the nav-mesh height. */
export type NavPos = Vec3;

/**
 * One nav area: axis-aligned rectangle with heights z1 at corner (x1, y1) and z2 at corner (x2, y2);
 * the height varies linearly along that diagonal (verified against recorded player heights).
 */
export interface NavArea {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z1: number;
  z2: number;
  /** Index into `places`. */
  place: number;
}

export interface NavData {
  places: string[];
  areas: NavArea[];
}

/** Tunables: the `nav` section of data/tuning.json (`Tuning.nav`). */
export type NavOptions = NavTuning;

/** A connection between two neighbouring areas: the shared edge segment (degenerate for overlaps). */
export interface NavPortal {
  /** Neighbour area id. */
  to: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Midpoint of the portal. */
  mx: number;
  my: number;
}

/**
 * G3: how 3D movement changes the nav (implemented in walk-query.ts, `nav3dFor`): `crossing` narrows a portal to where a
 * standing hull can cross it on the CS2 mesh, or drops it (null); `line` is a hull's walkable straight line.
 */
export interface Nav3d {
  crossing(from: NavArea, to: NavArea, p: NavPortal): NavPortal | null;
  line(a: Vec3, b: Vec3): boolean;
  /** A standing hull fits on the CS2 floor near (x, y, z). */
  free(p: Vec3): boolean;
}

/**
 * G3: the point paths cross a portal at (its midpoint), moved along the portal to the nearest spot where a standing
 * hull fits on the CS2 mesh when the midpoint is in a CS2 wall or prop (FREE_STEP apart, from the middle out); as it
 * was if there is none. A path through the 2020 nav's corridor points otherwise steers a LIVE pawn into the wall a
 * CS2 corridor has where the 2020 one hadn't (B short, the Apartments).
 */
function freeMidpoint(nav3d: Nav3d, from: NavArea, p: NavPortal): NavPortal {
  const at = (x: number, y: number): Vec3 => ({ x, y, z: areaZ(from, clamp(x, from.x1, from.x2), clamp(y, from.y1, from.y2)) });
  if (nav3d.free(at(p.mx, p.my))) return p;
  const len = Math.hypot(p.bx - p.ax, p.by - p.ay);
  if (len === 0) return p;
  const ux = (p.bx - p.ax) / len;
  const uy = (p.by - p.ay) / len;
  for (let d = FREE_STEP; d <= len / 2 + 1e-9; d += FREE_STEP) {
    for (const sgn of [1, -1]) {
      const x = p.mx + ux * d * sgn;
      const y = p.my + uy * d * sgn;
      if (nav3d.free(at(x, y))) return { ...p, mx: x, my: y };
    }
  }
  return p;
}

/** `freeMidpoint`'s search step along a portal (units). */
const FREE_STEP = 4;

/** G3 `gapDrops`: how far across a gap (units) a drop portal the 2020 nav lacks may reach. */
const GAP_DROP_REACH = 64;

export class NavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavError';
  }
}

const GRID_CELL = 100;
/** Pull clamped/prefix points this far (units) back inside so they are walkable despite rounding. */
const BACKOFF = 0.01;

export class NavMesh {
  readonly places: readonly string[];
  /** Areas indexed by id (ids are 0..n-1). */
  readonly areas: readonly NavArea[];
  readonly options: NavOptions;
  /** portals[id] = connections to neighbours, ascending by neighbour id. */
  readonly portals: readonly (readonly NavPortal[])[];
  /** Exact area rectangles (areaAt). */
  private readonly areaGrid: RectGrid;
  /** Areas grown by edgeEpsilon/2 (walkable space). */
  private readonly walkGrid: RectGrid;
  /** Areas grown by losMargin (line-of-sight space). */
  private readonly losGrid: RectGrid;

  /** G3: the 3D movement's hooks (`nav3dFor` in walk-query.ts), or null for the plain 2D mesh. */
  readonly nav3d: Nav3d | null;

  /**
   * @param nav3d G3: with 3D movement, portals narrowed to where a hull crosses them on the CS2 mesh (or dropped), and
   *   a hull line test for path smoothing and the AI's walkable lines; null = the 2D mesh as built.
   */
  constructor(data: NavData, options: NavOptions, nav3d: Nav3d | null = null) {
    const areas = [...data.areas].sort((a, b) => a.id - b.id);
    areas.forEach((a, i) => {
      if (a.id !== i) throw new NavError(`area ids must be 0..n-1, found ${a.id} at position ${i}`);
      if (!(a.x1 < a.x2) || !(a.y1 < a.y2)) throw new NavError(`area ${a.id}: expected x1<x2 and y1<y2`);
      if (a.place < 0 || a.place >= data.places.length) throw new NavError(`area ${a.id}: bad place ${a.place}`);
    });
    this.places = [...data.places];
    this.areas = areas;
    this.options = { stepHeight: options.stepHeight, edgeEpsilon: options.edgeEpsilon, losMargin: options.losMargin, dropHeight: options.dropHeight };
    this.areaGrid = new RectGrid(areas, GRID_CELL);
    this.walkGrid = new RectGrid(areas.map((a) => grow(a, options.edgeEpsilon / 2)), GRID_CELL);
    this.losGrid = new RectGrid(areas.map((a) => grow(a, options.losMargin)), GRID_CELL);
    this.nav3d = nav3d;
    this.portals = areas.map((a) => {
      const built = this.buildPortals(a);
      if (nav3d === null) return built;
      const out: NavPortal[] = [];
      for (const p of built) {
        const q = nav3d.crossing(a, areas[p.to] as NavArea, p);
        if (q !== null) out.push(freeMidpoint(nav3d, a, q));
      }
      for (const p of this.gapDrops(a, built)) {
        const q = nav3d.crossing(a, areas[p.to] as NavArea, p);
        if (q !== null) out.push(freeMidpoint(nav3d, a, q));
      }
      return out;
    });
  }

  /**
   * G3: drop portals the 2020 nav doesn't have: to an area within GAP_DROP_REACH of a's side across a gap (a ledge's
   * lip, a railing's thin 2020 areas between), lower by more than a step and at most dropHeight all along, overlapping
   * the side by more than edgeEpsilon. The portal is a's side where they overlap; with 3D hooks `crossing` keeps only
   * where a hull walks off there on the CS2 mesh (B Apartments' Balcony: the drop to B site at its west end).
   */
  private gapDrops(a: NavArea, built: readonly NavPortal[]): NavPortal[] {
    const eps = this.options.edgeEpsilon;
    const r = GAP_DROP_REACH;
    const out: NavPortal[] = [];
    for (const j of this.areaGrid.query(a.x1 - r, a.y1 - r, a.x2 + r, a.y2 + r)) {
      if (j === a.id || built.some((p) => p.to === j)) continue;
      const b = this.areas[j] as NavArea;
      const ox1 = Math.max(a.x1, b.x1);
      const ox2 = Math.min(a.x2, b.x2);
      const oy1 = Math.max(a.y1, b.y1);
      const oy2 = Math.min(a.y2, b.y2);
      let seg: [number, number, number, number] | null = null;
      if (ox2 - ox1 > eps && b.y2 < a.y1 - eps && a.y1 - b.y2 <= r) seg = [ox1, a.y1, ox2, a.y1];
      else if (ox2 - ox1 > eps && b.y1 > a.y2 + eps && b.y1 - a.y2 <= r) seg = [ox1, a.y2, ox2, a.y2];
      else if (oy2 - oy1 > eps && b.x2 < a.x1 - eps && a.x1 - b.x2 <= r) seg = [a.x1, oy1, a.x1, oy2];
      else if (oy2 - oy1 > eps && b.x1 > a.x2 + eps && b.x1 - a.x2 <= r) seg = [a.x2, oy1, a.x2, oy2];
      if (seg === null) continue;
      let ok = true;
      for (const f of [0, 0.5, 1]) {
        const x = seg[0] + (seg[2] - seg[0]) * f;
        const y = seg[1] + (seg[3] - seg[1]) * f;
        const drop = areaZ(a, x, y) - areaZ(b, clamp(x, b.x1, b.x2), clamp(y, b.y1, b.y2));
        if (!(drop > this.options.stepHeight && drop <= this.options.dropHeight)) ok = false;
      }
      if (ok) out.push({ to: b.id, ax: seg[0], ay: seg[1], bx: seg[2], by: seg[3], mx: (seg[0] + seg[2]) / 2, my: (seg[1] + seg[3]) / 2 });
    }
    return out;
  }

  /** The same mesh with 3D hooks (G3). */
  with3d(nav3d: Nav3d): NavMesh {
    return new NavMesh({ places: [...this.places], areas: [...this.areas] }, this.options, nav3d);
  }

  /** Build from parsed data/mirage-nav.json (validated). */
  static fromJson(json: unknown, options: NavOptions): NavMesh {
    const root = asObject(json, 'nav');
    const places = root['places'];
    if (!Array.isArray(places) || !places.every((p) => typeof p === 'string')) throw new NavError('nav.places: expected string[]');
    const rawAreas = root['areas'];
    if (!Array.isArray(rawAreas)) throw new NavError('nav.areas: expected an array');
    const areas = rawAreas.map((v: unknown, i): NavArea => {
      const o = asObject(v, `nav.areas[${i}]`);
      const n = (k: string): number => {
        const x = o[k];
        if (typeof x !== 'number' || !Number.isFinite(x)) throw new NavError(`nav.areas[${i}].${k}: expected a finite number`);
        return x;
      };
      return { id: n('id'), x1: n('x1'), y1: n('y1'), x2: n('x2'), y2: n('y2'), z1: n('z1'), z2: n('z2'), place: n('place') };
    });
    return new NavMesh({ places: places as string[], areas }, options);
  }

  // ---- point queries -------------------------------------------------------------------------

  /** Area containing p (inclusive edges). With several (stacked levels), the one closest in z to p.z, else the lowest id. */
  areaAt(p: NavPoint): NavArea | null {
    let best: NavArea | null = null;
    let bestDz = Infinity;
    for (const i of this.areaGrid.candidates(p.x, p.y)) {
      const a = this.areas[i] as NavArea;
      if (!rectContains(a, p.x, p.y)) continue;
      const dz = p.z === undefined ? 0 : Math.abs(areaZ(a, p.x, p.y) - p.z);
      if (best === null || dz < bestDz) {
        best = a;
        bestDz = dz;
      }
    }
    return best;
  }

  /** Area nearest to p in 2D (0 if inside); ties broken by z distance to p.z, then lowest id. */
  nearestArea(p: NavPoint): NavArea {
    const inside = this.areaAt(p);
    if (inside !== null) return inside;
    let best = this.areas[0] as NavArea;
    let bestD = Infinity;
    let bestDz = Infinity;
    for (const a of this.areas) {
      const d = rectDistance(a, p.x, p.y);
      const dz = p.z === undefined ? 0 : Math.abs(areaZ(a, clamp(p.x, a.x1, a.x2), clamp(p.y, a.y1, a.y2)) - p.z);
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && dz < bestDz)) {
        best = a;
        bestD = d;
        bestDz = dz;
      }
    }
    return best;
  }

  /**
   * Floor heights of every area containing (x, y) (exact rectangles, inclusive edges), ascending. More than one
   * where levels are stacked (Catwalk over the Tunnel). Used by vision's level check (C4). Allocates.
   */
  floorsAt(x: number, y: number): number[] {
    const out: number[] = [];
    for (const i of this.areaGrid.candidates(x, y)) {
      const a = this.areas[i] as NavArea;
      if (rectContains(a, x, y)) out.push(areaZ(a, x, y));
    }
    return out.sort((p, q) => p - q);
  }

  /** True if p lies in walkable space (the union of areas, each grown by edgeEpsilon/2). */
  isWalkable(p: NavPoint): boolean {
    return this.walkGrid.contains(p.x, p.y);
  }

  /** Floor height at p: linear along the area's (x1,y1)→(x2,y2) diagonal; nearest area if p is off-mesh. */
  zAt(p: NavPoint): number {
    const a = this.areaAt(p) ?? this.nearestArea(p);
    return areaZ(a, clamp(p.x, a.x1, a.x2), clamp(p.y, a.y1, a.y2));
  }

  /** Place name at p ("" for unnamed areas); nearest area if p is off-mesh. */
  placeName(p: NavPoint): string {
    const a = this.areaAt(p) ?? this.nearestArea(p);
    return this.places[a.place] ?? '';
  }

  /** Neighbour ids of an area, ascending. */
  neighbours(id: number): number[] {
    return (this.portals[id] ?? []).map((q) => q.to);
  }

  // ---- segment queries -----------------------------------------------------------------------

  /**
   * True if the whole segment a→b lies in walkable space. G3: with 3D hooks, and if a hull can walk it on the CS2 mesh
   * (heights from the nav where a point has none).
   */
  segmentWalkable(a: NavPoint, b: NavPoint): boolean {
    const flat = this.walkGrid.coverage(a.x, a.y, b.x, b.y) >= 1;
    // G3: the 2D test first (cheap, and a line the 2020 nav has no floor under is no shortcut to take), then the hull.
    if (this.nav3d !== null) return flat && this.nav3d.line(this.withZ(a), this.withZ(b));
    return flat;
  }

  private withZ(p: NavPoint): Vec3 {
    return p.z === undefined ? { x: p.x, y: p.y, z: this.zAt(p) } : { x: p.x, y: p.y, z: p.z };
  }

  /**
   * 2D line of sight: the segment a→b stays within losMargin of walkable space. Exact (clips against
   * rectangle edges, no sampling). Approximation: everything that is not walkable is a full-height wall.
   */
  lineOfSight(a: NavPoint, b: NavPoint): boolean {
    return this.losGrid.coverage(a.x, a.y, b.x, b.y) >= 1;
  }

  /**
   * Move from → to as far as walkable space allows, sliding along walls. If the full move is blocked,
   * the candidates are the x-only slide, the y-only slide and the longest walkable prefix of the
   * direct move (each itself cut to its longest walkable prefix); the one ending nearest `to` wins
   * (ties: x, then y, then direct). If `from` is not walkable, returns `from` unchanged.
   */
  clampMove(from: NavPoint, to: NavPoint): Vec3 {
    if (!this.isWalkable(from)) return this.pos(from.x, from.y, from);
    if (this.segmentWalkable(from, to)) return this.pos(to.x, to.y, to);
    const cands: [number, number][] = [
      this.prefix(from.x, from.y, to.x, from.y),
      this.prefix(from.x, from.y, from.x, to.y),
      this.prefix(from.x, from.y, to.x, to.y),
    ];
    let best = cands[0] as [number, number];
    let bestD = Math.hypot(best[0] - to.x, best[1] - to.y);
    for (let i = 1; i < cands.length; i++) {
      const c = cands[i] as [number, number];
      const d = Math.hypot(c[0] - to.x, c[1] - to.y);
      if (d < bestD - 1e-9) {
        best = c;
        bestD = d;
      }
    }
    return this.pos(best[0], best[1], to);
  }

  // ---- paths ---------------------------------------------------------------------------------

  /**
   * Shortest-ish walkable path a→b as a short list of waypoints (first = start, last = goal; both
   * snapped onto the nearest area if off-mesh). A* over areas, with the cost measured between portal
   * midpoints, then greedy string pulling: each waypoint jumps to the furthest later corridor point it
   * can reach in a straight walkable line. Every segment of the result is walkable. null if no route.
   */
  path(a: NavPoint, b: NavPoint): Vec3[] | null {
    const sa = this.snap(a);
    const sb = this.snap(b);
    const n = this.areas.length;
    const g = new Float64Array(n).fill(Infinity);
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    g[sa.area] = 0;
    px[sa.area] = sa.x;
    py[sa.area] = sa.y;
    heap.push(Math.hypot(sb.x - sa.x, sb.y - sa.y), sa.area);
    let found = false;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur] === 1) continue;
      closed[cur] = 1;
      if (cur === sb.area) {
        found = true;
        break;
      }
      const gc = g[cur] as number;
      const cx = px[cur] as number;
      const cy = py[cur] as number;
      for (const q of this.portals[cur] as readonly NavPortal[]) {
        if (closed[q.to] === 1) continue;
        const ng = gc + Math.hypot(q.mx - cx, q.my - cy);
        if (ng < (g[q.to] as number) - 1e-9) {
          g[q.to] = ng;
          px[q.to] = q.mx;
          py[q.to] = q.my;
          parent[q.to] = cur;
          heap.push(ng + Math.hypot(sb.x - q.mx, sb.y - q.my), q.to);
        }
      }
    }
    if (!found) return null;

    // Corridor: start, portal midpoints in order, goal.
    const chain: number[] = [];
    for (let id = sb.area; id !== -1; id = parent[id] as number) chain.push(id);
    chain.reverse();
    const cx: number[] = [sa.x];
    const cy: number[] = [sa.y];
    for (let i = 1; i < chain.length; i++) {
      cx.push(px[chain[i] as number] as number);
      cy.push(py[chain[i] as number] as number);
    }
    cx.push(sb.x);
    cy.push(sb.y);

    // Greedy string pull. Consecutive corridor points share a convex area, so j = i + 1 always works.
    const out: Vec3[] = [this.pos(sa.x, sa.y, sa)];
    let i = 0;
    const last = cx.length - 1;
    if (this.nav3d !== null) {
      // G3: forward to the furthest corridor point a hull gets to in a straight line on the CS2 mesh, short lines
      // first (a sweep costs with its length), never past the furthest one in walkable 2D line (a cheap bound).
      const zs = chain.map((id, k) => (k === 0 ? (sa.z ?? this.zAt({ x: sa.x, y: sa.y })) : areaZ(this.areas[id] as NavArea, clamp(cx[k] as number, (this.areas[id] as NavArea).x1, (this.areas[id] as NavArea).x2), clamp(cy[k] as number, (this.areas[id] as NavArea).y1, (this.areas[id] as NavArea).y2))));
      zs.push(sb.z ?? this.zAt({ x: sb.x, y: sb.y }));
      const pt = (k: number): Vec3 => ({ x: cx[k] as number, y: cy[k] as number, z: zs[k] as number });
      while (i < last) {
        let far = last;
        while (far > i + 1 && this.walkGrid.coverage(cx[i] as number, cy[i] as number, cx[far] as number, cy[far] as number) < 1) far--;
        let j = i + 1;
        while (j < far && this.nav3d.line(pt(i), pt(j + 1))) j++;
        out.push(this.pos(cx[j] as number, cy[j] as number, j === last ? sb : { x: cx[j] as number, y: cy[j] as number, z: zs[j] as number }));
        i = j;
      }
      return out;
    }
    while (i < last) {
      let j = last;
      while (j > i + 1 && this.walkGrid.coverage(cx[i] as number, cy[i] as number, cx[j] as number, cy[j] as number) < 1) j--;
      out.push(this.pos(cx[j] as number, cy[j] as number, j === last ? sb : null));
      i = j;
    }
    return out;
  }

  /** Total 2D length of a waypoint list. */
  static pathLength(points: readonly NavPoint[]): number {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1] as NavPoint;
      const q = points[i] as NavPoint;
      len += Math.hypot(q.x - p.x, q.y - p.y);
    }
    return len;
  }

  // ---- internals -----------------------------------------------------------------------------

  private pos(x: number, y: number, hint: NavPoint | null): Vec3 {
    const z = this.zAt(hint !== null && hint.z !== undefined ? { x, y, z: hint.z } : { x, y });
    return { x, y, z };
  }

  /** Area and point to start/end a path from: the point itself if on an area, else its projection onto the nearest area. */
  private snap(p: NavPoint): { area: number; x: number; y: number; z?: number } {
    const at = this.areaAt(p);
    if (at !== null) return p.z === undefined ? { area: at.id, x: p.x, y: p.y } : { area: at.id, x: p.x, y: p.y, z: p.z };
    const a = this.nearestArea(p);
    const x = clamp(p.x, a.x1, a.x2);
    const y = clamp(p.y, a.y1, a.y2);
    return { area: a.id, x, y, z: areaZ(a, x, y) };
  }

  /** Longest walkable prefix of from→to, pulled back slightly so the end point is walkable. */
  private prefix(fx: number, fy: number, tx: number, ty: number): [number, number] {
    const len = Math.hypot(tx - fx, ty - fy);
    if (len === 0) return [fx, fy];
    const t = this.walkGrid.coverage(fx, fy, tx, ty);
    if (t >= 1) return [tx, ty];
    if (t <= 0) return [fx, fy];
    const tb = Math.max(0, t - BACKOFF / len);
    const x = fx + (tx - fx) * tb;
    const y = fy + (ty - fy) * tb;
    return this.walkGrid.contains(x, y) ? [x, y] : [fx, fy];
  }

  private buildPortals(a: NavArea): NavPortal[] {
    const eps = this.options.edgeEpsilon;
    const out: NavPortal[] = [];
    for (const j of this.areaGrid.query(a.x1 - eps, a.y1 - eps, a.x2 + eps, a.y2 + eps)) {
      if (j === a.id) continue;
      const portal = this.portalBetween(a, this.areas[j] as NavArea, eps);
      if (portal !== null) out.push(portal);
    }
    return out;
  }

  /**
   * Neighbours share an edge segment longer than eps (gap ≤ eps across it), or overlap with an
   * interior longer than eps on both axes; and their heights differ by ≤ stepHeight at the ends
   * and middle of the shared segment (or the corners and centre of the overlap). G3: or, across a
   * shared edge only, b is lower than a by more than stepHeight and at most dropHeight at every one
   * of those points (a drop off a ledge: one way, a → b).
   */
  private portalBetween(a: NavArea, b: NavArea, eps: number): NavPortal | null {
    const gx = Math.max(b.x1 - a.x2, a.x1 - b.x2);
    const gy = Math.max(b.y1 - a.y2, a.y1 - b.y2);
    const ox1 = Math.max(a.x1, b.x1);
    const ox2 = Math.min(a.x2, b.x2);
    const oy1 = Math.max(a.y1, b.y1);
    const oy2 = Math.min(a.y2, b.y2);
    let pts: [number, number][];
    let seg: [number, number, number, number];
    if (gx < -eps && gy < -eps) {
      const mx = (ox1 + ox2) / 2;
      const my = (oy1 + oy2) / 2;
      pts = [[ox1, oy1], [ox2, oy1], [ox1, oy2], [ox2, oy2], [mx, my]];
      seg = [mx, my, mx, my];
    } else if (Math.abs(gx) <= eps && gy < -eps) {
      const x = a.x2 <= b.x1 + eps ? (a.x2 + b.x1) / 2 : (a.x1 + b.x2) / 2;
      pts = [[x, oy1], [x, (oy1 + oy2) / 2], [x, oy2]];
      seg = [x, oy1, x, oy2];
    } else if (Math.abs(gy) <= eps && gx < -eps) {
      const y = a.y2 <= b.y1 + eps ? (a.y2 + b.y1) / 2 : (a.y1 + b.y2) / 2;
      pts = [[ox1, y], [(ox1 + ox2) / 2, y], [ox2, y]];
      seg = [ox1, y, ox2, y];
    } else {
      return null;
    }
    let minDz = Infinity;
    let minDrop = Infinity;
    let maxDrop = -Infinity;
    for (const [x, y] of pts) {
      const za = areaZ(a, clamp(x, a.x1, a.x2), clamp(y, a.y1, a.y2));
      const zb = areaZ(b, clamp(x, b.x1, b.x2), clamp(y, b.y1, b.y2));
      minDz = Math.min(minDz, Math.abs(za - zb));
      minDrop = Math.min(minDrop, za - zb);
      maxDrop = Math.max(maxDrop, za - zb);
    }
    const overlap = gx < -eps && gy < -eps;
    const drop = !overlap && minDrop > this.options.stepHeight && maxDrop <= this.options.dropHeight;
    if (minDz > this.options.stepHeight && !drop) return null;
    return { to: b.id, ax: seg[0], ay: seg[1], bx: seg[2], by: seg[3], mx: (seg[0] + seg[2]) / 2, my: (seg[1] + seg[3]) / 2 };
  }
}

/** Nav options from parsed tuning (`parseTuning(json).nav`; parseTuning validates the section). */
export function navOptionsFromTuning(tuning: Pick<Tuning, 'nav'>): NavOptions {
  const { stepHeight, edgeEpsilon, losMargin, dropHeight } = tuning.nav;
  return { stepHeight, edgeEpsilon, losMargin, dropHeight };
}

/** Height of area a at (x, y): linear in the projection onto the (x1,y1)→(x2,y2) diagonal, clamped to [0, 1]. */
export function areaZ(a: NavArea, x: number, y: number): number {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const t = clamp(((x - a.x1) * dx + (y - a.y1) * dy) / (dx * dx + dy * dy), 0, 1);
  return a.z1 + (a.z2 - a.z1) * t;
}

function grow(a: NavArea, m: number): Rect {
  return { x1: a.x1 - m, y1: a.y1 - m, x2: a.x2 + m, y2: a.y2 + m };
}

function rectDistance(r: Rect, x: number, y: number): number {
  return Math.hypot(Math.max(r.x1 - x, 0, x - r.x2), Math.max(r.y1 - y, 0, y - r.y2));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NavError(`${path}: expected an object`);
  return value as Record<string, unknown>;
}

/** Binary min-heap of (key, id), ordered by key then id, so pops are deterministic. */
class MinHeap {
  private keys: number[] = [];
  private ids: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(key: number, id: number): void {
    this.keys.push(key);
    this.ids.push(id);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.ids[0] as number;
    const lastKey = this.keys.pop() as number;
    const lastId = this.ids.pop() as number;
    if (this.ids.length > 0) {
      this.keys[0] = lastKey;
      this.ids[0] = lastId;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.less(l, m)) m = l;
        if (r < this.ids.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private less(i: number, j: number): boolean {
    const ki = this.keys[i] as number;
    const kj = this.keys[j] as number;
    return ki < kj || (ki === kj && (this.ids[i] as number) < (this.ids[j] as number));
  }

  private swap(i: number, j: number): void {
    const k = this.keys[i] as number;
    this.keys[i] = this.keys[j] as number;
    this.keys[j] = k;
    const d = this.ids[i] as number;
    this.ids[i] = this.ids[j] as number;
    this.ids[j] = d;
  }
}
