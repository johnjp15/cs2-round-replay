/**
 * Uniform-grid spatial index over axis-aligned rectangles, plus the segment-coverage walk used by
 * line-of-sight, walkability and clamping. Pure and allocation-free on the query path.
 */

/** Axis-aligned rectangle in Source units (inclusive edges). */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Containment slack (units) so points exactly on a shared edge count for both rectangles. */
const CONTAIN_EPS = 1e-6;
const EMPTY: readonly number[] = [];

export class RectGrid {
  readonly rects: readonly Rect[];
  readonly cellSize: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  /** cells[row * cols + col] = ascending rectangle indices overlapping that cell. */
  private readonly cells: number[][];

  constructor(rects: readonly Rect[], cellSize: number) {
    this.rects = rects;
    this.cellSize = cellSize;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
      if (r.x1 < minX) minX = r.x1;
      if (r.y1 < minY) minY = r.y1;
      if (r.x2 > maxX) maxX = r.x2;
      if (r.y2 > maxY) maxY = r.y2;
    }
    if (rects.length === 0) {
      minX = 0;
      minY = 0;
      maxX = 0;
      maxY = 0;
    }
    this.minX = minX - cellSize;
    this.minY = minY - cellSize;
    this.cols = Math.floor((maxX - this.minX) / cellSize) + 2;
    this.rows = Math.floor((maxY - this.minY) / cellSize) + 2;
    this.cells = [];
    for (let i = 0; i < this.cols * this.rows; i++) this.cells.push([]);
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i] as Rect;
      const c1 = this.col(r.x1 - CONTAIN_EPS);
      const c2 = this.col(r.x2 + CONTAIN_EPS);
      const r1 = this.row(r.y1 - CONTAIN_EPS);
      const r2 = this.row(r.y2 + CONTAIN_EPS);
      for (let row = r1; row <= r2; row++) {
        for (let col = c1; col <= c2; col++) (this.cells[row * this.cols + col] as number[]).push(i);
      }
    }
  }

  private col(x: number): number {
    const c = Math.floor((x - this.minX) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private row(y: number): number {
    const r = Math.floor((y - this.minY) / this.cellSize);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  /** Ascending indices of rectangles that may contain (x, y). */
  candidates(x: number, y: number): readonly number[] {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return EMPTY;
    return this.cells[this.row(y) * this.cols + this.col(x)] ?? EMPTY;
  }

  /** Ascending indices of rectangles overlapping the box [x1,x2]×[y1,y2] (inclusive). */
  query(x1: number, y1: number, x2: number, y2: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let row = this.row(y1); row <= this.row(y2); row++) {
      for (let col = this.col(x1); col <= this.col(x2); col++) {
        for (const i of this.cells[row * this.cols + col] as number[]) {
          if (seen.has(i)) continue;
          const r = this.rects[i] as Rect;
          if (r.x1 <= x2 && r.x2 >= x1 && r.y1 <= y2 && r.y2 >= y1) {
            seen.add(i);
            out.push(i);
          }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** True if (x, y) lies in at least one rectangle (inclusive edges). */
  contains(x: number, y: number): boolean {
    for (const i of this.candidates(x, y)) {
      if (rectContains(this.rects[i] as Rect, x, y)) return true;
    }
    return false;
  }

  /**
   * Walk the segment a→b through the union of rectangles and return the largest t in [0, 1] such
   * that every point of a + t'(b − a) for t' in [0, t] is covered; −1 if a itself is uncovered.
   * Exact (no sampling): repeatedly jumps to the furthest exit parameter among the rectangles
   * containing the current point.
   */
  coverage(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    let t = 0;
    let px = ax;
    let py = ay;
    for (let iter = 0; iter < 100000; iter++) {
      let best = -1;
      for (const i of this.candidates(px, py)) {
        const r = this.rects[i] as Rect;
        if (!rectContains(r, px, py)) continue;
        const te = exitParam(r, ax, ay, dx, dy);
        if (te > best) best = te;
      }
      if (best < 0) return iter === 0 ? -1 : t;
      if (best >= 1) return 1;
      if (best <= t + 1e-12) return t;
      t = best;
      px = ax + dx * t;
      py = ay + dy * t;
    }
    return t;
  }
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x1 - CONTAIN_EPS && x <= r.x2 + CONTAIN_EPS && y >= r.y1 - CONTAIN_EPS && y <= r.y2 + CONTAIN_EPS;
}

/** Parameter at which the line a + t·d leaves rectangle r (Liang–Barsky exit; +∞ if d = 0). */
function exitParam(r: Rect, ax: number, ay: number, dx: number, dy: number): number {
  let te = Infinity;
  if (dx > 0) te = Math.min(te, (r.x2 + CONTAIN_EPS - ax) / dx);
  else if (dx < 0) te = Math.min(te, (r.x1 - CONTAIN_EPS - ax) / dx);
  if (dy > 0) te = Math.min(te, (r.y2 + CONTAIN_EPS - ay) / dy);
  else if (dy < 0) te = Math.min(te, (r.y1 - CONTAIN_EPS - ay) / dy);
  return te;
}
