/**
 * Mirage collision geometry (G2): CS2's physics mesh as triangles, and the queries 3D movement needs.
 *
 * Data: data/geometry/mirage-geometry.bin, built by tools/extract-geometry.ts from the awpy-data collision mesh
 * (data/source/cs2/, docs/geometry.md). Format `G2GM` v1: an 16-byte header, then unsigned LEB128 varints:
 *
 *   bytes 0-3   "G2GM"
 *   byte  4     version (1)
 *   byte  5     0
 *   bytes 6-7   u16 LE `quant`: integer steps per world unit (8 → coordinates are multiples of 1/8 unit)
 *   bytes 8-11  u32 LE vertex count
 *   bytes 12-15 u32 LE triangle count
 *   vertices    per vertex zigzag(dx), zigzag(dy), zigzag(dz): integer coordinates (world × quant) as deltas
 *               from the previous vertex (the first from 0, 0, 0)
 *   triangles   per triangle a − previous a, then b − a − 1, then c − a − 1 (a is the triangle's smallest index,
 *               b and c follow in the original winding, so a < b and a < c)
 *
 * The page gzips the file (and base64s it) like the JSON data, so the varints only have to be compact enough for
 * gzip to work well.
 *
 * Frames and conventions: Source units, Mirage world frame (docs/conventions.md), z up. A player is the Source
 * axis-aligned hull: feet at (x, y, z), the box [x − w, x + w] × [y − w, y + w] × [z, z + h] with w = 16 and
 * h = 72 standing, 54 crouched.
 *
 * Every triangle is two-sided: the mesh is a surface soup (winding is inconsistent and solids aren't closed), so
 * "inside a wall" isn't defined; boxes collide with the surfaces. Queries:
 *
 * - `boxBlocked`: does any triangle cut into an axis-aligned box (deeper than OVERLAP_EPS)? Touching is free.
 * - `traceBox`: sweep a hull from one feet position to another (Source's TracePlayerBBox): the fraction of the move
 *   that is free, pulled back TRACE_SKIN from the surface hit, and its normal.
 * - `floorBelow` / `ceilingAbove`: the highest surface top under the hull's footprint at or below z + up, and the
 *   lowest surface bottom above z.
 * - `lineBlocked` / `traceLine`: segment tests (eye-to-eye sight).
 *
 * All are pure functions of the data and their arguments, with plain + − × ÷, comparisons, floor and sqrt (IEEE
 * exact, so a C# port gives identical results). Scratch fields keep them allocation-free; that makes a MapGeometry
 * not re-entrant (fine on one thread). The broad phase is a uniform 2D grid of triangle lists.
 */

/** File magic, as bytes: "G2GM". */
export const GEOMETRY_MAGIC = 'G2GM';
export const GEOMETRY_VERSION = 1;
const HEADER_BYTES = 16;

/** Source's ground normal limit: a surface is walkable if its unit normal has |nz| ≥ this (cos 45.57°). */
export const WALKABLE_NZ = 0.7;
/** Source step height: floorBelow looks this far above z by default. */
export const STEP_HEIGHT = 18;
/** Source's DIST_EPSILON: traceBox stops this far (along the hit normal) short of the surface it hits. */
export const TRACE_SKIN = 0.03125;
/** A triangle blocks a box only if it cuts in deeper than this (units) on every separating axis. */
export const OVERLAP_EPS = 1e-4;
/** Broad-phase cell size (units). 16, 32 and 64 measured the same within noise (docs/geometry.md, Costs). */
export const GEOMETRY_CELL = 32;
/** G6: segment traces pad the segment's box in a cell by this (units) before the bounding-box filters, so rounding never drops a crossing. */
const SEGMENT_PAD = 1e-6;

/** An axis-aligned player hull: half width in x and y, height above the feet. */
export interface Hull {
  readonly halfWidth: number;
  readonly height: number;
}

/** Source / CS2 standing hull: 32 × 32 × 72. */
export const STANDING_HULL: Hull = { halfWidth: 16, height: 72 };
/** Source / CS2 crouched hull: 32 × 32 × 54. */
export const CROUCHING_HULL: Hull = { halfWidth: 16, height: 54 };

/** The decoded file: integer coordinates (world × quant) and triangle indices. */
export interface GeometryMesh {
  readonly quant: number;
  /** x, y, z per vertex, integers. */
  readonly verts: Int32Array;
  /** Three vertex indices per triangle. */
  readonly tris: Int32Array;
  /**
   * G6: triangles [0, sightTriangles) block sight and bullets; the rest only block movement (G3's player clips, which
   * CS2's bullets and sight traces pass through). Absent: every triangle blocks sight. Set by `combineMeshes`.
   */
  readonly sightTriangles?: number;
}

/** Result of `traceBox` (all fields always set). */
export interface BoxTrace {
  /** Free fraction of the move, 0..1, pulled back TRACE_SKIN from the hit surface (1 = no hit). */
  readonly fraction: number;
  /** Feet position at `fraction`. */
  readonly endX: number;
  readonly endY: number;
  readonly endZ: number;
  readonly hit: boolean;
  /** Unit normal of the surface hit, pointing back toward the hull (0, 0, 0 without a hit). */
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
  /** Index of the triangle hit, −1 if none. */
  readonly tri: number;
  /** The start box already cuts into a triangle deeper than OVERLAP_EPS. */
  readonly startSolid: boolean;
  /** startSolid, and the end box still cuts into one of those triangles. */
  readonly allSolid: boolean;
}

/** Result of `floorBelow`. */
export interface FloorHit {
  /** Height of the surface top (the feet z a hull would rest at). */
  readonly z: number;
  /** Unit normal of that triangle, oriented up (nz ≥ 0). */
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
  /** normalZ ≥ WALKABLE_NZ: Source counts it as ground. */
  readonly walkable: boolean;
  readonly tri: number;
}

export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryError';
  }
}

// ---- encoding (also used by tools/extract-geometry.ts) ----------------------------------------------------------

function zigzag(n: number): number {
  return n >= 0 ? 2 * n : -2 * n - 1;
}

function unzigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

/** Growable byte buffer for varints. */
class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  byte(b: number): void {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = b;
  }

  /** Unsigned LEB128 of a non-negative integer < 2^53. */
  varint(n: number): void {
    if (!Number.isInteger(n) || n < 0) throw new GeometryError(`varint: expected a non-negative integer, got ${n}`);
    let v = n;
    while (v >= 128) {
      this.byte((v % 128) + 128);
      v = Math.floor(v / 128);
    }
    this.byte(v);
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * Encode a mesh. Triangles must already be in canonical form (smallest index first, winding kept) and sorted by
 * (a, b, c); vertices in the order the indices refer to. tools/extract-geometry.ts does that.
 */
export function encodeGeometry(mesh: GeometryMesh): Uint8Array {
  const nv = mesh.verts.length / 3;
  const nt = mesh.tris.length / 3;
  if (!Number.isInteger(nv) || !Number.isInteger(nt)) throw new GeometryError('encodeGeometry: array lengths must be multiples of 3');
  if (!Number.isInteger(mesh.quant) || mesh.quant < 1 || mesh.quant > 65535) throw new GeometryError(`encodeGeometry: bad quant ${mesh.quant}`);
  const w = new ByteWriter();
  for (const ch of GEOMETRY_MAGIC) w.byte(ch.charCodeAt(0));
  w.byte(GEOMETRY_VERSION);
  w.byte(0);
  w.byte(mesh.quant % 256);
  w.byte(Math.floor(mesh.quant / 256));
  for (const n of [nv, nt]) for (let k = 0; k < 4; k++) w.byte(Math.floor(n / 256 ** k) % 256);
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i < nv; i++) {
    const x = mesh.verts[i * 3] as number;
    const y = mesh.verts[i * 3 + 1] as number;
    const z = mesh.verts[i * 3 + 2] as number;
    w.varint(zigzag(x - px));
    w.varint(zigzag(y - py));
    w.varint(zigzag(z - pz));
    px = x;
    py = y;
    pz = z;
  }
  let pa = 0;
  for (let t = 0; t < nt; t++) {
    const a = mesh.tris[t * 3] as number;
    const b = mesh.tris[t * 3 + 1] as number;
    const c = mesh.tris[t * 3 + 2] as number;
    if (!(a < b && a < c && c < nv && b < nv) || a < pa) throw new GeometryError(`encodeGeometry: triangle ${t} is not canonical (${a}, ${b}, ${c})`);
    w.varint(a - pa);
    w.varint(b - a - 1);
    w.varint(c - a - 1);
    pa = a;
  }
  return w.bytes();
}

/** Decode a G2GM file (the bytes of data/geometry/mirage-geometry.bin). */
export function decodeGeometry(bytes: Uint8Array): GeometryMesh {
  if (bytes.length < HEADER_BYTES) throw new GeometryError('geometry: file too short');
  for (let k = 0; k < 4; k++) if (bytes[k] !== GEOMETRY_MAGIC.charCodeAt(k)) throw new GeometryError('geometry: bad magic (expected G2GM)');
  if (bytes[4] !== GEOMETRY_VERSION) throw new GeometryError(`geometry: unsupported version ${String(bytes[4])}`);
  const u8 = (i: number): number => bytes[i] as number;
  const quant = u8(6) + 256 * u8(7);
  const nv = u8(8) + 256 * u8(9) + 65536 * u8(10) + 16777216 * u8(11);
  const nt = u8(12) + 256 * u8(13) + 65536 * u8(14) + 16777216 * u8(15);
  if (quant < 1) throw new GeometryError('geometry: bad quant');
  let pos = HEADER_BYTES;
  const next = (): number => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (pos >= bytes.length) throw new GeometryError('geometry: truncated');
      const b = bytes[pos++] as number;
      v += (b % 128) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  const verts = new Int32Array(nv * 3);
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i < nv; i++) {
    px += unzigzag(next());
    py += unzigzag(next());
    pz += unzigzag(next());
    verts[i * 3] = px;
    verts[i * 3 + 1] = py;
    verts[i * 3 + 2] = pz;
  }
  const tris = new Int32Array(nt * 3);
  let a = 0;
  for (let t = 0; t < nt; t++) {
    a += next();
    const b = a + 1 + next();
    const c = a + 1 + next();
    if (b >= nv || c >= nv) throw new GeometryError(`geometry: triangle ${t} index out of range`);
    tris[t * 3] = a;
    tris[t * 3 + 1] = b;
    tris[t * 3 + 2] = c;
  }
  if (pos !== bytes.length) throw new GeometryError(`geometry: ${bytes.length - pos} trailing bytes`);
  return { quant, verts, tris };
}

/**
 * One mesh made of two with the same `quant`: `a`'s vertices and triangles, then `b`'s (indices shifted). G3 merges
 * the player clips (data/geometry/mirage-clips.bin, docs/geometry.md "Player clips") into the world mesh this way, so
 * movement traces see them like any other surface. `b`'s triangles block movement only (G6): the result's
 * `sightTriangles` is `a`'s (all of `a` when unset), so sight and bullet traces (`traceSight`) skip the clips, as CS2's
 * do. The result is not canonical G2GM (it is never encoded).
 */
export function combineMeshes(a: GeometryMesh, b: GeometryMesh): GeometryMesh {
  if (a.quant !== b.quant) throw new GeometryError(`combineMeshes: quant ${a.quant} vs ${b.quant}`);
  const verts = new Int32Array(a.verts.length + b.verts.length);
  verts.set(a.verts, 0);
  verts.set(b.verts, a.verts.length);
  const tris = new Int32Array(a.tris.length + b.tris.length);
  tris.set(a.tris, 0);
  const shift = a.verts.length / 3;
  for (let i = 0; i < b.tris.length; i++) tris[a.tris.length + i] = (b.tris[i] as number) + shift;
  return { quant: a.quant, verts, tris, sightTriangles: a.sightTriangles ?? a.tris.length / 3 };
}

// ---- queries -----------------------------------------------------------------------------------------------------

/** Number of separating axes for an AABB against a triangle: the face normal, x, y, z, and 9 edge cross products. */
const AXES = 13;

export class MapGeometry {
  readonly quant: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** G6: triangles [0, sightTriangleCount) block sight and bullets (`traceSight`); the rest (player clips) only movement. */
  readonly sightTriangleCount: number;
  /** World bounds of all vertices. */
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  /** Vertex coordinates (world units). */
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly vz: Float64Array;
  private readonly tris: Int32Array;
  /** Per triangle: min x, y, z, max x, y, z. */
  private readonly bbox: Float64Array;
  /** Per triangle: unit normal (0, 0, 0 for a degenerate triangle). */
  private readonly normal: Float64Array;
  /** Broad phase: cells of GEOMETRY_CELL units from (gridX0, gridY0); cell k lists cellTris[cellStart[k] .. cellStart[k + 1]). */
  private readonly gridX0: number;
  private readonly gridY0: number;
  private readonly gridNX: number;
  private readonly gridNY: number;
  private readonly cellStart: Int32Array;
  private readonly cellTris: Int32Array;
  /** G6: per cell, the end (in cellTris) of its sight triangles, which come first in its list, and their z extent (±Infinity if none). */
  private readonly cellSightEnd: Int32Array;
  private readonly cellSightZMin: Float64Array;
  private readonly cellSightZMax: Float64Array;
  // Scratch for the separating-axis sweep (not re-entrant).
  private readonly ax = new Float64Array(AXES * 3);
  private sIn = 0;
  private sOut = 0;
  private sNX = 0;
  private sNY = 0;
  private sNZ = 0;
  private sDepth = 0;
  private sDeeper = false;
  private sDX = 0;
  private sDY = 0;
  private sDZ = 0;
  // Scratch polygons for clipping a triangle to a rectangle (≤ 7 vertices, x y z each).
  private readonly polyA = new Float64Array(24);
  private readonly polyB = new Float64Array(24);
  private clipMinZ = 0;
  private clipMaxZ = 0;

  constructor(mesh: GeometryMesh) {
    const nv = mesh.verts.length / 3;
    const nt = mesh.tris.length / 3;
    this.quant = mesh.quant;
    this.vertexCount = nv;
    this.triangleCount = nt;
    const sightTris = mesh.sightTriangles ?? nt;
    if (!Number.isInteger(sightTris) || sightTris < 0 || sightTris > nt) throw new GeometryError(`geometry: bad sightTriangles ${sightTris} (of ${nt})`);
    this.sightTriangleCount = sightTris;
    this.vx = new Float64Array(nv);
    this.vy = new Float64Array(nv);
    this.vz = new Float64Array(nv);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < nv; i++) {
      const x = (mesh.verts[i * 3] as number) / mesh.quant;
      const y = (mesh.verts[i * 3 + 1] as number) / mesh.quant;
      const z = (mesh.verts[i * 3 + 2] as number) / mesh.quant;
      this.vx[i] = x;
      this.vy[i] = y;
      this.vz[i] = z;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (nv === 0) {
      minX = minY = minZ = maxX = maxY = maxZ = 0;
    }
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxY = maxY;
    this.maxZ = maxZ;
    this.tris = new Int32Array(mesh.tris);
    this.bbox = new Float64Array(nt * 6);
    this.normal = new Float64Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const a = this.tris[t * 3] as number;
      const b = this.tris[t * 3 + 1] as number;
      const c = this.tris[t * 3 + 2] as number;
      const ax = this.vx[a] as number;
      const ay = this.vy[a] as number;
      const az = this.vz[a] as number;
      const bx = this.vx[b] as number;
      const by = this.vy[b] as number;
      const bz = this.vz[b] as number;
      const cx = this.vx[c] as number;
      const cy = this.vy[c] as number;
      const cz = this.vz[c] as number;
      this.bbox[t * 6] = Math.min(ax, bx, cx);
      this.bbox[t * 6 + 1] = Math.min(ay, by, cy);
      this.bbox[t * 6 + 2] = Math.min(az, bz, cz);
      this.bbox[t * 6 + 3] = Math.max(ax, bx, cx);
      this.bbox[t * 6 + 4] = Math.max(ay, by, cy);
      this.bbox[t * 6 + 5] = Math.max(az, bz, cz);
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const wx = cx - ax;
      const wy = cy - ay;
      const wz = cz - az;
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) {
        this.normal[t * 3] = nx / len;
        this.normal[t * 3 + 1] = ny / len;
        this.normal[t * 3 + 2] = nz / len;
      }
    }
    // Broad phase: every triangle in every cell its xy bounding box touches, ascending by triangle index.
    const g = GEOMETRY_CELL;
    this.gridX0 = Math.floor(minX / g) * g;
    this.gridY0 = Math.floor(minY / g) * g;
    this.gridNX = Math.floor((maxX - this.gridX0) / g) + 1;
    this.gridNY = Math.floor((maxY - this.gridY0) / g) + 1;
    const ncell = this.gridNX * this.gridNY;
    const counts = new Int32Array(ncell + 1);
    for (let t = 0; t < nt; t++) {
      const [i0, i1, j0, j1] = this.triCells(t);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * this.gridNX + i + 1;
          counts[k] = (counts[k] as number) + 1;
        }
      }
    }
    for (let k = 0; k < ncell; k++) counts[k + 1] = (counts[k + 1] as number) + (counts[k] as number);
    this.cellStart = counts;
    this.cellTris = new Int32Array(counts[ncell] as number);
    const fill = new Int32Array(ncell);
    for (let t = 0; t < nt; t++) {
      const [i0, i1, j0, j1] = this.triCells(t);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * this.gridNX + i;
          this.cellTris[(counts[k] as number) + (fill[k] as number)] = t;
          fill[k] = (fill[k] as number) + 1;
        }
      }
    }
    // G6: per cell, where its sight triangles end in its list (they come first: lists ascend by index) and their z
    // extent, so a sight trace skips a cell its segment passes above or below (open floors) without visiting it.
    this.cellSightEnd = new Int32Array(ncell);
    this.cellSightZMin = new Float64Array(ncell);
    this.cellSightZMax = new Float64Array(ncell);
    for (let k = 0; k < ncell; k++) {
      let q = counts[k] as number;
      const end = counts[k + 1] as number;
      let lo = Infinity;
      let hi = -Infinity;
      for (; q < end; q++) {
        const t = this.cellTris[q] as number;
        if (t >= sightTris) break;
        const zl = this.bbox[t * 6 + 2] as number;
        const zh = this.bbox[t * 6 + 5] as number;
        if (zl < lo) lo = zl;
        if (zh > hi) hi = zh;
      }
      this.cellSightEnd[k] = q;
      this.cellSightZMin[k] = lo;
      this.cellSightZMax[k] = hi;
    }
  }

  /** Decode data/geometry/mirage-geometry.bin and build the broad phase. */
  static fromBytes(bytes: Uint8Array): MapGeometry {
    return new MapGeometry(decodeGeometry(bytes));
  }

  private cellX(x: number): number {
    return Math.min(this.gridNX - 1, Math.max(0, Math.floor((x - this.gridX0) / GEOMETRY_CELL)));
  }

  private cellY(y: number): number {
    return Math.min(this.gridNY - 1, Math.max(0, Math.floor((y - this.gridY0) / GEOMETRY_CELL)));
  }

  /** Cell range of a triangle's xy bounding box: [i0, i1, j0, j1]. */
  private triCells(t: number): [number, number, number, number] {
    return [this.cellX(this.bbox[t * 6] as number), this.cellX(this.bbox[t * 6 + 3] as number), this.cellY(this.bbox[t * 6 + 1] as number), this.cellY(this.bbox[t * 6 + 4] as number)];
  }

  /** The three corners of triangle t: [ax, ay, az, bx, by, bz, cx, cy, cz] (allocates; for tools and tests). */
  triangle(t: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = this.tris[t * 3 + k] as number;
      out.push(this.vx[v] as number, this.vy[v] as number, this.vz[v] as number);
    }
    return out;
  }

  /** Unit normal of triangle t as stored (winding as in the source; may point down). */
  triangleNormal(t: number): [number, number, number] {
    return [this.normal[t * 3] as number, this.normal[t * 3 + 1] as number, this.normal[t * 3 + 2] as number];
  }

  /**
   * Visit, once each, the triangles whose bounding box overlaps the box (closed on both sides), ascending by cell
   * then by index. Returns false as soon as `fn` does. A triangle is visited in the first cell of the query range
   * that it covers, so no "seen" set is needed.
   */
  private forEachCandidate(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, fn: (t: number) => boolean): boolean {
    if (maxX < this.minX || maxY < this.minY || minX > this.maxX || minY > this.maxY || maxZ < this.minZ || minZ > this.maxZ) return true;
    const i0 = this.cellX(minX);
    const i1 = this.cellX(maxX);
    const j0 = this.cellY(minY);
    const j1 = this.cellY(maxY);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.gridNX + i;
        const end = this.cellStart[k + 1] as number;
        for (let q = this.cellStart[k] as number; q < end; q++) {
          const t = this.cellTris[q] as number;
          const b = t * 6;
          if ((this.bbox[b + 3] as number) < minX || (this.bbox[b] as number) > maxX) continue;
          if ((this.bbox[b + 4] as number) < minY || (this.bbox[b + 1] as number) > maxY) continue;
          if ((this.bbox[b + 5] as number) < minZ || (this.bbox[b + 2] as number) > maxZ) continue;
          if (Math.max(i0, this.cellX(this.bbox[b] as number)) !== i || Math.max(j0, this.cellY(this.bbox[b + 1] as number)) !== j) continue;
          if (!fn(t)) return false;
        }
      }
    }
    return true;
  }

  // ---- separating-axis sweep -------------------------------------------------------------------------------------

  /** Fill `ax` with the 13 candidate axes for triangle t (unnormalized; zero for degenerate ones). */
  private fillAxes(t: number): void {
    const a = this.tris[t * 3] as number;
    const b = this.tris[t * 3 + 1] as number;
    const c = this.tris[t * 3 + 2] as number;
    const ax = this.ax;
    ax[0] = this.normal[t * 3] as number;
    ax[1] = this.normal[t * 3 + 1] as number;
    ax[2] = this.normal[t * 3 + 2] as number;
    ax[3] = 1;
    ax[4] = 0;
    ax[5] = 0;
    ax[6] = 0;
    ax[7] = 1;
    ax[8] = 0;
    ax[9] = 0;
    ax[10] = 0;
    ax[11] = 1;
    const ex0 = (this.vx[b] as number) - (this.vx[a] as number);
    const ey0 = (this.vy[b] as number) - (this.vy[a] as number);
    const ez0 = (this.vz[b] as number) - (this.vz[a] as number);
    const ex1 = (this.vx[c] as number) - (this.vx[b] as number);
    const ey1 = (this.vy[c] as number) - (this.vy[b] as number);
    const ez1 = (this.vz[c] as number) - (this.vz[b] as number);
    const ex2 = (this.vx[a] as number) - (this.vx[c] as number);
    const ey2 = (this.vy[a] as number) - (this.vy[c] as number);
    const ez2 = (this.vz[a] as number) - (this.vz[c] as number);
    setEdgeAxes(ax, 12, ex0, ey0, ez0);
    setEdgeAxes(ax, 21, ex1, ey1, ez1);
    setEdgeAxes(ax, 30, ex2, ey2, ez2);
  }

  /**
   * Sweep the box (centre c, half extents h) by d against triangle t over t ∈ [0, 1] with closed slabs. Sets sIn /
   * sOut (overlap interval; −Infinity / +Infinity when unbounded), the entry normal sN* (unit, against the motion),
   * and, for the contact at t = 0, the shallowest axis: its depth sDepth, its outward normal sD* and whether the
   * motion goes deeper along it (sDeeper). Returns false if the box and the triangle never touch.
   */
  private sweep(t: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, dx: number, dy: number, dz: number): boolean {
    this.fillAxes(t);
    const a = this.tris[t * 3] as number;
    const b = this.tris[t * 3 + 1] as number;
    const c = this.tris[t * 3 + 2] as number;
    const ax0 = this.vx[a] as number;
    const ay0 = this.vy[a] as number;
    const az0 = this.vz[a] as number;
    const bx0 = this.vx[b] as number;
    const by0 = this.vy[b] as number;
    const bz0 = this.vz[b] as number;
    const cx0 = this.vx[c] as number;
    const cy0 = this.vy[c] as number;
    const cz0 = this.vz[c] as number;
    let tIn = -Infinity;
    let tOut = Infinity;
    let inX = 0;
    let inY = 0;
    let inZ = 0;
    let depth = Infinity;
    let depX = 0;
    let depY = 0;
    let depZ = 0;
    let deeper = false;
    const ax = this.ax;
    for (let k = 0; k < AXES; k++) {
      const lx = ax[k * 3] as number;
      const ly = ax[k * 3 + 1] as number;
      const lz = ax[k * 3 + 2] as number;
      const len = k < 4 ? 1 : Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (k === 0 ? lx === 0 && ly === 0 && lz === 0 : len < 1e-9) continue;
      const p0 = lx * ax0 + ly * ay0 + lz * az0;
      const p1 = lx * bx0 + ly * by0 + lz * bz0;
      const p2 = lx * cx0 + ly * cy0 + lz * cz0;
      const r = hx * Math.abs(lx) + hy * Math.abs(ly) + hz * Math.abs(lz);
      const pc = lx * cx + ly * cy + lz * cz;
      const lo = Math.min(p0, p1, p2) - r - pc;
      const hi = Math.max(p0, p1, p2) + r - pc;
      const s = lx * dx + ly * dy + lz * dz;
      // Contact at t = 0 on this axis (in world units): the shallower side and whether the motion goes deeper.
      const dLo = -lo / len;
      const dHi = hi / len;
      const dHere = Math.min(dLo, dHi);
      if (dHere < depth) {
        depth = dHere;
        if (dLo < dHi) {
          depX = -lx / len;
          depY = -ly / len;
          depZ = -lz / len;
          deeper = s > 0;
        } else if (dHi < dLo) {
          depX = lx / len;
          depY = ly / len;
          depZ = lz / len;
          deeper = s < 0;
        } else {
          // Both sides equally shallow (a flat box lying in a flat triangle's plane): no "deeper" direction.
          depX = (s > 0 ? -lx : lx) / len;
          depY = (s > 0 ? -ly : ly) / len;
          depZ = (s > 0 ? -lz : lz) / len;
          deeper = false;
        }
      }
      if (s === 0) {
        if (lo > 0 || hi < 0) return false;
        continue;
      }
      let e0 = lo / s;
      let e1 = hi / s;
      if (s < 0) {
        const tmp = e0;
        e0 = e1;
        e1 = tmp;
      }
      if (e0 > tIn) {
        tIn = e0;
        inX = (s > 0 ? -lx : lx) / len;
        inY = (s > 0 ? -ly : ly) / len;
        inZ = (s > 0 ? -lz : lz) / len;
      }
      if (e1 < tOut) tOut = e1;
      if (tIn > tOut) return false;
    }
    this.sIn = tIn;
    this.sOut = tOut;
    this.sNX = inX;
    this.sNY = inY;
    this.sNZ = inZ;
    this.sDepth = depth;
    this.sDX = depX;
    this.sDY = depY;
    this.sDZ = depZ;
    this.sDeeper = deeper;
    return true;
  }

  /**
   * True if any triangle cuts into the box [minX, maxX] × [minY, maxY] × [minZ, maxZ] deeper than OVERLAP_EPS.
   * A box resting on a floor or against a wall is free.
   */
  boxBlocked(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const hx = (maxX - minX) / 2;
    const hy = (maxY - minY) / 2;
    const hz = (maxZ - minZ) / 2;
    return !this.forEachCandidate(minX, minY, minZ, maxX, maxY, maxZ, (t) => !(this.sweep(t, cx, cy, cz, hx, hy, hz, 0, 0, 0) && this.sDepth > OVERLAP_EPS));
  }

  /** boxBlocked for a hull with its feet at (x, y, z). */
  hullBlocked(x: number, y: number, z: number, hull: Hull = STANDING_HULL): boolean {
    return this.boxBlocked(x - hull.halfWidth, y - hull.halfWidth, z, x + hull.halfWidth, y + hull.halfWidth, z + hull.height);
  }

  /**
   * Sweep a hull from feet position `from` to `to` (Source's TracePlayerBBox against the world). The hull stops at
   * the first triangle it would cut into, TRACE_SKIN short of it along the hit normal. Contacts already present at
   * the start (touching, or cutting in: `startSolid`) block only a move that goes deeper along their shallowest
   * axis, so a hull resting on a floor slides freely and a hull stuck in a wall can always back out.
   * Cost grows with the swept area: meant for per-tick moves (tens of units), not long lines (use traceLine).
   */
  traceBox(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, hull: Hull = STANDING_HULL): BoxTrace {
    return this.traceAabb(from.x, from.y, from.z + hull.height / 2, hull.halfWidth, hull.halfWidth, hull.height / 2, to.x - from.x, to.y - from.y, to.z - from.z, -hull.height / 2);
  }

  /**
   * The general sweep: box centre (cx, cy, cz), half extents (hx, hy, hz), motion (dx, dy, dz). The result's end
   * position is the centre plus `endOffsetZ` in z (traceBox passes −h/2 to report feet positions).
   */
  traceAabb(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, dx: number, dy: number, dz: number, endOffsetZ = 0): BoxTrace {
    const qMinX = cx - hx + Math.min(0, dx);
    const qMaxX = cx + hx + Math.max(0, dx);
    const qMinY = cy - hy + Math.min(0, dy);
    const qMaxY = cy + hy + Math.max(0, dy);
    const qMinZ = cz - hz + Math.min(0, dz);
    const qMaxZ = cz + hz + Math.max(0, dz);
    let best = Infinity;
    let bestTri = -1;
    let bnx = 0;
    let bny = 0;
    let bnz = 0;
    let bestPull = 0;
    let startSolid = false;
    let allSolid = false;
    this.forEachCandidate(qMinX, qMinY, qMinZ, qMaxX, qMaxY, qMaxZ, (t) => {
      if (!this.sweep(t, cx, cy, cz, hx, hy, hz, dx, dy, dz)) return true;
      const tIn = this.sIn;
      const tOut = this.sOut;
      if (tOut < 0 || tIn > 1) return true;
      let hitT: number;
      let nx: number;
      let ny: number;
      let nz: number;
      if (tIn >= 0) {
        hitT = tIn;
        nx = this.sNX;
        ny = this.sNY;
        nz = this.sNZ;
      } else {
        // In contact at t = 0.
        if (this.sDepth > OVERLAP_EPS) {
          startSolid = true;
          if (tOut >= 1) allSolid = true;
        }
        if (!this.sDeeper) return true;
        hitT = 0;
        nx = this.sDX;
        ny = this.sDY;
        nz = this.sDZ;
      }
      if (hitT < best || (hitT === best && t < bestTri)) {
        best = hitT;
        bestTri = t;
        bnx = nx;
        bny = ny;
        bnz = nz;
        const approach = -(nx * dx + ny * dy + nz * dz);
        bestPull = approach > 0 ? TRACE_SKIN / approach : 0;
      }
      return true;
    });
    const hit = bestTri >= 0;
    const fraction = hit ? Math.max(0, best - bestPull) : 1;
    return {
      fraction,
      endX: cx + dx * fraction,
      endY: cy + dy * fraction,
      endZ: cz + dz * fraction + endOffsetZ,
      hit,
      normalX: bnx,
      normalY: bny,
      normalZ: bnz,
      tri: bestTri,
      startSolid,
      allSolid,
    };
  }

  // ---- footprint queries -----------------------------------------------------------------------------------------

  /**
   * Clip triangle t to the open rectangle (x0, x1) × (y0, y1) and set clipMinZ / clipMaxZ to the z range of what is
   * left. Returns false if nothing is left, or only a piece lying on the rectangle's boundary (a wall that just
   * touches the footprint's side).
   */
  private clipToRect(t: number, x0: number, y0: number, x1: number, y1: number): boolean {
    let src = this.polyA;
    let dst = this.polyB;
    for (let k = 0; k < 3; k++) {
      const v = this.tris[t * 3 + k] as number;
      src[k * 3] = this.vx[v] as number;
      src[k * 3 + 1] = this.vy[v] as number;
      src[k * 3 + 2] = this.vz[v] as number;
    }
    let n = 3;
    for (let side = 0; side < 4; side++) {
      const axis = side < 2 ? 0 : 1;
      const keepGreater = side % 2 === 0;
      const off = side === 0 ? x0 : side === 1 ? x1 : side === 2 ? y0 : y1;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const j = i === 0 ? n - 1 : i - 1;
        const di = keepGreater ? (src[i * 3 + axis] as number) - off : off - (src[i * 3 + axis] as number);
        const dj = keepGreater ? (src[j * 3 + axis] as number) - off : off - (src[j * 3 + axis] as number);
        if (di >= 0 !== dj >= 0) {
          const f = dj / (dj - di);
          for (let q = 0; q < 3; q++) dst[m * 3 + q] = (src[j * 3 + q] as number) + ((src[i * 3 + q] as number) - (src[j * 3 + q] as number)) * f;
          dst[m * 3 + axis] = off;
          m++;
        }
        if (di >= 0) {
          dst[m * 3] = src[i * 3] as number;
          dst[m * 3 + 1] = src[i * 3 + 1] as number;
          dst[m * 3 + 2] = src[i * 3 + 2] as number;
          m++;
        }
      }
      n = m;
      if (n === 0) return false;
      const tmp = src;
      src = dst;
      dst = tmp;
    }
    // Drop pieces lying entirely on one side of the boundary.
    let onX0 = true;
    let onX1 = true;
    let onY0 = true;
    let onY1 = true;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = src[i * 3] as number;
      const y = src[i * 3 + 1] as number;
      const z = src[i * 3 + 2] as number;
      if (x > x0) onX0 = false;
      if (x < x1) onX1 = false;
      if (y > y0) onY0 = false;
      if (y < y1) onY1 = false;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    if (onX0 || onX1 || onY0 || onY1) return false;
    this.clipMinZ = zMin;
    this.clipMaxZ = zMax;
    return true;
  }

  /**
   * The highest surface top under the hull footprint (x ± halfWidth, y ± halfWidth; open) at or below z + up, and at
   * or above z − down: where a hull standing there would rest (Source's box rests on the highest point beneath it).
   * Triangles that rise above z + up inside the footprint (walls, steeper ground) are obstacles, not floor, and are
   * skipped. null if there is no surface in that range. Ties: the more upward-facing triangle, then the lower index.
   */
  floorBelow(x: number, y: number, z: number, halfWidth = STANDING_HULL.halfWidth, up = STEP_HEIGHT, down = 8192): FloorHit | null {
    const x0 = x - halfWidth;
    const x1 = x + halfWidth;
    const y0 = y - halfWidth;
    const y1 = y + halfWidth;
    const top = z + up;
    const bottom = z - down;
    let best = -Infinity;
    let bestTri = -1;
    let bestNz = -1;
    this.forEachCandidate(x0, y0, bottom, x1, y1, top, (t) => {
      if (!this.clipToRect(t, x0, y0, x1, y1)) return true;
      const zt = this.clipMaxZ;
      if (zt > top || zt < bottom) return true;
      const nz = Math.abs(this.normal[t * 3 + 2] as number);
      if (zt > best || (zt === best && (nz > bestNz || (nz === bestNz && t < bestTri)))) {
        best = zt;
        bestTri = t;
        bestNz = nz;
      }
      return true;
    });
    if (bestTri < 0) return null;
    const sign = (this.normal[bestTri * 3 + 2] as number) < 0 ? -1 : 1;
    const nx = sign * (this.normal[bestTri * 3] as number);
    const ny = sign * (this.normal[bestTri * 3 + 1] as number);
    const nz = sign * (this.normal[bestTri * 3 + 2] as number);
    return { z: best, normalX: nx, normalY: ny, normalZ: nz, walkable: nz >= WALKABLE_NZ, tri: bestTri };
  }

  /**
   * The lowest surface bottom strictly above z under the footprint (open), within `up`: the most a box with its
   * bottom at z could rise. Triangles that already reach down to z or below inside the footprint are skipped (they
   * are walls the box is in, or the floor). +Infinity if nothing is there.
   */
  ceilingAbove(x: number, y: number, z: number, halfWidth = STANDING_HULL.halfWidth, up = 8192): number {
    const x0 = x - halfWidth;
    const x1 = x + halfWidth;
    const y0 = y - halfWidth;
    const y1 = y + halfWidth;
    let best = Infinity;
    this.forEachCandidate(x0, y0, z, x1, y1, z + up, (t) => {
      if (!this.clipToRect(t, x0, y0, x1, y1)) return true;
      const zb = this.clipMinZ;
      if (zb > z && zb <= z + up && zb < best) best = zb;
      return true;
    });
    return best;
  }

  /**
   * Every triangle under the footprint (open, as floorBelow clips them) with a part between zLo and zHi, as
   * [zMin, zMax, |nz|, tri] of the clipped piece, sorted by zMax descending, then |nz| descending, then tri. Repeated
   * floorBelow calls down one column are the same as walking this list (allocates; for tools and tests).
   */
  footprintSpans(x: number, y: number, halfWidth: number, zLo: number, zHi: number): number[][] {
    const x0 = x - halfWidth;
    const x1 = x + halfWidth;
    const y0 = y - halfWidth;
    const y1 = y + halfWidth;
    const out: number[][] = [];
    this.forEachCandidate(x0, y0, zLo, x1, y1, zHi, (t) => {
      if (this.clipToRect(t, x0, y0, x1, y1)) out.push([this.clipMinZ, this.clipMaxZ, Math.abs(this.normal[t * 3 + 2] as number), t]);
      return true;
    });
    return out.sort((p, q) => (q[1] as number) - (p[1] as number) || (q[2] as number) - (p[2] as number) || (p[3] as number) - (q[3] as number));
  }

  /**
   * Every surface crossing the vertical line at (x, y), as [z, |nz|] pairs sorted by z then |nz| (allocates; for tools
   * and tests).
   */
  surfacesAt(x: number, y: number): number[][] {
    const out: number[][] = [];
    this.forEachCandidate(x, y, -Infinity, x, y, Infinity, (t) => {
      const nz = this.normal[t * 3 + 2] as number;
      if (nz === 0) return true;
      const tri = this.triangle(t);
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = tri as [number, number, number, number, number, number, number, number, number];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (d === 0) return true;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) return true;
      out.push([l1 * az + l2 * bz + l3 * cz, Math.abs(nz)]);
      return true;
    });
    return out.sort((p, q) => (p[0] as number) - (q[0] as number) || (p[1] as number) - (q[1] as number));
  }

  // ---- segments --------------------------------------------------------------------------------------------------

  /**
   * First crossing of the segment a → b with any triangle, as a fraction in (0, 1); 1 if it is clear. Two-sided;
   * touching at an end or running inside a triangle's plane doesn't count. Walks the broad-phase cells along the
   * segment (a 2D DDA), so long sight lines cost in proportion to their length. `firstOnly`: return the first
   * crossing found (some crossing, not necessarily the nearest), for yes/no tests.
   */
  traceLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number, firstOnly = false): number {
    return this.segmentTrace(ax, ay, az, bx, by, bz, firstOnly, false);
  }

  /** True if the segment a → b crosses a triangle (any triangle, player clips included). */
  lineBlocked(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
    return this.segmentTrace(a.x, a.y, a.z, b.x, b.y, b.z, true, false) < 1;
  }

  /**
   * G6: `traceLine` against the sight triangles only ([0, sightTriangleCount): the world; G3's player clips don't
   * stop sight or bullets). What `sees`, bullets and grenade effects use (src/sim2d/mesh-sight.ts).
   */
  traceSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, firstOnly = false): number {
    return this.segmentTrace(ax, ay, az, bx, by, bz, firstOnly, true);
  }

  /** G6: true if the segment a → b crosses a sight triangle (eye to aim point; scalar arguments, no allocation). */
  sightBlocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.segmentTrace(ax, ay, az, bx, by, bz, true, true) < 1;
  }

  /**
   * The segment DDA behind traceLine and traceSight. Per cell it tests the triangles listed there (`sight`: only the
   * sight triangles, a prefix of the list), skipping a sight cell whose triangles' z extent misses the segment's z range
   * in the cell, and any triangle whose bounding box misses the segment's box in the cell (padded by SEGMENT_PAD). A
   * triangle the segment crosses is listed in the cell that holds the crossing point and passes both filters there.
   */
  private segmentTrace(ax: number, ay: number, az: number, bx: number, by: number, bz: number, firstOnly: boolean, sight: boolean): number {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    let best = 1;
    const g = GEOMETRY_CELL;
    // DDA over cells; the segment is clipped to the grid first.
    let i = Math.floor((ax - this.gridX0) / g);
    let j = Math.floor((ay - this.gridY0) / g);
    const iEnd = Math.floor((bx - this.gridX0) / g);
    const jEnd = Math.floor((by - this.gridY0) / g);
    const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepJ = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = dx !== 0 ? g / Math.abs(dx) : Infinity;
    const tDeltaY = dy !== 0 ? g / Math.abs(dy) : Infinity;
    let tMaxX = dx > 0 ? (this.gridX0 + (i + 1) * g - ax) / dx : dx < 0 ? (this.gridX0 + i * g - ax) / dx : Infinity;
    let tMaxY = dy > 0 ? (this.gridY0 + (j + 1) * g - ay) / dy : dy < 0 ? (this.gridY0 + j * g - ay) / dy : Infinity;
    let tCell = 0;
    const bbox = this.bbox;
    for (let guard = 0; guard < 1_000_000; guard++) {
      const tNext = Math.min(tMaxX, tMaxY, 1);
      if (i >= 0 && j >= 0 && i < this.gridNX && j < this.gridNY) {
        // The segment's box inside this cell, for the bounding-box filters.
        const za = az + dz * tCell;
        const zb = az + dz * tNext;
        const zLo = Math.min(za, zb) - SEGMENT_PAD;
        const zHi = Math.max(za, zb) + SEGMENT_PAD;
        const k = j * this.gridNX + i;
        const start = this.cellStart[k] as number;
        const end = sight ? (this.cellSightEnd[k] as number) : (this.cellStart[k + 1] as number);
        if (start < end && (!sight || ((this.cellSightZMax[k] as number) >= zLo && (this.cellSightZMin[k] as number) <= zHi))) {
          const xa = ax + dx * tCell;
          const xb = ax + dx * tNext;
          const ya = ay + dy * tCell;
          const yb = ay + dy * tNext;
          const xLo = Math.min(xa, xb) - SEGMENT_PAD;
          const xHi = Math.max(xa, xb) + SEGMENT_PAD;
          const yLo = Math.min(ya, yb) - SEGMENT_PAD;
          const yHi = Math.max(ya, yb) + SEGMENT_PAD;
          for (let q = start; q < end; q++) {
            const t = this.cellTris[q] as number;
            const bb = t * 6;
            if ((bbox[bb + 5] as number) < zLo || (bbox[bb + 2] as number) > zHi) continue;
            if ((bbox[bb + 3] as number) < xLo || (bbox[bb] as number) > xHi || (bbox[bb + 4] as number) < yLo || (bbox[bb + 1] as number) > yHi) continue;
            const f = this.segmentTri(t, ax, ay, az, dx, dy, dz);
            if (f < best) {
              best = f;
              if (firstOnly) return best;
            }
          }
        }
      }
      if (tNext >= best || tNext >= 1 || (i === iEnd && j === jEnd)) break;
      if (tMaxX < tMaxY) {
        tCell = tMaxX;
        tMaxX += tDeltaX;
        i += stepI;
      } else {
        tCell = tMaxY;
        tMaxY += tDeltaY;
        j += stepJ;
      }
    }
    return best;
  }

  /** Fraction in (0, 1) where the segment p + s·d crosses triangle t (closed triangle, open segment), else Infinity. */
  private segmentTri(t: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number): number {
    const nx = this.normal[t * 3] as number;
    const ny = this.normal[t * 3 + 1] as number;
    const nz = this.normal[t * 3 + 2] as number;
    const denom = nx * dx + ny * dy + nz * dz;
    if (denom === 0) return Infinity;
    const a = this.tris[t * 3] as number;
    const b = this.tris[t * 3 + 1] as number;
    const c = this.tris[t * 3 + 2] as number;
    const ax = this.vx[a] as number;
    const ay = this.vy[a] as number;
    const az = this.vz[a] as number;
    const s = (nx * (ax - px) + ny * (ay - py) + nz * (az - pz)) / denom;
    if (!(s > 0 && s < 1)) return Infinity;
    const qx = px + dx * s;
    const qy = py + dy * s;
    const qz = pz + dz * s;
    // Inside test: the point is on the inner side of each edge (within the plane), closed.
    const bx = this.vx[b] as number;
    const by = this.vy[b] as number;
    const bz = this.vz[b] as number;
    const cx = this.vx[c] as number;
    const cy = this.vy[c] as number;
    const cz = this.vz[c] as number;
    if (edgeSide(ax, ay, az, bx, by, bz, qx, qy, qz, nx, ny, nz) < 0) return Infinity;
    if (edgeSide(bx, by, bz, cx, cy, cz, qx, qy, qz, nx, ny, nz) < 0) return Infinity;
    if (edgeSide(cx, cy, cz, ax, ay, az, qx, qy, qz, nx, ny, nz) < 0) return Infinity;
    return s;
  }
}

/** Write X × e, Y × e and Z × e for edge e = (x, y, z) at ax[o .. o + 9). */
function setEdgeAxes(ax: Float64Array, o: number, x: number, y: number, z: number): void {
  ax[o] = 0;
  ax[o + 1] = -z;
  ax[o + 2] = y;
  ax[o + 3] = z;
  ax[o + 4] = 0;
  ax[o + 5] = -x;
  ax[o + 6] = -y;
  ax[o + 7] = x;
  ax[o + 8] = 0;
}

/** ((b − a) × (q − a)) · n: ≥ 0 if q is on the inner side of edge a → b of a triangle with normal n. */
function edgeSide(ax: number, ay: number, az: number, bx: number, by: number, bz: number, qx: number, qy: number, qz: number, nx: number, ny: number, nz: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const ez = bz - az;
  const wx = qx - ax;
  const wy = qy - ay;
  const wz = qz - az;
  return (ey * wz - ez * wy) * nx + (ez * wx - ex * wz) * ny + (ex * wy - ey * wx) * nz;
}
