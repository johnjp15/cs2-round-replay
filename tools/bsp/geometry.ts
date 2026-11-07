/**
 * X1: geometry from a Source BSP (docs/maps.md "Source BSP"): brushes as convex polygons (from their planes, the
 * way vbsp and the engine's collision see them), drawn faces as polygons, displacements as triangle grids, the
 * brushes of each brush model (the world is model 0) by walking its BSP tree, lightmap samples at points of a face,
 * and the static props' transforms.
 *
 * Everything is in Source units, z up, the map's own frame (the same frame as data/round.json for Mirage).
 */
import { BspError, BspFile, SURF, rgbExp, type BrushSide, type DispInfo, type DispVert, type Face, type Plane, type TexInfo } from './bsp';

/** A convex polygon: x y z per point, wound counter-clockwise seen from the outside (along `normal`). */
export interface Polygon {
  readonly points: Float64Array;
  readonly normal: readonly [number, number, number];
}

/** A brush side as a polygon, with its texinfo (−1: none) and whether it is a bevel. */
export interface BrushFace extends Polygon {
  readonly side: number;
  readonly texInfo: number;
}

const HUGE = 65536;
const CLIP_EPS = 0.01;

/** Clip a polygon to the half-space n·p ≤ d (keep what is behind the plane). */
export function clipPolygon(points: Float64Array, nx: number, ny: number, nz: number, d: number, eps = CLIP_EPS): Float64Array {
  const n = points.length / 3;
  if (n === 0) return points;
  const dist = new Float64Array(n);
  let front = 0;
  let back = 0;
  for (let i = 0; i < n; i++) {
    const s = (points[i * 3] as number) * nx + (points[i * 3 + 1] as number) * ny + (points[i * 3 + 2] as number) * nz - d;
    dist[i] = s;
    if (s > eps) front++;
    else if (s < -eps) back++;
  }
  if (front === 0) return points;
  if (back === 0) return new Float64Array(0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = dist[i] as number;
    const sj = dist[j] as number;
    if (si <= eps) out.push(points[i * 3] as number, points[i * 3 + 1] as number, points[i * 3 + 2] as number);
    if ((si > eps && sj < -eps) || (si < -eps && sj > eps)) {
      const t = si / (si - sj);
      for (let k = 0; k < 3; k++) out.push((points[i * 3 + k] as number) + ((points[j * 3 + k] as number) - (points[i * 3 + k] as number)) * t);
    }
  }
  return new Float64Array(out);
}

/** A huge square on the plane n·p = d, counter-clockwise seen from the front. */
export function baseWinding(nx: number, ny: number, nz: number, d: number): Float64Array {
  // The axis the normal is most along picks the "up" vector (as vbsp's BaseWindingForPlane).
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let ux = 0;
  let uy = 0;
  let uz = 0;
  if (az >= ax && az >= ay) ux = 1;
  else uz = 1;
  // up = up - n (up·n), normalised; right = up × n.
  const dot = ux * nx + uy * ny + uz * nz;
  ux -= nx * dot;
  uy -= ny * dot;
  uz -= nz * dot;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const rx = uy * nz - uz * ny;
  const ry = uz * nx - ux * nz;
  const rz = ux * ny - uy * nx;
  const ox = nx * d;
  const oy = ny * d;
  const oz = nz * d;
  const H = HUGE;
  // Counter-clockwise seen from +n: corners in the order (−r +u), (+r +u)... reversed below by the cross check.
  const pts = new Float64Array([
    ox - rx * H + ux * H, oy - ry * H + uy * H, oz - rz * H + uz * H,
    ox + rx * H + ux * H, oy + ry * H + uy * H, oz + rz * H + uz * H,
    ox + rx * H - ux * H, oy + ry * H - uy * H, oz + rz * H - uz * H,
    ox - rx * H - ux * H, oy - ry * H - uy * H, oz - rz * H - uz * H,
  ]);
  return polygonNormalSign(pts, nx, ny, nz) >= 0 ? pts : reverse(pts);
}

function reverse(p: Float64Array): Float64Array {
  const n = p.length / 3;
  const out = new Float64Array(p.length);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = p[(n - 1 - i) * 3 + k] as number;
  return out;
}

/** The sign of the polygon's area vector along n (Newell's method). */
function polygonNormalSign(p: Float64Array, nx: number, ny: number, nz: number): number {
  const n = p.length / 3;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 3] as number;
    const ay = p[i * 3 + 1] as number;
    const az = p[i * 3 + 2] as number;
    const bx = p[j * 3] as number;
    const by = p[j * 3 + 1] as number;
    const bz = p[j * 3 + 2] as number;
    x += (ay - by) * (az + bz);
    y += (az - bz) * (ax + bx);
    z += (ax - bx) * (ay + by);
  }
  return x * nx + y * ny + z * nz;
}

/**
 * The polygons of one brush: each non-bevel side's plane, clipped by every other side's plane (bevels included:
 * they only touch the brush). Sides that clip away (degenerate) are left out.
 */
export function brushFaces(planes: readonly Plane[], sides: readonly BrushSide[], firstSide: number, numSides: number): BrushFace[] {
  const out: BrushFace[] = [];
  for (let i = 0; i < numSides; i++) {
    const s = sides[firstSide + i];
    if (s === undefined) throw new BspError(`brush side ${firstSide + i} out of range`);
    if (s.bevel) continue;
    const p = planes[s.planeNum];
    if (p === undefined) throw new BspError(`plane ${s.planeNum} out of range`);
    let w = baseWinding(p.nx, p.ny, p.nz, p.dist);
    for (let j = 0; j < numSides && w.length > 0; j++) {
      if (j === i) continue;
      const o = sides[firstSide + j] as BrushSide;
      const q = planes[o.planeNum] as Plane;
      // Identical plane on another side (vbsp can duplicate): skip, or the polygon would vanish.
      if (o.planeNum === s.planeNum) continue;
      w = clipPolygon(w, q.nx, q.ny, q.nz, q.dist);
    }
    if (w.length >= 9) out.push({ points: w, normal: [p.nx, p.ny, p.nz], side: firstSide + i, texInfo: s.texInfo });
  }
  return out;
}

/** The brushes of a brush model (0: the world): every leaf brush under its head node, sorted, without repeats. */
export function modelBrushes(bsp: BspFile, modelIndex: number): number[] {
  const model = bsp.models()[modelIndex];
  if (model === undefined) throw new BspError(`model ${modelIndex} out of range`);
  const nodes = bsp.nodes();
  const leafs = bsp.leafs();
  const lb = bsp.leafBrushes();
  const set = new Set<number>();
  const stack: number[] = [model.headNode];
  while (stack.length > 0) {
    const n = stack.pop() as number;
    if (n < 0) {
      const leaf = leafs[-1 - n];
      if (leaf === undefined) throw new BspError(`leaf ${-1 - n} out of range`);
      for (let k = 0; k < leaf.numLeafBrushes; k++) set.add(lb[leaf.firstLeafBrush + k] as number);
      continue;
    }
    const node = nodes[n];
    if (node === undefined) throw new BspError(`node ${n} out of range`);
    stack.push(node.children[0], node.children[1]);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * A drawn face's polygon from its surfedges. The file's order is clockwise around the face's plane normal (the
 * front: `planes[face.planeNum]`, whatever `face.side` says, checked on the test maps); the result is reversed to
 * counter-clockwise around it.
 */
export function facePolygon(face: Face, verts: Float64Array, edges: Uint16Array, surfEdges: Int32Array): Float64Array {
  const n = face.numEdges;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const se = surfEdges[face.firstEdge + i];
    if (se === undefined) throw new BspError(`surfedge ${face.firstEdge + i} out of range`);
    const e = Math.abs(se);
    const v = se >= 0 ? (edges[e * 2] as number) : (edges[e * 2 + 1] as number);
    const o = (n - 1 - i) * 3;
    out[o] = verts[v * 3] as number;
    out[o + 1] = verts[v * 3 + 1] as number;
    out[o + 2] = verts[v * 3 + 2] as number;
  }
  return out;
}

/** A displacement's grid: (2^power + 1)² positions (x y z each), its triangles (vertex indices), the base (undisplaced) positions and the blend alphas. */
export interface DispMesh {
  readonly size: number;
  readonly positions: Float64Array;
  readonly base: Float64Array;
  readonly tris: Int32Array;
  readonly alphas: Float64Array;
  /** DISP_TRIS tags per triangle (0 if the lump is short). */
  readonly tags: Uint16Array;
}

/**
 * Build a displacement (bsp_tool's `displacement_mesh`, SDK 2013 `CCoreDispInfo`): rotate the base quad so its first
 * corner is the one nearest `startPosition` (A, B, C, D), place vertex i (row r = i / size, column c = i % size) at
 * lerp(lerp(A, D, c/n), lerp(B, C, c/n), r/n) plus its offset vector × distance, and triangulate each cell with the
 * diagonal alternating like the engine's (v10–v01 when r + c is even, v00–v11 when odd).
 */
export function displacementMesh(info: DispInfo, quad: Float64Array, dispVerts: readonly DispVert[], dispTris: Uint16Array): DispMesh {
  if (quad.length !== 12) throw new BspError(`displacement on a face with ${quad.length / 3} corners (expected 4)`);
  if (info.power < 1 || info.power > 4) throw new BspError(`displacement power ${info.power}`);
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot((quad[i * 3] as number) - info.startPosition.x, (quad[i * 3 + 1] as number) - info.startPosition.y, (quad[i * 3 + 2] as number) - info.startPosition.z);
    if (d < best - 1e-9) {
      best = d;
      start = i;
    }
  }
  const c = (k: number, a: number): number => quad[((start + k) % 4) * 3 + a] as number;
  const n = 1 << info.power;
  const size = n + 1;
  const count = size * size;
  const positions = new Float64Array(count * 3);
  const base = new Float64Array(count * 3);
  const alphas = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / size) / n;
    const col = (i % size) / n;
    const dv = dispVerts[info.dispVertStart + i];
    if (dv === undefined) throw new BspError(`disp vert ${info.dispVertStart + i} out of range`);
    for (let a = 0; a < 3; a++) {
      const ad = c(0, a) + (c(3, a) - c(0, a)) * col;
      const bc = c(1, a) + (c(2, a) - c(1, a)) * col;
      const p = ad + (bc - ad) * r;
      base[i * 3 + a] = p;
      positions[i * 3 + a] = p + (a === 0 ? dv.vx : a === 1 ? dv.vy : dv.vz) * dv.dist;
    }
    alphas[i] = dv.alpha;
  }
  const tris = new Int32Array(n * n * 2 * 3);
  const tags = new Uint16Array(n * n * 2);
  let t = 0;
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      const v00 = r * size + col;
      const v01 = v00 + 1;
      const v10 = v00 + size;
      const v11 = v10 + 1;
      if ((r + col) % 2 === 0) {
        tris.set([v00, v10, v01, v10, v11, v01], t * 3);
      } else {
        tris.set([v00, v10, v11, v01, v00, v11], t * 3);
      }
      tags[t] = dispTris[info.dispTriStart + t] ?? 0;
      tags[t + 1] = dispTris[info.dispTriStart + t + 1] ?? 0;
      t += 2;
    }
  }
  return { size, positions, base, tris, alphas, tags };
}

/** Texinfo flags of faces that aren't drawn (sky, nodraw, triggers, hints, skips). */
export const NODRAW_FLAGS = SURF.SKY | SURF.SKY2D | SURF.NODRAW | SURF.TRIGGER | SURF.HINT | SURF.SKIP;

/**
 * The lightmap of one face (style 0, the flat lightmap of bump-lit faces), sampled bilinearly at a world point
 * projected with the texinfo's lightmap vectors. Linear RGB; null when the face has no lightmap.
 */
export class FaceLightmap {
  private readonly w: number;
  private readonly h: number;

  constructor(
    private readonly light: Uint8Array,
    private readonly face: Face,
    private readonly ti: TexInfo,
  ) {
    this.w = face.lightmapSize[0] + 1;
    this.h = face.lightmapSize[1] + 1;
  }

  static of(light: Uint8Array, face: Face, ti: TexInfo | undefined): FaceLightmap | null {
    if (ti === undefined || face.lightOfs < 0 || face.styles[0] === 255) return null;
    const n = (face.lightmapSize[0] + 1) * (face.lightmapSize[1] + 1);
    if (face.lightOfs + n * 4 > light.length) return null;
    return new FaceLightmap(light, face, ti);
  }

  /** Luxel coordinates of a world point. */
  st(x: number, y: number, z: number): [number, number] {
    const [a, b] = this.ti.lightmapVecs;
    return [x * a[0] + y * a[1] + z * a[2] + a[3] - this.face.lightmapMins[0], x * b[0] + y * b[1] + z * b[2] + b[3] - this.face.lightmapMins[1]];
  }

  private texel(s: number, t: number): [number, number, number] {
    const i = Math.max(0, Math.min(this.w - 1, s));
    const j = Math.max(0, Math.min(this.h - 1, t));
    return rgbExp(this.light, this.face.lightOfs + (j * this.w + i) * 4);
  }

  /** Bilinear sample at luxel coordinates. */
  sampleSt(s: number, t: number): [number, number, number] {
    const s0 = Math.floor(s);
    const t0 = Math.floor(t);
    const fs = s - s0;
    const ft = t - t0;
    const a = this.texel(s0, t0);
    const b = this.texel(s0 + 1, t0);
    const c = this.texel(s0, t0 + 1);
    const d = this.texel(s0 + 1, t0 + 1);
    const out: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) out[k] = ((a[k] as number) * (1 - fs) + (b[k] as number) * fs) * (1 - ft) + ((c[k] as number) * (1 - fs) + (d[k] as number) * fs) * ft;
    return out;
  }

  sample(x: number, y: number, z: number): [number, number, number] {
    const [s, t] = this.st(x, y, z);
    return this.sampleSt(s, t);
  }

  /** The mean of every luxel (style 0). */
  mean(): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const c = rgbExp(this.light, this.face.lightOfs + i * 4);
      out[0] += c[0];
      out[1] += c[1];
      out[2] += c[2];
    }
    return [out[0] / n, out[1] / n, out[2] / n];
  }
}

/** Source's AngleMatrix (pitch, yaw, roll in degrees) as a row-major 3 × 3 rotation: world = M · local. */
export function angleMatrix(pitch: number, yaw: number, roll: number): Float64Array {
  const d = Math.PI / 180;
  const sp = Math.sin(pitch * d);
  const cp = Math.cos(pitch * d);
  const sy = Math.sin(yaw * d);
  const cy = Math.cos(yaw * d);
  const sr = Math.sin(roll * d);
  const cr = Math.cos(roll * d);
  return new Float64Array([
    cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy,
    cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy,
    -sp, sr * cp, cr * cp,
  ]);
}

/** Transform local points (x y z each) by a rotation, a uniform scale and an origin. */
export function transformPoints(local: Float64Array, m: Float64Array, scale: number, ox: number, oy: number, oz: number): Float64Array {
  const out = new Float64Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const x = (local[i] as number) * scale;
    const y = (local[i + 1] as number) * scale;
    const z = (local[i + 2] as number) * scale;
    out[i] = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z + ox;
    out[i + 1] = (m[3] as number) * x + (m[4] as number) * y + (m[5] as number) * z + oy;
    out[i + 2] = (m[6] as number) * x + (m[7] as number) * y + (m[8] as number) * z + oz;
  }
  return out;
}

/** The eight corners of a box as 12 triangles (x y z per vertex, 36 vertices). */
export function boxTriangles(min: readonly [number, number, number], max: readonly [number, number, number]): Float64Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const out: number[] = [];
  for (const q of quads) {
    for (const k of [q[0], q[1], q[2], q[0], q[2], q[3]]) out.push(...(c[k as number] as number[]));
  }
  return new Float64Array(out);
}

/** Fan-triangulate a convex polygon (x y z per point) into triangles (x y z per vertex). */
export function fan(points: Float64Array): Float64Array {
  const n = points.length / 3;
  if (n < 3) return new Float64Array(0);
  const out = new Float64Array((n - 2) * 9);
  for (let i = 1; i < n - 1; i++) {
    const o = (i - 1) * 9;
    for (let k = 0; k < 3; k++) {
      out[o + k] = points[k] as number;
      out[o + 3 + k] = points[i * 3 + k] as number;
      out[o + 6 + k] = points[(i + 1) * 3 + k] as number;
    }
  }
  return out;
}

