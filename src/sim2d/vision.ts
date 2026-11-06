/**
 * Vision for the 2D sim (C4 / A5): a sight-blocking mask built from the Mirage radar image
 * (tools/extract-vismask.ts → data/mirage-vismask.json) and the line-of-sight query that `sees`,
 * bullets and grenades use. The nav mesh stays the movement model; it treats every drop, ledge,
 * window and nav hole as a wall, which is wrong for sight (docs/vision.md).
 *
 * The mask is a grid over the radar: cell (i, j) covers px ∈ [i, i+1), py ∈ [j, j+1) with
 * px = (x − originX) / unitsPerPx and py = (originY − y) / unitsPerPx (rows top to bottom, y north up).
 * A cell is wall (1) or open (0); everything outside the grid is wall.
 *
 * lineOfSight walks the exact cells the 2D segment crosses (Amanatides–Woo DDA) and measures each
 * run of consecutive wall cells along the segment (in cells, i.e. radar pixels). A run longer than
 * `wallTolerancePx` blocks; a run that touches an end of the segment may be up to
 * `endpointTolerancePx` long (a pawn's centre is a few units inside a wall on the mask). Grazing a
 * corner crosses a wall cell for a tiny length, so it does not block. Pure and deterministic.
 */
import type { AiTuning, PlayerId, Tuning, Vec3 } from '../contracts/index';
import type { NavPoint } from './nav';

/** Identifies the JSON layout of data/mirage-vismask.json. */
export const VISMASK_FORMAT = 'cs2-round-replay/vismask@1';

export class VisMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisMaskError';
  }
}

/** Grid geometry and cells (1 = wall, 0 = open), row-major, top row first. */
export interface VisMaskGrid {
  readonly width: number;
  readonly height: number;
  /** Source units per cell (the radar's 5, or coarser). */
  readonly unitsPerPx: number;
  /** World x at px = 0. */
  readonly originX: number;
  /** World y at py = 0 (the top edge; y decreases downward). */
  readonly originY: number;
  readonly cells: Uint8Array;
}

/** Line-of-sight tolerances, from `tuning.ai` (`losWallTolerancePx`, `losEndpointTolerancePx`). */
export interface VisOptions {
  /** A run of wall cells along the segment longer than this (cells) blocks sight. */
  readonly wallTolerancePx: number;
  /** A wall run that touches either end of the segment may be up to this long (cells). */
  readonly endpointTolerancePx: number;
}

export function visOptionsFromTuning(ai: Pick<AiTuning, 'losWallTolerancePx' | 'losEndpointTolerancePx'>): VisOptions {
  return { wallTolerancePx: ai.losWallTolerancePx, endpointTolerancePx: ai.losEndpointTolerancePx };
}

/** Sight options from parsed tuning. */
export function sightOptionsFromTuning(t: Pick<Tuning, 'ai' | 'damage' | 'nav'>): SightOptions {
  return { eyeHeight: t.damage.eyeHeight, levelStepUnits: t.ai.losLevelStepUnits, levelSlackUnits: t.ai.losLevelSlackUnits, stepHeight: t.nav.stepHeight };
}

/** What a sight query found (for tests, tools and debugging). */
export interface SightTrace {
  readonly visible: boolean;
  /** Longest wall run along the segment (cells), and the world point where it starts (null if none). */
  readonly maxRunPx: number;
  readonly runAt: { readonly x: number; readonly y: number } | null;
}

export class VisMask {
  readonly width: number;
  readonly height: number;
  readonly unitsPerPx: number;
  readonly originX: number;
  readonly originY: number;
  readonly options: VisOptions;
  private readonly cells: Uint8Array;

  constructor(grid: VisMaskGrid, options: VisOptions) {
    const { width, height, unitsPerPx } = grid;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new VisMaskError(`bad size ${width}×${height}`);
    if (!(unitsPerPx > 0)) throw new VisMaskError(`bad unitsPerPx ${unitsPerPx}`);
    if (grid.cells.length !== width * height) throw new VisMaskError(`expected ${width * height} cells, got ${grid.cells.length}`);
    if (!(options.wallTolerancePx >= 0) || !(options.endpointTolerancePx >= 0)) throw new VisMaskError('tolerances must be ≥ 0');
    this.width = width;
    this.height = height;
    this.unitsPerPx = unitsPerPx;
    this.originX = grid.originX;
    this.originY = grid.originY;
    this.cells = grid.cells;
    this.options = { wallTolerancePx: options.wallTolerancePx, endpointTolerancePx: options.endpointTolerancePx };
  }

  /** Build from parsed data/mirage-vismask.json (validated: format, size, run sums). */
  static fromJson(json: unknown, options: VisOptions): VisMask {
    return new VisMask(decodeVisMaskJson(json), options);
  }

  /** Radar pixel coordinates of a world point (continuous). */
  toPx(p: NavPoint): { px: number; py: number } {
    return { px: (p.x - this.originX) / this.unitsPerPx, py: (this.originY - p.y) / this.unitsPerPx };
  }

  /** World point at the centre of cell (i, j). */
  cellCenter(i: number, j: number): { x: number; y: number } {
    return { x: this.originX + (i + 0.5) * this.unitsPerPx, y: this.originY - (j + 0.5) * this.unitsPerPx };
  }

  /** True if cell (i, j) is wall; outside the grid is wall. */
  isWallCell(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.width || j >= this.height) return true;
    return this.cells[j * this.width + i] === 1;
  }

  /** True if the cell under p is open. */
  isOpen(p: NavPoint): boolean {
    const { px, py } = this.toPx(p);
    return !this.isWallCell(Math.floor(px), Math.floor(py));
  }

  /** Open and wall cell counts. */
  counts(): { open: number; wall: number } {
    let wall = 0;
    for (const c of this.cells) wall += c;
    return { open: this.cells.length - wall, wall };
  }

  /** 2D line of sight a ↔ b on the mask (symmetric: lineOfSight(a, b) === lineOfSight(b, a)). */
  lineOfSight(a: NavPoint, b: NavPoint): boolean {
    return this.walk(a, b, true).visible;
  }

  /** Like lineOfSight, but walks the whole segment and reports the longest wall run (for tools and tests). */
  trace(a: NavPoint, b: NavPoint): SightTrace {
    return this.walk(a, b, false);
  }

  /**
   * DDA over the cells the segment crosses, from the lexicographically smaller end (so the result is
   * exactly symmetric). `stopEarly` returns at the first blocking run.
   */
  private walk(a: NavPoint, b: NavPoint, stopEarly: boolean): SightTrace {
    const u = this.unitsPerPx;
    let ax = (a.x - this.originX) / u;
    let ay = (this.originY - a.y) / u;
    let bx = (b.x - this.originX) / u;
    let by = (this.originY - b.y) / u;
    if (ax > bx || (ax === bx && ay > by)) {
      const tx = ax;
      const ty = ay;
      ax = bx;
      ay = by;
      bx = tx;
      by = ty;
    }
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const tol = this.options.wallTolerancePx;
    const endTol = this.options.endpointTolerancePx;
    let ix = Math.floor(ax);
    let iy = Math.floor(ay);
    // The same point: a pawn sees what stands where it stands.
    if (len < 1e-9) return { visible: true, maxRunPx: 0, runAt: null };
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX === 0 ? Infinity : 1 / Math.abs(dx);
    const tDeltaY = stepY === 0 ? Infinity : 1 / Math.abs(dy);
    let tMaxX = stepX > 0 ? (ix + 1 - ax) / dx : stepX < 0 ? (ix - ax) / dx : Infinity;
    let tMaxY = stepY > 0 ? (iy + 1 - ay) / dy : stepY < 0 ? (iy - ay) / dy : Infinity;
    const w = this.width;
    const h = this.height;
    const cells = this.cells;
    let t = 0;
    let runStart = -1;
    let visible = true;
    let maxRun = 0;
    let maxRunT = -1;
    for (;;) {
      const tNext = tMaxX < tMaxY ? tMaxX : tMaxY;
      const tEnd = tNext < 1 ? tNext : 1;
      const wall = ix < 0 || iy < 0 || ix >= w || iy >= h || cells[iy * w + ix] === 1;
      if (wall) {
        if (runStart < 0) runStart = t;
      } else if (runStart >= 0) {
        const run = (t - runStart) * len;
        if (run > maxRun) {
          maxRun = run;
          maxRunT = runStart;
        }
        if (run > (runStart === 0 ? endTol : tol)) {
          visible = false;
          if (stopEarly) break;
        }
        runStart = -1;
      }
      if (tEnd >= 1) break;
      t = tEnd;
      if (tMaxX < tMaxY) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        iy += stepY;
        tMaxY += tDeltaY;
      } else {
        // Exactly through a cell corner: the two side cells are touched at a point only.
        ix += stepX;
        iy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }
    }
    if (visible || !stopEarly) {
      if (runStart >= 0) {
        const run = (1 - runStart) * len;
        if (run > maxRun) {
          maxRun = run;
          maxRunT = runStart;
        }
        if (run > endTol) visible = false;
      }
    }
    const runAt = maxRunT < 0 ? null : { x: this.originX + (ax + dx * maxRunT) * u, y: this.originY - (ay + dy * maxRunT) * u };
    return { visible, maxRunPx: maxRun, runAt };
  }
}

// ---- Sight: the 2D mask plus a level check on the nav floors ----------------------------------------

/** 2D line of sight (VisMask, or NavMesh as the fallback) plus floor heights (NavMesh fits both). */
export interface SightNav {
  lineOfSight(a: NavPoint, b: NavPoint): boolean;
  floorsAt(x: number, y: number): number[];
}

/** Level-check parameters (`tuning.ai` and `tuning.nav`). */
export interface SightOptions {
  /** Eye height above the floor for `lineOfSight` (`damage.eyeHeight`). */
  readonly eyeHeight: number;
  /** Sample spacing along the line (units; `ai.losLevelStepUnits`). */
  readonly levelStepUnits: number;
  /** A sample is inside a floor only when this far below it (units; `ai.losLevelSlackUnits`), for the nav's height-model error. */
  readonly levelSlackUnits: number;
  /** Floors at consecutive samples within this height of each other are the same surface (`nav.stepHeight`). */
  readonly stepHeight: number;
}

/**
 * What `sees`, bullets and grenades ask (C4). `flat(a, b)` is the 2D test: the sight mask if there is one, else
 * the nav mesh's lineOfSight (synthetic test meshes). `clear(a, eyeA, b, eyeB)` adds a level check on the
 * straight 3D line between the two eyes (eye = floor z + eye height), sampled every `levelStepUnits` against the
 * nav floors under it: the line is blocked where it is more than `levelSlackUnits` below every floor under a
 * sample (inside the ground: a ledge face seen from below), or where, over one floor surface, it is both more than
 * `levelSlackUnits` below it and above it (through a floor slab: Catwalk over the Tunnel). Off-mesh samples don't
 * constrain. The slack absorbs the nav's height-model error, so only clear cases block.
 */
export class Sight {
  readonly mask: VisMask | null;
  readonly options: SightOptions;
  private readonly nav: SightNav;

  constructor(mask: VisMask | null, nav: SightNav, options: SightOptions) {
    this.mask = mask;
    this.nav = nav;
    this.options = { ...options };
  }

  /** 2D sight: the mask, or the nav mesh without one. */
  flat(a: NavPoint, b: NavPoint): boolean {
    return this.mask === null ? this.nav.lineOfSight(a, b) : this.mask.lineOfSight(a, b);
  }

  /** Eye to eye: `flat` and the level check, with eyes `eyeA` / `eyeB` above a.z / b.z. */
  clear(a: Vec3, eyeA: number, b: Vec3, eyeB: number): boolean {
    return this.flat(a, b) && this.levelsClear(a, a.z + eyeA, b, b.z + eyeB);
  }

  /** `clear` with the standing eye height at both ends; 2D only when either end has no z. Fits hitscan's LosQuery. */
  lineOfSight(a: NavPoint, b: NavPoint): boolean {
    if (a.z === undefined || b.z === undefined) return this.flat(a, b);
    return this.clear({ x: a.x, y: a.y, z: a.z }, this.options.eyeHeight, { x: b.x, y: b.y, z: b.z }, this.options.eyeHeight);
  }

  /**
   * The level check alone, between heights ha at a and hb at b. Samples are matched to the previous sample's
   * floors within stepHeight (the same surface continuing); along each such run the line's lowest and highest
   * height relative to the surface are kept. Blocked if the line is more than levelSlackUnits below every floor
   * at a sample, or if over one surface it is both more than levelSlackUnits below it and above it.
   */
  levelsClear(a: NavPoint, ha: number, b: NavPoint, hb: number): boolean {
    const { levelStepUnits: step, levelSlackUnits: slack, stepHeight } = this.options;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / step));
    let prevFloors: number[] = [];
    let prevMin: number[] = [];
    let prevMax: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const h = ha + (hb - ha) * t;
      const floors = this.nav.floorsAt(a.x + dx * t, a.y + dy * t);
      if (floors.length > 0 && h < (floors[0] as number) - slack) return false;
      const mins: number[] = [];
      const maxs: number[] = [];
      for (const f of floors) {
        let lo = h - f;
        let hi = h - f;
        for (let k = 0; k < prevFloors.length; k++) {
          if (Math.abs((prevFloors[k] as number) - f) <= stepHeight) {
            lo = Math.min(lo, prevMin[k] as number);
            hi = Math.max(hi, prevMax[k] as number);
            break;
          }
        }
        if (lo < -slack && hi > 0) return false;
        mins.push(lo);
        maxs.push(hi);
      }
      prevFloors = floors;
      prevMin = mins;
      prevMax = maxs;
    }
    return true;
  }
}

/** Grenades' world queries on the 2D sight (throw clamp, flash and HE line of sight) with the nav's floor height. */
export class GrenadeSight {
  private readonly sight: Sight;
  private readonly floor: { zAt(p: NavPoint): number };

  constructor(sight: Sight, floor: { zAt(p: NavPoint): number }) {
    this.sight = sight;
    this.floor = floor;
  }

  lineOfSight(a: NavPoint, b: NavPoint): boolean {
    return this.sight.flat(a, b);
  }

  zAt(p: NavPoint): number {
    return this.floor.zAt(p);
  }
}

// ---- sees (contract F5) ----------------------------------------------------------------------------

/** What `sees` needs to know about a pawn. */
export interface SeePawn {
  readonly id: PlayerId;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly crouching: boolean;
  readonly alive: boolean;
  /** Flashed: blind sees nothing (it can still be seen). */
  readonly blind: boolean;
}

/** Eye heights and FOV for `sees`. */
export interface SeesOptions {
  readonly fovDeg: number;
  readonly eyeHeight: number;
  readonly crouchEyeHeight: number;
}

/** Smoke between two points (Sim2DHost.smokeBlocks fits). */
export interface SmokeQuery {
  smokeBlocks(a: NavPoint, b: NavPoint): boolean;
}

/** Absolute angle (degrees, 0..180) between `yaw` and the bearing from `from` to `to`; 0 for the same point. */
export function angleOff(yaw: number, from: NavPoint, to: NavPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 0;
  let diff = ((Math.atan2(dy, dx) * 180) / Math.PI - yaw) % 360;
  if (diff < -180) diff += 360;
  if (diff > 180) diff -= 360;
  return Math.abs(diff);
}

/**
 * `sees` for every pawn (contract F5; docs/contracts.md): `pawns` in id order, result in the same order, each list
 * sorted by id. Viewer V sees target T (another pawn, either team) when both are alive, V is not blind, T is within
 * fovDeg / 2 of V's yaw, the eye-to-eye line is clear (`sight.clear`: the 2D mask and the level check; eyes at
 * eyeHeight, crouchEyeHeight when crouched), and no active smoke crosses the 2D segment. Sight and smoke are
 * symmetric, so each unordered pair is traced once and only if one side looks at the other.
 */
export function computeSees(pawns: readonly SeePawn[], sight: Sight, smoke: SmokeQuery, o: SeesOptions): PlayerId[][] {
  const half = o.fovDeg / 2;
  const out: PlayerId[][] = pawns.map(() => []);
  for (let i = 0; i < pawns.length; i++) {
    const a = pawns[i] as SeePawn;
    if (!a.alive) continue;
    for (let j = i + 1; j < pawns.length; j++) {
      const b = pawns[j] as SeePawn;
      if (!b.alive) continue;
      const ab = !a.blind && angleOff(a.yaw, a.pos, b.pos) <= half;
      const ba = !b.blind && angleOff(b.yaw, b.pos, a.pos) <= half;
      if (!ab && !ba) continue;
      const eyeA = a.crouching ? o.crouchEyeHeight : o.eyeHeight;
      const eyeB = b.crouching ? o.crouchEyeHeight : o.eyeHeight;
      if (!sight.clear(a.pos, eyeA, b.pos, eyeB) || smoke.smokeBlocks(a.pos, b.pos)) continue;
      if (ab) (out[i] as PlayerId[]).push(b.id);
      if (ba) (out[j] as PlayerId[]).push(a.id);
    }
  }
  // Pairs are visited in id order, so each list is already sorted (j > i appended in order; earlier i first).
  return out.map((xs) => [...xs].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)));
}

// ---- JSON (run-length encoded) ---------------------------------------------------------------------

/** The JSON document's shape (rows: run lengths alternating wall, open, wall, …, starting with wall). */
export interface VisMaskJson {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly unitsPerPx: number;
  readonly originX: number;
  readonly originY: number;
  readonly rows: readonly (readonly number[])[];
}

/** Run lengths of one row: wall, open, wall, … (the first may be 0). */
export function encodeRow(cells: Uint8Array, offset: number, width: number): number[] {
  const runs: number[] = [];
  let cur = 1;
  let n = 0;
  for (let i = 0; i < width; i++) {
    const c = cells[offset + i] === 1 ? 1 : 0;
    if (c === cur) n++;
    else {
      runs.push(n);
      cur = c;
      n = 1;
    }
  }
  runs.push(n);
  return runs;
}

/** Decode and validate the JSON document into a grid. */
export function decodeVisMaskJson(json: unknown): VisMaskGrid {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new VisMaskError('vismask: expected an object');
  const o = json as Record<string, unknown>;
  if (o['format'] !== VISMASK_FORMAT) throw new VisMaskError(`vismask: format must be ${VISMASK_FORMAT}`);
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new VisMaskError(`vismask.${k}: expected a finite number`);
    return v;
  };
  const width = num('width');
  const height = num('height');
  const unitsPerPx = num('unitsPerPx');
  const originX = num('originX');
  const originY = num('originY');
  const rows = o['rows'];
  if (!Array.isArray(rows) || rows.length !== height) throw new VisMaskError(`vismask.rows: expected ${height} rows`);
  const cells = new Uint8Array(width * height);
  rows.forEach((row: unknown, j) => {
    if (!Array.isArray(row)) throw new VisMaskError(`vismask.rows[${j}]: expected an array`);
    let x = 0;
    let wall = true;
    for (const r of row as unknown[]) {
      if (typeof r !== 'number' || !Number.isInteger(r) || r < 0) throw new VisMaskError(`vismask.rows[${j}]: bad run ${String(r)}`);
      if (x + r > width) throw new VisMaskError(`vismask.rows[${j}]: runs exceed width`);
      if (wall) cells.fill(1, j * width + x, j * width + x + r);
      x += r;
      wall = !wall;
    }
    if (x !== width) throw new VisMaskError(`vismask.rows[${j}]: runs sum to ${x}, expected ${width}`);
  });
  return { width, height, unitsPerPx, originX, originY, cells };
}
