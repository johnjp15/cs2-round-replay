/**
 * G2: build Mirage's collision geometry for 3D movement from CS2's physics mesh, and validate it.
 *
 *   npx tsx tools/extract-geometry.ts            # data/geometry/mirage-geometry.bin + .json, mirage-height.png, docs/img/geometry-height.jpg
 *   npx tsx tools/extract-geometry.ts --check    # rebuild in memory; exit 1 if a committed file is stale
 *   npx tsx tools/extract-geometry.ts --report   # validation against the 2020 data (markdown on stdout, logs/geometry-report.json)
 *   npx tsx tools/extract-geometry.ts --bench    # query costs (µs per call)
 *   npm run geometry:extract                     # the first line
 *
 * Inputs (data/source/cs2/, see PROVENANCE.md): de_mirage.mesh (awpy AWMH collision mesh), de_mirage.png (CS2
 * radar, alpha = playable area), de_mirage.nav (CS2 nav, report only); data/round.json, data/mirage-nav.json and
 * data/tuning.json for the seeds and the comparison.
 *
 * Build (docs/geometry.md, "Format"):
 * 1. Read the AWMH mesh (float32 vertices, uint32 triangles).
 * 2. Quantize every coordinate to 1/QUANT unit (round half up), merge vertices that become equal (first one kept,
 *    in source order), drop triangles that repeat a vertex or have zero area (exact integer cross product), and
 *    drop repeated triangles (same three vertices, either winding; first kept).
 * 3. Rotate each triangle so its smallest vertex index comes first (winding kept) and sort by (a, b, c).
 * 4. Write G2GM v1 (src/sim2d/geometry.ts) and a manifest with the parameters, counts and SHA-256s.
 *
 * The height image: every radar pixel inside the CS2 radar's playable area (alpha 255, grown by MASK_GROW px) gets
 * its stand levels (surface tops under a 32 × 32 footprint where the standing or crouched hull fits on walkable
 * ground). Levels are linked to the 4 neighbours by walking (|Δz| ≤ 18), dropping (any height, if the hull fits
 * above the lower floor) and jumping (up to JUMP_UP, if the hull fits raised to the higher floor), and flooded from
 * the ten players' start positions. Each pixel then shows the floor under the pixel itself at the highest reachable
 * level within 16 units (one half hull), coloured by height and hill-shaded.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { parseRound, type PlayerId, type RoundData } from '../src/contracts/index';
import { parseTuning } from '../src/contracts/tuning';
import { CROUCHING_HULL, GEOMETRY_CELL, GEOMETRY_MAGIC, GEOMETRY_VERSION, MapGeometry, OVERLAP_EPS, STANDING_HULL, STEP_HEIGHT, TRACE_SKIN, WALKABLE_NZ, decodeGeometry, encodeGeometry, type GeometryMesh, type Hull } from '../src/sim2d/geometry';
import { NavMesh, areaZ, navOptionsFromTuning, type NavArea } from '../src/sim2d/nav';
import { encodePng } from './png';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MESH_PATH = 'data/source/cs2/de_mirage.mesh';
export const RADAR_PATH = 'data/source/cs2/de_mirage.png';
export const CS2_NAV_PATH = 'data/source/cs2/de_mirage.nav';
export const BIN_PATH = 'data/geometry/mirage-geometry.bin';
export const MANIFEST_PATH = 'data/geometry/mirage-geometry.json';
export const HEIGHT_PATH = 'data/geometry/mirage-height.png';
export const PREVIEW_PATH = 'docs/img/geometry-height.jpg';
export const FORMAT = 'cs2-round-replay/geometry@1';

/** Build parameters (written into the manifest). */
export const PARAMS = {
  /** Integer steps per world unit: coordinates become multiples of 1/8 unit (error ≤ 1/16; the source is decimated on an 8-unit grid). */
  quant: 8,
} as const;

/** Height-image parameters (also in the manifest). */
export const IMAGE = {
  /** Radar transform (docs/conventions.md): px = (x − originX) / unitsPerPx, py = (originY − y) / unitsPerPx. */
  originX: -3230,
  originY: 1713,
  unitsPerPx: 5,
  size: 1024,
  /** The radar's playable area (alpha 255) is grown by this many pixels before levels are computed. */
  maskGrow: 6,
  /** Highest jump onto a ledge counted as reachable (units; a CS2 crouch jump clears about 64). */
  jumpUp: 64,
  /** Colour ramp: floor height range (units) from deep blue to white. */
  zLow: -370,
  zHigh: 30,
} as const;

// ---- AWMH input ------------------------------------------------------------------------------------------------

export interface Awmh {
  readonly verts: Float64Array;
  readonly tris: Uint32Array;
}

export function readAwmh(bytes: Uint8Array): Awmh {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x484d5741) throw new Error('mesh: bad magic (expected AWMH)');
  if (dv.getUint32(4, true) !== 1) throw new Error(`mesh: unsupported version ${dv.getUint32(4, true)}`);
  const nv = dv.getUint32(8, true);
  const nt = dv.getUint32(12, true);
  if (16 + nv * 12 + nt * 12 !== bytes.length) throw new Error('mesh: size does not match the header');
  const verts = new Float64Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) verts[i] = dv.getFloat32(16 + i * 4, true);
  const tris = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) {
    const v = dv.getUint32(16 + nv * 12 + i * 4, true);
    if (v >= nv) throw new Error(`mesh: index ${v} out of range`);
    tris[i] = v;
  }
  return { verts, tris };
}

export interface BuildStats {
  sourceVertices: number;
  sourceTriangles: number;
  mergedVertices: number;
  unusedVertices: number;
  degenerateTriangles: number;
  duplicateTriangles: number;
  vertices: number;
  triangles: number;
}

/** Steps 2–3 of the build (see the file comment). Deterministic: integer keys, explicit sort orders. */
export function buildMesh(src: Awmh, quant: number): { mesh: GeometryMesh; stats: BuildStats } {
  const nv = src.verts.length / 3;
  const nt = src.tris.length / 3;
  const q = new Int32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) q[i] = Math.round((src.verts[i] as number) * quant);
  // Merge equal quantized vertices (first occurrence wins, source order).
  const key = (i: number): string => `${q[i * 3] as number},${q[i * 3 + 1] as number},${q[i * 3 + 2] as number}`;
  const firstOf = new Map<string, number>();
  const remap = new Int32Array(nv);
  for (let i = 0; i < nv; i++) {
    const k = key(i);
    const f = firstOf.get(k);
    if (f === undefined) {
      firstOf.set(k, i);
      remap[i] = i;
    } else remap[i] = f;
  }
  const mergedVertices = nv - firstOf.size;
  // Triangles: drop degenerate and repeated ones.
  const kept: number[] = [];
  const seen = new Set<string>();
  let degenerate = 0;
  let duplicate = 0;
  for (let t = 0; t < nt; t++) {
    const a = remap[src.tris[t * 3] as number] as number;
    const b = remap[src.tris[t * 3 + 1] as number] as number;
    const c = remap[src.tris[t * 3 + 2] as number] as number;
    const ux = (q[b * 3] as number) - (q[a * 3] as number);
    const uy = (q[b * 3 + 1] as number) - (q[a * 3 + 1] as number);
    const uz = (q[b * 3 + 2] as number) - (q[a * 3 + 2] as number);
    const wx = (q[c * 3] as number) - (q[a * 3] as number);
    const wy = (q[c * 3 + 1] as number) - (q[a * 3 + 1] as number);
    const wz = (q[c * 3 + 2] as number) - (q[a * 3 + 2] as number);
    if (a === b || b === c || a === c || (uy * wz - uz * wy === 0 && uz * wx - ux * wz === 0 && ux * wy - uy * wx === 0)) {
      degenerate++;
      continue;
    }
    const sorted = [a, b, c].sort((p, r) => p - r).join(',');
    if (seen.has(sorted)) {
      duplicate++;
      continue;
    }
    seen.add(sorted);
    kept.push(a, b, c);
  }
  // Compact the vertex list to used vertices, in source order.
  const used = new Uint8Array(nv);
  for (const v of kept) used[v] = 1;
  const newIndex = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let i = 0; i < nv; i++) if (used[i] === 1) newIndex[i] = n++;
  const verts = new Int32Array(n * 3);
  for (let i = 0; i < nv; i++) {
    const j = newIndex[i] as number;
    if (j < 0) continue;
    verts[j * 3] = q[i * 3] as number;
    verts[j * 3 + 1] = q[i * 3 + 1] as number;
    verts[j * 3 + 2] = q[i * 3 + 2] as number;
  }
  const list: [number, number, number][] = [];
  for (let k = 0; k < kept.length; k += 3) {
    let a = newIndex[kept[k] as number] as number;
    let b = newIndex[kept[k + 1] as number] as number;
    let c = newIndex[kept[k + 2] as number] as number;
    while (!(a < b && a < c)) {
      const x = a;
      a = b;
      b = c;
      c = x;
    }
    list.push([a, b, c]);
  }
  list.sort((p, r) => p[0] - r[0] || p[1] - r[1] || p[2] - r[2]);
  const tris = new Int32Array(list.length * 3);
  list.forEach((t, i) => tris.set(t, i * 3));
  return {
    mesh: { quant, verts, tris },
    stats: {
      sourceVertices: nv,
      sourceTriangles: nt,
      mergedVertices,
      unusedVertices: nv - mergedVertices - n,
      degenerateTriangles: degenerate,
      duplicateTriangles: duplicate,
      vertices: n,
      triangles: list.length,
    },
  };
}

// ---- PNG input (the CS2 radar) ---------------------------------------------------------------------------------

/** Decode an 8-bit RGBA, non-interlaced PNG (all five filters). Tools only. */
export function decodePngRgba(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('png: bad signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (o < bytes.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8);
      height = dv.getUint32(o + 12);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('png: only 8-bit RGBA, non-interlaced');
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] as number;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] as number;
      const a = x >= 4 ? (rgba[y * stride + x - 4] as number) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + x] as number) : 0;
      const c = x >= 4 && y > 0 ? (rgba[(y - 1) * stride + x - 4] as number) : 0;
      let p: number;
      if (f === 0) p = 0;
      else if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = Math.floor((a + b) / 2);
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgba[y * stride + x] = (v + p) % 256;
    }
  }
  return { width, height, rgba };
}

// ---- stand levels and reachability -----------------------------------------------------------------------------

/** A surface top under a 32 × 32 footprint where a hull fits on walkable ground. */
export interface StandLevel {
  z: number;
  /** The standing hull fits (else only the crouched one does). */
  standing: boolean;
}

/**
 * Stand levels at (x, y) between zTop and zBottom, highest first: surface tops under the standing footprint whose
 * triangle is walkable and where the crouched hull (at least) fits. Consecutive tops less than 1 unit apart count once.
 */
export function standLevels(g: MapGeometry, x: number, y: number, zTop: number, zBottom: number): StandLevel[] {
  const out: StandLevel[] = [];
  for (const l of surfaceTops(g, x, y, zTop, zBottom, STANDING_HULL.halfWidth)) {
    if (!l.walkable) continue;
    const standing = !g.hullBlocked(x, y, l.z, STANDING_HULL);
    if (standing || !g.hullBlocked(x, y, l.z, CROUCHING_HULL)) out.push({ z: l.z, standing });
  }
  return out;
}

/**
 * The successive floorBelow answers down a column (floorBelow(x, y, zc, halfWidth, 0, zc − zBottom) from zc = zTop,
 * then zc = previous z − 1, …), walkable or not, highest first; computed in one pass over footprintSpans.
 */
export function surfaceTops(g: MapGeometry, x: number, y: number, zTop: number, zBottom: number, halfWidth = 1): { z: number; walkable: boolean }[] {
  const spans = g.footprintSpans(x, y, halfWidth, zBottom, zTop);
  const out: { z: number; walkable: boolean }[] = [];
  let zc = zTop;
  for (const s of spans) {
    const top = s[1] as number;
    if (top > zc || top < zBottom) continue;
    // The spans are sorted like floorBelow's preference, so the first one at or below zc is its answer.
    out.push({ z: top, walkable: (s[2] as number) >= WALKABLE_NZ });
    zc = top - 1;
  }
  return out;
}

export interface LevelGrid {
  readonly size: number;
  /** Levels of pixel p: z[start[p] .. start[p + 1]), highest first. */
  readonly start: Int32Array;
  readonly z: Float64Array;
  readonly standing: Uint8Array;
  /** 1 if reachable from the seeds. */
  readonly reach: Uint8Array;
  /** Playable mask (radar alpha 255). */
  readonly mask: Uint8Array;
  readonly stats: Record<string, number>;
}

export function pixelCentre(px: number, py: number): { x: number; y: number } {
  return { x: IMAGE.originX + (px + 0.5) * IMAGE.unitsPerPx, y: IMAGE.originY - (py + 0.5) * IMAGE.unitsPerPx };
}

export function worldToPixel(x: number, y: number): { px: number; py: number } {
  return { px: Math.floor((x - IMAGE.originX) / IMAGE.unitsPerPx), py: Math.floor((IMAGE.originY - y) / IMAGE.unitsPerPx) };
}

/** Stand levels for every pixel of the grown playable mask, and their reachability from the seeds. */
export function buildLevels(g: MapGeometry, radarRgba: Uint8Array, seeds: readonly { x: number; y: number; z: number }[]): LevelGrid {
  const N = IMAGE.size;
  const mask = new Uint8Array(N * N);
  for (let p = 0; p < N * N; p++) mask[p] = radarRgba[p * 4 + 3] === 255 ? 1 : 0;
  const grown = new Uint8Array(N * N);
  const r = IMAGE.maskGrow;
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      if (mask[py * N + px] !== 1) continue;
      for (let j = Math.max(0, py - r); j <= Math.min(N - 1, py + r); j++) for (let i = Math.max(0, px - r); i <= Math.min(N - 1, px + r); i++) grown[j * N + i] = 1;
    }
  }
  const start = new Int32Array(N * N + 1);
  const zs: number[] = [];
  const st: number[] = [];
  for (let p = 0; p < N * N; p++) {
    start[p] = zs.length;
    if (grown[p] !== 1) continue;
    const c = pixelCentre(p % N, Math.floor(p / N));
    for (const l of standLevels(g, c.x, c.y, g.maxZ + 1, g.minZ - 1)) {
      zs.push(l.z);
      st.push(l.standing ? 1 : 0);
    }
  }
  start[N * N] = zs.length;
  const z = Float64Array.from(zs);
  const standing = Uint8Array.from(st);
  const reach = new Uint8Array(zs.length);
  // Flood fill (BFS, FIFO) from the level nearest to each seed.
  const queue: number[] = [];
  for (const s of seeds) {
    const { px, py } = worldToPixel(s.x, s.y);
    const p = py * N + px;
    let best = -1;
    for (let k = start[p] as number; k < (start[p + 1] as number); k++) if (best < 0 || Math.abs((z[k] as number) - s.z) < Math.abs((z[best] as number) - s.z)) best = k;
    if (best >= 0 && reach[best] === 0) {
      reach[best] = 1;
      queue.push(best);
    }
  }
  const pixelOf = new Int32Array(zs.length);
  for (let p = 0; p < N * N; p++) for (let k = start[p] as number; k < (start[p + 1] as number); k++) pixelOf[k] = p;
  let walkEdges = 0;
  let dropEdges = 0;
  let jumpEdges = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi] as number;
    const p = pixelOf[k] as number;
    const px = p % N;
    const py = Math.floor(p / N);
    const zk = z[k] as number;
    const hull: Hull = standing[k] === 1 ? STANDING_HULL : CROUCHING_HULL;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const qx = px + dx;
      const qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= N || qy >= N) continue;
      const q = qy * N + qx;
      const cq = pixelCentre(qx, qy);
      for (let m = start[q] as number; m < (start[q + 1] as number); m++) {
        if (reach[m] === 1) continue;
        const zm = z[m] as number;
        let ok = false;
        if (Math.abs(zm - zk) <= STEP_HEIGHT) {
          ok = true;
          walkEdges++;
        } else if (zm < zk) {
          // Walk off the ledge: the hull fits above the lower floor at the upper floor's height.
          if (!g.hullBlocked(cq.x, cq.y, zk, hull)) {
            ok = true;
            dropEdges++;
          }
        } else if (zm - zk <= IMAGE.jumpUp) {
          // Jump: the hull fits raised to the upper floor where it stands.
          const cp = pixelCentre(px, py);
          if (!g.hullBlocked(cp.x, cp.y, zm, CROUCHING_HULL)) {
            ok = true;
            jumpEdges++;
          }
        }
        if (ok) {
          reach[m] = 1;
          queue.push(m);
        }
      }
    }
  }
  let reachable = 0;
  for (const v of reach) reachable += v;
  let maskPx = 0;
  for (const v of mask) maskPx += v;
  let grownPx = 0;
  for (const v of grown) grownPx += v;
  return { size: N, start, z, standing, reach, mask, stats: { maskPixels: maskPx, grownPixels: grownPx, levels: zs.length, reachableLevels: reachable, walkEdges, dropEdges, jumpEdges } };
}

/** The highest reachable level within 16 units (Chebyshev 3 px) of each pixel, and the floor under the pixel there. */
export function displayHeights(g: MapGeometry, lv: LevelGrid): Float64Array {
  const N = lv.size;
  const out = new Float64Array(N * N).fill(NaN);
  const R = 3;
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const p = py * N + px;
      if (lv.mask[p] !== 1) continue;
      const cands: number[] = [];
      for (let j = Math.max(0, py - R); j <= Math.min(N - 1, py + R); j++) {
        for (let i = Math.max(0, px - R); i <= Math.min(N - 1, px + R); i++) {
          const q = j * N + i;
          for (let k = lv.start[q] as number; k < (lv.start[q + 1] as number); k++) if (lv.reach[k] === 1) cands.push(lv.z[k] as number);
        }
      }
      if (cands.length === 0) continue;
      cands.sort((a, b) => b - a);
      const c = pixelCentre(px, py);
      let last = Infinity;
      for (const level of cands) {
        if (level > last - 8) continue;
        last = level;
        const f = g.floorBelow(c.x, c.y, level, IMAGE.unitsPerPx / 2, STEP_HEIGHT, 48);
        if (f !== null && f.walkable) {
          out[p] = f.z;
          break;
        }
      }
    }
  }
  return out;
}

/** Colour ramp by height (deep blue → teal → sand → white), hill-shaded from the north-west. */
export function heightImage(h: Float64Array, N: number): Uint8Array {
  const stops: [number, number, number, number][] = [
    [0, 30, 60, 140],
    [0.3, 40, 140, 170],
    [0.55, 120, 180, 110],
    [0.75, 215, 190, 120],
    [1, 250, 245, 235],
  ];
  const rgba = new Uint8Array(N * N * 4);
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const p = py * N + px;
      const z = h[p] as number;
      if (Number.isNaN(z)) continue;
      const u = Math.min(1, Math.max(0, (z - IMAGE.zLow) / (IMAGE.zHigh - IMAGE.zLow)));
      let k = 0;
      while (k < stops.length - 2 && u > (stops[k + 1] as [number, number, number, number])[0]) k++;
      const s0 = stops[k] as [number, number, number, number];
      const s1 = stops[k + 1] as [number, number, number, number];
      const f = (u - s0[0]) / (s1[0] - s0[0]);
      // Hill shade: slope toward the light (north-west) brightens; steps (|Δz| > 18 per px) are drawn as edges.
      const zl = px > 0 && !Number.isNaN(h[p - 1] as number) ? (h[p - 1] as number) : z;
      const zu = py > 0 && !Number.isNaN(h[p - N] as number) ? (h[p - N] as number) : z;
      const gx = z - zl;
      const gy = z - zu;
      let shade = 1 + Math.max(-0.35, Math.min(0.35, (gx + gy) * 0.02));
      if (Math.abs(gx) > STEP_HEIGHT || Math.abs(gy) > STEP_HEIGHT) shade *= 0.55;
      for (let c = 0; c < 3; c++) {
        const v = (s0[c + 1] as number) + ((s1[c + 1] as number) - (s0[c + 1] as number)) * f;
        rgba[p * 4 + c] = Math.max(0, Math.min(255, Math.round(v * shade)));
      }
      rgba[p * 4 + 3] = 255;
    }
  }
  return rgba;
}

/** A half-size preview on a dark background, as JPEG (docs). */
export function previewJpeg(rgba: Uint8Array, N: number): Uint8Array {
  const M = N / 2;
  const out = new Uint8Array(M * M * 4);
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const p = ((2 * y + j) * N + 2 * x + i) * 4;
            const a = (rgba[p + 3] as number) / 255;
            s += (rgba[p + c] as number) * a + 22 * (1 - a);
          }
        }
        out[(y * M + x) * 4 + c] = Math.round(s / 4);
      }
      out[(y * M + x) * 4 + 3] = 255;
    }
  }
  return new Uint8Array(jpeg.encode({ data: out, width: M, height: M }, 85).data);
}

// ---- build products ----------------------------------------------------------------------------------------------

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(ROOT, path)));
}

export function loadRound(): RoundData {
  return parseRound(readFileSync(resolve(ROOT, 'data/round.json'), 'utf8'));
}

/** The first track sample of every player (both spawns), the flood-fill seeds. */
export function spawnSeeds(round: RoundData): { x: number; y: number; z: number }[] {
  return round.players.map((p) => {
    const s = (round.tracks[p.id as PlayerId] as RoundData['tracks'][PlayerId]).samples[0];
    if (s === undefined) throw new Error(`no track for ${p.id}`);
    return { x: s.x, y: s.y, z: s.z };
  });
}

export interface Products {
  bin: Uint8Array;
  manifestText: string;
  heightPng: Uint8Array;
  heightRgba: Uint8Array;
  preview: Uint8Array;
  geometry: MapGeometry;
  levels: LevelGrid;
  heights: Float64Array;
}

export function buildAll(): Products {
  const meshBytes = read(MESH_PATH);
  const radarBytes = read(RADAR_PATH);
  const { mesh, stats } = buildMesh(readAwmh(meshBytes), PARAMS.quant);
  const bin = encodeGeometry(mesh);
  const geometry = new MapGeometry(decodeGeometry(bin));
  const radar = decodePngRgba(radarBytes);
  if (radar.width !== IMAGE.size || radar.height !== IMAGE.size) throw new Error('radar: expected 1024 × 1024');
  const levels = buildLevels(geometry, radar.rgba, spawnSeeds(loadRound()));
  const heights = displayHeights(geometry, levels);
  const heightRgba = heightImage(heights, IMAGE.size);
  const heightPng = new Uint8Array(encodePng(IMAGE.size, IMAGE.size, heightRgba));
  const preview = previewJpeg(heightRgba, IMAGE.size);
  const gz = gzipSync(bin, { level: 9 }).length;
  let shown = 0;
  for (const z of heights) if (!Number.isNaN(z)) shown++;
  const manifest = {
    format: FORMAT,
    note: 'Mirage collision geometry for 3D movement (G2): the CS2 physics mesh from awpy-data 2000942, quantized and re-encoded. Binary layout: src/sim2d/geometry.ts (G2GM). Built by tools/extract-geometry.ts; see docs/geometry.md. Derived from Valve game files: private repo / encrypted pages only.',
    binary: { file: BIN_PATH, magic: GEOMETRY_MAGIC, version: GEOMETRY_VERSION, bytes: bin.length, sha256: sha256(bin), gzipBytes: gz, gzipBase64Bytes: Math.ceil(gz / 3) * 4 },
    sources: [
      { file: MESH_PATH, sha256: sha256(meshBytes) },
      { file: RADAR_PATH, sha256: sha256(radarBytes) },
    ],
    params: PARAMS,
    stats,
    bounds: { minX: geometry.minX, minY: geometry.minY, minZ: geometry.minZ, maxX: geometry.maxX, maxY: geometry.maxY, maxZ: geometry.maxZ },
    queries: { cellSize: GEOMETRY_CELL, overlapEps: OVERLAP_EPS, traceSkin: TRACE_SKIN, walkableNz: WALKABLE_NZ, stepHeight: STEP_HEIGHT, standingHull: STANDING_HULL, crouchingHull: CROUCHING_HULL },
    heightImage: { file: HEIGHT_PATH, rgbaSha256: sha256(heightRgba), pixels: shown, ...IMAGE, levelStats: levels.stats },
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  return { bin, manifestText, heightPng, heightRgba, preview, geometry, levels, heights };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--report')) {
    runReport();
    return;
  }
  if (args.includes('--bench')) {
    runBench();
    return;
  }
  const t0 = process.hrtime.bigint();
  const p = buildAll();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (args.includes('--check')) {
    const stale: string[] = [];
    if (sha256(read(BIN_PATH)) !== sha256(p.bin)) stale.push(BIN_PATH);
    if (readFileSync(resolve(ROOT, MANIFEST_PATH), 'utf8') !== p.manifestText) stale.push(MANIFEST_PATH);
    if (stale.length > 0) {
      console.error(`stale: ${stale.join(', ')}: run npx tsx tools/extract-geometry.ts`);
      process.exit(1);
    }
    console.log(`${BIN_PATH} and ${MANIFEST_PATH} are up to date (${ms.toFixed(0)} ms)`);
    return;
  }
  for (const [path, bytes] of [
    [BIN_PATH, p.bin],
    [HEIGHT_PATH, p.heightPng],
    [PREVIEW_PATH, p.preview],
  ] as const) {
    mkdirSync(dirname(resolve(ROOT, path)), { recursive: true });
    writeFileSync(resolve(ROOT, path), bytes);
  }
  writeFileSync(resolve(ROOT, MANIFEST_PATH), p.manifestText, 'utf8');
  console.log(`wrote ${BIN_PATH} (${p.bin.length} bytes), ${MANIFEST_PATH}, ${HEIGHT_PATH} (${p.heightPng.length} bytes), ${PREVIEW_PATH} (${p.preview.length} bytes) in ${ms.toFixed(0)} ms`);
  console.log(JSON.stringify(p.levels.stats));
}

// ---- CS2 nav (report only) ---------------------------------------------------------------------------------------

/** One CS2 nav area: its polygon (3 or 4 corners, x y z) and id. */
export interface Cs2NavArea {
  readonly id: number;
  readonly corners: readonly number[];
}

/**
 * Read a CS2 .nav (version 36) as far as the areas (layout: ValveResourceFormat NavMesh/NavMeshFile.cs). KV3 blocks
 * are skipped by their header sizes; files with hiding spots, encounter paths, ladders on areas or movable meshes
 * other than none are refused (Mirage has none).
 */
export function readCs2Nav(bytes: Uint8Array): { version: number; subVersion: number; areas: Cs2NavArea[]; corners: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u8 = (): number => dv.getUint8(o++);
  const u16 = (): number => {
    const v = dv.getUint16(o, true);
    o += 2;
    return v;
  };
  const u32 = (): number => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = (): number => {
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  const kv3 = (): void => {
    o = Math.ceil(o / 8) * 8;
    if (u32() !== 0x4b563305) throw new Error('nav: expected a KV3 v5 block');
    o += 16; // format GUID
    const compression = u32();
    o += 4; // dictionary id, frame size
    o += 16; // counts: bytes1, bytes4, bytes8, types
    o += 4; // objects, arrays
    o += 8; // sizes: uncompressed total, compressed total
    const blocks = u32();
    const blobBytes = u32();
    o += 8; // bytes2 count, block compressed sizes
    const unc1 = u32();
    const comp1 = u32();
    const unc2 = u32();
    const comp2 = u32();
    o += 32; // buffer 2 counts, node counts
    o += compression === 0 ? unc1 + unc2 : comp1 + comp2;
    if (blocks > 0) {
      if (compression !== 0) throw new Error('nav: compressed KV3 blobs are not supported');
      o += blobBytes;
    }
  };
  if (u32() !== 0xfeedface) throw new Error('nav: bad magic');
  const version = u32();
  if (version !== 36) throw new Error(`nav: only version 36 is supported, got ${version}`);
  const subVersion = u32();
  u8(); // analyzed
  const places = u16();
  for (let i = 0; i < places; i++) {
    const len = u16();
    o += len;
  }
  u8(); // has unnamed areas
  kv3(); // movable mesh settings
  const nc = u32();
  const cornerXyz: number[] = [];
  for (let i = 0; i < nc * 3; i++) cornerXyz.push(f32());
  const np = u32();
  const polys: number[][] = [];
  for (let i = 0; i < np; i++) {
    const k = u8();
    const idx: number[] = [];
    for (let j = 0; j < k; j++) idx.push(u32());
    u32(); // movable mesh id
    polys.push(idx);
  }
  if ((u32() & 1) !== 0) {
    const gravity = u32();
    o += gravity * 12; // corner gravity
  }
  if (u32() !== 0) throw new Error('nav: movable meshes are not supported');
  kv3(); // game data
  const na = u32();
  const areas: Cs2NavArea[] = [];
  for (let i = 0; i < na; i++) {
    const id = u32();
    o += 8; // attribute flags
    u8(); // hull
    const poly = polys[u32()];
    if (poly === undefined) throw new Error('nav: bad polygon index');
    f32();
    for (let c = 0; c < poly.length; c++) {
      const connections = u32();
      o += connections * 8; // area id, edge
    }
    if (u8() !== 0) throw new Error('nav: hiding spots on areas are not supported');
    if (u32() !== 0) throw new Error('nav: encounter paths are not supported');
    const above = u32();
    o += above * 4; // ladders above
    const below = u32();
    o += below * 4; // ladders below
    const corners: number[] = [];
    for (const v of poly) corners.push(cornerXyz[v * 3] as number, cornerXyz[v * 3 + 1] as number, cornerXyz[v * 3 + 2] as number);
    areas.push({ id, corners });
  }
  return { version, subVersion, areas, corners: nc };
}

/** z of every CS2 nav polygon containing (x, y) (fan triangulation from corner 0), unsorted. */
export class Cs2NavIndex {
  private readonly cells = new Map<number, number[]>();
  private static readonly CELL = 64;

  constructor(readonly areas: readonly Cs2NavArea[]) {
    areas.forEach((a, i) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < a.corners.length; k += 3) {
        x0 = Math.min(x0, a.corners[k] as number);
        x1 = Math.max(x1, a.corners[k] as number);
        y0 = Math.min(y0, a.corners[k + 1] as number);
        y1 = Math.max(y1, a.corners[k + 1] as number);
      }
      for (let j = Math.floor(y0 / Cs2NavIndex.CELL); j <= Math.floor(y1 / Cs2NavIndex.CELL); j++) {
        for (let q = Math.floor(x0 / Cs2NavIndex.CELL); q <= Math.floor(x1 / Cs2NavIndex.CELL); q++) {
          const key = j * 100000 + q;
          const list = this.cells.get(key);
          if (list === undefined) this.cells.set(key, [i]);
          else list.push(i);
        }
      }
    });
  }

  zAt(x: number, y: number): number[] {
    const out: number[] = [];
    const key = Math.floor(y / Cs2NavIndex.CELL) * 100000 + Math.floor(x / Cs2NavIndex.CELL);
    for (const i of this.cells.get(key) ?? []) {
      const c = (this.areas[i] as Cs2NavArea).corners;
      for (let k = 3; k + 3 < c.length; k += 3) {
        const z = triZ(c[0] as number, c[1] as number, c[2] as number, c[k] as number, c[k + 1] as number, c[k + 2] as number, c[k + 3] as number, c[k + 4] as number, c[k + 5] as number, x, y);
        if (z !== null) {
          out.push(z);
          break;
        }
      }
    }
    return out;
  }
}

/** Height of the triangle at (x, y) if (x, y) is inside it (closed), else null. */
function triZ(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, x: number, y: number): number | null {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (d === 0) return null;
  const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return null;
  return l1 * az + l2 * bz + l3 * cz;
}

// ---- report ------------------------------------------------------------------------------------------------------

const DZ_BINS = [1, 2, 4, 8, 16, 32, 64] as const;

function histogram(values: readonly number[], none: number): string {
  const labels = ['≤ 1', '1–2', '2–4', '4–8', '8–16', '16–32', '32–64', '> 64', 'no floor'];
  const counts = new Array<number>(labels.length).fill(0);
  for (const v of values) {
    let k = DZ_BINS.findIndex((b) => v <= b);
    if (k < 0) k = DZ_BINS.length;
    counts[k] = (counts[k] as number) + 1;
  }
  counts[labels.length - 1] = none;
  const total = values.length + none;
  const row = (cells: (string | number)[]): string => `| ${cells.join(' | ')} |`;
  return [row(['|Δz| (units)', ...labels]), row(['---', ...labels.map(() => '---:')]), row(['samples', ...counts]), row(['share', ...counts.map((c) => `${((100 * c) / Math.max(1, total)).toFixed(1)} %`)])].join('\n');
}

function nearest(levels: readonly number[], z: number): number | null {
  let best: number | null = null;
  for (const l of levels) if (best === null || Math.abs(l - z) < Math.abs(best - z)) best = l;
  return best;
}

function median(v: readonly number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
}

/**
 * A position check against the CS2 geometry. `kind`:
 * - ok: a standing or crouched hull fits on walkable ground within ±8 of z at (x, y);
 * - snap: not ok, but a small correction fixes it: a stand level within ±24 of z at (x, y) (the 2020 nav's heights,
 *   which the recorded z come from, are off by up to ~25 on stairs and ramps), or a spot within 16 units (the
 *   recording's position error) with a stand level within ±8;
 * - far: the nearest spot with a stand level within ±24 of z is 16–64 units away;
 * - impossible: no such spot within 64 units.
 * `blocked` says whether walkable ground lies within ±8 under the footprint (the hull overlaps a wall or a prop) as
 * opposed to no ground at that height.
 */
export interface SpotCheck {
  kind: 'ok' | 'snap' | 'far' | 'impossible';
  blocked: boolean;
  /** Nearest stand level at (x, y) (any z in −256 … +128), or null. */
  standZ: number | null;
  /** Distance (units) to the nearest spot with a stand level within ±8 of z, ≤ 64, or null. */
  dist8: number | null;
  /** The same within ±24 of z. */
  dist24: number | null;
}

/** Probe offsets: rings every 4 units up to 64, 16 directions each, nearest first. */
const PROBES: [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (let r = 4; r <= 64; r += 4) for (let k = 0; k < 16; k++) out.push([r * Math.cos((k * Math.PI) / 8), r * Math.sin((k * Math.PI) / 8), r]);
  return out;
})();

function probe(g: MapGeometry, x: number, y: number, z: number, tol: number, maxR: number): number | null {
  for (const [dx, dy, r] of PROBES) {
    if (r > maxR) break;
    if (standLevels(g, x + dx, y + dy, z + tol, z - tol).length > 0) return r;
  }
  return null;
}

export function checkSpot(g: MapGeometry, x: number, y: number, z: number): SpotCheck {
  const standZ = nearest(
    standLevels(g, x, y, z + 128, z - 256).map((l) => l.z),
    z,
  );
  const floors = surfaceTops(g, x, y, z + 8, z - 8, STANDING_HULL.halfWidth).filter((l) => l.walkable);
  const blocked = floors.length > 0;
  const dz = standZ === null ? Infinity : Math.abs(standZ - z);
  if (dz <= 8) return { kind: 'ok', blocked: false, standZ, dist8: 0, dist24: 0 };
  const dist8 = probe(g, x, y, z, 8, 64);
  const dist24 = dz <= 24 ? 0 : probe(g, x, y, z, 24, 64);
  const kind = dz <= 24 || (dist8 !== null && dist8 <= 16) ? 'snap' : dist24 !== null ? 'far' : 'impossible';
  return { kind, blocked, standZ, dist8, dist24 };
}

interface NavSample {
  x: number;
  y: number;
  z: number;
  area: number;
  patch: boolean;
  place: string;
  dz: number | null;
  meshZ: number | null;
  standDz: number | null;
  cs2NavZ: number | null;
}

function runReport(): void {
  const t0 = process.hrtime.bigint();
  const g = MapGeometry.fromBytes(read(BIN_PATH));
  const tuning = parseTuning(JSON.parse(readFileSync(resolve(ROOT, 'data/tuning.json'), 'utf8')) as unknown);
  const navJson = JSON.parse(readFileSync(resolve(ROOT, 'data/mirage-nav.json'), 'utf8')) as { meta: { sourceAreas: number } };
  const nav = NavMesh.fromJson(navJson, navOptionsFromTuning(tuning));
  const cs2 = readCs2Nav(read(CS2_NAV_PATH));
  const cs2Index = new Cs2NavIndex(cs2.areas);
  const round = loadRound();
  const radar = decodePngRgba(read(RADAR_PATH));
  const out: string[] = [];
  const json: Record<string, unknown> = {};

  // (a) every 25-unit sample of every 2020 nav area.
  const samples: NavSample[] = [];
  for (const a of nav.areas) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let x = a.x1 + 12.5; x < a.x2; x += 25) xs.push(x);
    for (let y = a.y1 + 12.5; y < a.y2; y += 25) ys.push(y);
    if (xs.length === 0) xs.push((a.x1 + a.x2) / 2);
    if (ys.length === 0) ys.push((a.y1 + a.y2) / 2);
    for (const y of ys) {
      for (const x of xs) {
        const z = areaZ(a, x, y);
        const tops = surfaceTops(g, x, y, z + 128, z - 256, 1)
          .filter((l) => l.walkable)
          .map((l) => l.z);
        const meshZ = nearest(tops, z);
        const stand = nearest(
          standLevels(g, x, y, z + 64, z - 128).map((l) => l.z),
          z,
        );
        samples.push({
          x,
          y,
          z,
          area: a.id,
          patch: a.id >= navJson.meta.sourceAreas,
          place: nav.places[a.place] ?? '',
          dz: meshZ === null ? null : Math.abs(meshZ - z),
          meshZ,
          standDz: stand === null ? null : Math.abs(stand - z),
          cs2NavZ: nearest(cs2Index.zAt(x, y), z),
        });
      }
    }
  }
  const dzs = (s: readonly NavSample[]): number[] => s.filter((p) => p.dz !== null).map((p) => p.dz as number);
  const noFloor = (s: readonly NavSample[]): number => s.filter((p) => p.dz === null).length;
  const src = samples.filter((s) => !s.patch);
  const pat = samples.filter((s) => s.patch);
  out.push('## (a) 2020 nav areas vs the CS2 mesh', '');
  out.push(`${samples.length} samples (25-unit grid in each of ${nav.areas.length} areas; ${src.length} in source areas, ${pat.length} in patch areas). |Δz| = distance from the nav height to the nearest walkable CS2 surface top under a 2 × 2 footprint at the sample, within −256 … +128.`, '');
  out.push('All samples:', '', histogram(dzs(samples), noFloor(samples)), '');
  out.push('Source areas only:', '', histogram(dzs(src), noFloor(src)), '');
  out.push('Patch areas only (holes filled from recorded positions):', '', histogram(dzs(pat), noFloor(pat)), '');
  const standOk = samples.filter((s) => s.standDz !== null && s.standDz <= 8).length;
  out.push(`A standing or crouched hull fits on a walkable CS2 floor within ±8 of the nav height at ${standOk} of ${samples.length} samples (${((100 * standOk) / samples.length).toFixed(1)} %).`, '');
  // CS2 nav agreement at the samples.
  const withCs2 = samples.filter((s) => s.cs2NavZ !== null && Math.abs((s.cs2NavZ as number) - s.z) <= 32);
  out.push(`${withCs2.length} samples (${((100 * withCs2.length) / samples.length).toFixed(1)} %) lie inside a CS2 nav polygon within 32 units of the 2020 height.`, '');
  // Failing regions: 8-connected clusters on the sample grid with |Δz| > 8 or no floor, nav heights within 32.
  const bad = samples.filter((s) => s.dz === null || s.dz > 8);
  const keyOf = (s: NavSample): string => `${Math.floor(s.x / 25)},${Math.floor(s.y / 25)}`;
  const byCell = new Map<string, number[]>();
  bad.forEach((s, i) => {
    const k = keyOf(s);
    const l = byCell.get(k);
    if (l === undefined) byCell.set(k, [i]);
    else l.push(i);
  });
  const comp = new Int32Array(bad.length).fill(-1);
  let nComp = 0;
  for (let i = 0; i < bad.length; i++) {
    if ((comp[i] as number) >= 0) continue;
    const stack = [i];
    comp[i] = nComp;
    while (stack.length > 0) {
      const k = stack.pop() as number;
      const s = bad[k] as NavSample;
      const cx = Math.floor(s.x / 25);
      const cy = Math.floor(s.y / 25);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const m of byCell.get(`${cx + dx},${cy + dy}`) ?? []) {
            if ((comp[m] as number) >= 0 || Math.abs((bad[m] as NavSample).z - s.z) > 32) continue;
            comp[m] = nComp;
            stack.push(m);
          }
        }
      }
    }
    nComp++;
  }
  const clusters: { members: NavSample[] }[] = [];
  for (let c = 0; c < nComp; c++) clusters.push({ members: [] });
  bad.forEach((s, i) => (clusters[comp[i] as number] as { members: NavSample[] }).members.push(s));
  clusters.sort((p, q) => q.members.length - p.members.length || (p.members[0] as NavSample).x - (q.members[0] as NavSample).x);
  const regionRows: Record<string, unknown>[] = [];
  out.push(`Regions where the CS2 mesh differs by more than 8 units or has no floor: ${bad.length} samples in ${nComp} clusters (8-connected on the 25-unit grid, nav heights within 32). Clusters of 3 or more samples:`, '');
  out.push('| # | place (2020 nav) | samples (patch) | x range | y range | 2020 z | 2020 slope | CS2 mesh z | CS2 nav z (inside) | CS2 radar | likely reason |', '| ---: | --- | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | --- |');
  clusters.forEach((cl, i) => {
    const m = cl.members;
    if (m.length < 3) return;
    const places = new Map<string, number>();
    for (const s of m) places.set(s.place, (places.get(s.place) ?? 0) + 1);
    const place = [...places.entries()].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]?.[0] ?? '';
    const mesh = m.filter((s) => s.meshZ !== null).map((s) => s.meshZ as number);
    const navz = m.filter((s) => s.cs2NavZ !== null).map((s) => s.cs2NavZ as number);
    const row = {
      id: i + 1,
      place,
      samples: m.length,
      patch: m.filter((s) => s.patch).length,
      x: [Math.min(...m.map((s) => s.x)), Math.max(...m.map((s) => s.x))],
      y: [Math.min(...m.map((s) => s.y)), Math.max(...m.map((s) => s.y))],
      z: median(m.map((s) => s.z)),
      meshZ: mesh.length > 0 ? median(mesh) : null,
      meshShare: mesh.length / m.length,
      cs2NavZ: navz.length > 0 ? median(navz) : null,
      cs2NavShare: navz.length / m.length,
      standOk: m.filter((s) => s.standDz !== null && s.standDz <= 8).length,
      slope: Math.max(...m.map((s) => Math.abs((nav.areas[s.area] as NavArea).z1 - (nav.areas[s.area] as NavArea).z2))),
      radar: m.filter((s) => {
        const q = worldToPixel(s.x, s.y);
        return q.px >= 0 && q.py >= 0 && q.px < IMAGE.size && q.py < IMAGE.size && radar.rgba[(q.py * IMAGE.size + q.px) * 4 + 3] === 255;
      }).length / m.length,
      reason: '',
    };
    const inCs2 = row.cs2NavShare >= 0.5 && row.cs2NavZ !== null;
    const cs2Agree = inCs2 && row.meshZ !== null && Math.abs((row.cs2NavZ as number) - row.meshZ) <= 12;
    const navsAgree = inCs2 && Math.abs((row.cs2NavZ as number) - row.z) <= 8;
    row.reason =
      row.patch / row.samples >= 0.5
        ? 'patch (recorded positions), not in the 2020 source nav'
        : row.radar < 0.5
          ? 'outside the CS2 playable area'
          : cs2Agree && row.slope >= 24
            ? '2020 nav height model on a slope (CS2 nav and mesh agree)'
            : cs2Agree
              ? 'CS2 nav and mesh agree, 2020 differs'
              : navsAgree
                ? 'both navs agree, the mesh differs (slope under a coarse nav polygon, or decimation)'
                : inCs2
                  ? 'all three differ'
                  : row.meshZ === null
                    ? 'no floor in the mesh or the CS2 nav'
                    : 'not in the CS2 nav (not walkable in CS2)';
    regionRows.push(row);
    const fmt = (v: number | null): string => (v === null ? '–' : v.toFixed(0));
    out.push(
      `| ${row.id} | ${place || '(unnamed)'} | ${row.samples} (${row.patch}) | ${row.x[0]} … ${row.x[1]} | ${row.y[0]} … ${row.y[1]} | ${fmt(row.z)} | ${fmt(row.slope)} | ${fmt(row.meshZ)}${row.meshShare < 1 ? ` (${(100 * row.meshShare).toFixed(0)} %)` : ''} | ${fmt(row.cs2NavZ)} (${(100 * row.cs2NavShare).toFixed(0)} %) | ${(100 * row.radar).toFixed(0)} % | ${row.reason} |`,
    );
  });
  out.push('');
  const reasons = new Map<string, number>();
  for (const r of regionRows) reasons.set(r['reason'] as string, (reasons.get(r['reason'] as string) ?? 0) + (r['samples'] as number));
  out.push('Samples in those clusters by likely reason: ' + [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('; ') + '.', '');
  json['navSamples'] = samples.length;
  json['navRegions'] = regionRows;

  // (b) every recorded track sample.
  out.push('## (b) Recorded track samples on the CS2 geometry', '');
  out.push(
    'ok = a standing or crouched hull fits on walkable CS2 ground within ±8 of the recorded z at the recorded (x, y). snap = not ok, but a stand level within ±24 of z at (x, y), or a spot within 16 units with one within ±8. far = the nearest spot with a stand level within ±24 is 16–64 units away. impossible = none within 64. blocked = walkable ground within ±8 under the footprint, but the hull overlaps a wall or prop. 2020 src = inside a source (not patch) area of the 2020 nav within 32 units of its height.',
    '',
  );
  out.push('| player | samples | observed | ok | snap | far | impossible | blocked (of not ok) | ok (observed) | on 2020 src | ok, on 2020 src |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const runs: Record<string, unknown>[] = [];
  const totals = { n: 0, obs: 0, ok: 0, snap: 0, far: 0, impossible: 0, blocked: 0, okObs: 0, src: 0, okSrc: 0 };
  const cross = new Map<string, number>();
  const byConf = new Map<string, { n: number; ok: number; snap: number }>();
  const onSource = (x: number, y: number, z: number): boolean => {
    for (const a of nav.areas) if (a.id < navJson.meta.sourceAreas && x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2 && Math.abs(areaZ(a, x, y) - z) <= 32) return true;
    return false;
  };
  for (const p of [...round.players].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const track = round.tracks[p.id as PlayerId] as RoundData['tracks'][PlayerId];
    const row = { n: 0, obs: 0, ok: 0, snap: 0, far: 0, impossible: 0, blocked: 0, okObs: 0, src: 0, okSrc: 0 };
    let run: { t0: number; t1: number; n: number; kinds: Map<string, number>; conf: Set<string>; dist: number[]; src: number; blocked: number; x: number; y: number; z: number } | null = null;
    const flush = (): void => {
      if (run === null) return;
      const kinds = [...run.kinds.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`);
      runs.push({ player: p.id, t0: run.t0, t1: run.t1, samples: run.n, kinds: kinds.join(', '), confidence: [...run.conf].sort().join('/'), distMax: run.dist.length > 0 ? Math.max(...run.dist) : null, distMissing: run.n - run.dist.length, onSource: run.src, blocked: run.blocked, at: { x: run.x, y: run.y, z: run.z }, place: nav.placeName({ x: run.x, y: run.y, z: run.z }) });
      run = null;
    };
    for (const s of track.samples) {
      const c = checkSpot(g, s.x, s.y, s.z);
      const src = onSource(s.x, s.y, s.z);
      row.n++;
      if (src) row.src++;
      const conf = byConf.get(s.confidence) ?? { n: 0, ok: 0, snap: 0 };
      conf.n++;
      if (c.kind === 'ok') conf.ok++;
      if (c.kind === 'snap') conf.snap++;
      byConf.set(s.confidence, conf);
      cross.set(`${src ? 'src' : 'off'}:${c.kind}`, (cross.get(`${src ? 'src' : 'off'}:${c.kind}`) ?? 0) + 1);
      if (s.confidence === 'observed') row.obs++;
      row[c.kind]++;
      if (c.kind !== 'ok' && c.blocked) row.blocked++;
      if (c.kind === 'ok') {
        if (s.confidence === 'observed') row.okObs++;
        if (src) row.okSrc++;
      }
      if (c.kind === 'ok' || c.kind === 'snap') {
        flush();
        continue;
      }
      if (run === null) run = { t0: s.t, t1: s.t, n: 0, kinds: new Map(), conf: new Set(), dist: [], src: 0, blocked: 0, x: s.x, y: s.y, z: s.z };
      run.t1 = s.t;
      run.n++;
      run.kinds.set(c.kind, (run.kinds.get(c.kind) ?? 0) + 1);
      run.conf.add(s.confidence);
      if (c.dist24 !== null) run.dist.push(c.dist24);
      if (src) run.src++;
      if (c.blocked) run.blocked++;
    }
    flush();
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += row[k];
    out.push(`| ${p.id} | ${row.n} | ${row.obs} | ${row.ok} | ${row.snap} | ${row.far} | ${row.impossible} | ${row.blocked} | ${row.okObs} / ${row.obs} | ${row.src} | ${row.okSrc} |`);
  }
  out.push(`| **all** | ${totals.n} | ${totals.obs} | ${totals.ok} | ${totals.snap} | ${totals.far} | ${totals.impossible} | ${totals.blocked} | ${totals.okObs} / ${totals.obs} | ${totals.src} | ${totals.okSrc} |`, '');
  out.push('By confidence: ' + [...byConf.entries()].sort().map(([k, v]) => `${k} ${v.ok} ok + ${v.snap} snap of ${v.n} (${((100 * (v.ok + v.snap)) / v.n).toFixed(1)} %)`).join('; ') + '.', '');
  out.push('Against the 2020 source nav (rows) — the same samples on the CS2 geometry (columns):', '');
  out.push('| | ok | snap | far | impossible |', '| --- | ---: | ---: | ---: | ---: |');
  for (const r of ['src', 'off']) out.push(`| ${r === 'src' ? 'on the 2020 source nav' : 'off it (patch or hole)'} | ${['ok', 'snap', 'far', 'impossible'].map((k) => cross.get(`${r}:${k}`) ?? 0).join(' | ')} |`);
  out.push('');
  out.push('Recorded path segments that are impossible or far on the CS2 geometry (runs of consecutive far / impossible samples; ok and snap samples end a run):', '');
  out.push('| player | t (s) | samples | kind | blocked | on 2020 src | confidence | where (2020 place, first sample) | nearest fit (±24) |', '| --- | --- | ---: | --- | ---: | ---: | --- | --- | --- |');
  for (const r of runs) {
    const at = r['at'] as { x: number; y: number; z: number };
    const dm = r['distMax'] as number | null;
    const miss = r['distMissing'] as number;
    out.push(`| ${r['player'] as string} | ${(r['t0'] as number).toFixed(1)}–${(r['t1'] as number).toFixed(1)} | ${r['samples'] as number} | ${r['kinds'] as string} | ${r['blocked'] as number} | ${r['onSource'] as number} | ${r['confidence'] as string} | ${r['place'] as string} (${at.x}, ${at.y}, ${at.z}) | ${dm === null ? '> 64' : `≤ ${dm}`}${miss > 0 && dm !== null ? ` (${miss} > 64)` : ''} |`);
  }
  out.push('');
  json['trackTotals'] = totals;
  json['trackCross'] = Object.fromEntries([...cross.entries()].sort());
  json['trackRuns'] = runs;

  // (c) CS2 nav vs CS2 mesh, and coverage.
  out.push('## (c) CS2 nav vs the CS2 mesh', '');
  const cs2Dz: number[] = [];
  let cs2None = 0;
  const cs2Bad: { x: number; y: number; z: number; mesh: number | null }[] = [];
  for (const a of cs2.areas) {
    const c = a.corners;
    const n = c.length / 3;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < n; k++) {
      x += (c[k * 3] as number) / n;
      y += (c[k * 3 + 1] as number) / n;
      z += (c[k * 3 + 2] as number) / n;
    }
    const tops = surfaceTops(g, x, y, z + 128, z - 256, 1)
      .filter((l) => l.walkable)
      .map((l) => l.z);
    const m = nearest(tops, z);
    if (m === null) cs2None++;
    else cs2Dz.push(Math.abs(m - z));
    if (m === null || Math.abs(m - z) > 8) cs2Bad.push({ x, y, z, mesh: m });
  }
  out.push(`CS2 nav: version ${cs2.version}, sub-version ${cs2.subVersion}, ${cs2.areas.length} areas (${cs2.corners} shared corners). |Δz| at each area's centroid between the nav polygon and the nearest walkable mesh surface:`, '');
  out.push(histogram(cs2Dz, cs2None), '');
  json['cs2NavMismatch'] = cs2Bad;
  // Coverage both ways on a 25-unit grid over the radar area.
  let both = 0;
  let onlyOld = 0;
  let onlyNew = 0;
  const onlyNewCells: { x: number; y: number }[] = [];
  const onlyOldCells: { x: number; y: number }[] = [];
  for (let y = -3000; y < 1800; y += 25) {
    for (let x = -3300; x < 1900; x += 25) {
      const cx = x + 12.5;
      const cy = y + 12.5;
      const inOld = nav.areaAt({ x: cx, y: cy }) !== null;
      const inNew = cs2Index.zAt(cx, cy).length > 0;
      if (inOld && inNew) both++;
      else if (inOld) {
        onlyOld++;
        onlyOldCells.push({ x: cx, y: cy });
      } else if (inNew) {
        onlyNew++;
        onlyNewCells.push({ x: cx, y: cy });
      }
    }
  }
  out.push(`Coverage on a 25-unit grid (2D): both navs ${both} cells, only the 2020 nav ${onlyOld}, only the CS2 nav ${onlyNew}.`, '');
  json['coverage'] = { both, onlyOld, onlyNew };
  json['onlyOldCells'] = onlyOldCells;
  json['onlyNewCells'] = onlyNewCells;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  out.push(`(report built in ${(ms / 1000).toFixed(1)} s)`);
  console.log(out.join('\n'));
  mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
  writeFileSync(resolve(ROOT, 'logs/geometry-report.json'), JSON.stringify(json, null, 1) + '\n');
}

// ---- bench -------------------------------------------------------------------------------------------------------

function runBench(): void {
  const bytes = read(BIN_PATH);
  let t = performance.now();
  const g = MapGeometry.fromBytes(bytes);
  const loadMs = performance.now() - t;
  const round = loadRound();
  // Positions: every observed sample of every player, at the stand level nearest its z (skipped if none).
  const pos: { x: number; y: number; z: number }[] = [];
  for (const p of round.players) {
    for (const s of (round.tracks[p.id as PlayerId] as RoundData['tracks'][PlayerId]).samples) {
      const l = nearest(
        standLevels(g, s.x, s.y, s.z + 32, s.z - 32).map((v) => v.z),
        s.z,
      );
      if (l !== null) pos.push({ x: s.x, y: s.y, z: l });
    }
  }
  const rows: [string, number][] = [];
  const time = (name: string, reps: number, fn: (i: number) => number): void => {
    let acc = 0;
    for (let i = 0; i < Math.min(reps, 2000); i++) acc += fn(i); // warm-up
    t = performance.now();
    for (let i = 0; i < reps; i++) acc += fn(i);
    const us = ((performance.now() - t) * 1000) / reps;
    rows.push([name, us]);
    if (acc === -1) console.log(acc);
  };
  const P = (i: number): { x: number; y: number; z: number } => pos[i % pos.length] as { x: number; y: number; z: number };
  const dirs = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)] as const);
  const R = 100000;
  time('hullBlocked (standing, at a stand level)', R, (i) => (g.hullBlocked(P(i).x, P(i).y, P(i).z + 0.03125) ? 1 : 0));
  time('floorBelow (16, up 18)', R, (i) => g.floorBelow(P(i).x, P(i).y, P(i).z + 1, 16, 18, 64)?.z ?? 0);
  time('ceilingAbove (16)', R, (i) => g.ceilingAbove(P(i).x, P(i).y, P(i).z, 16, 256));
  time('traceBox 4 u horizontal (8 directions)', R, (i) => {
    const p = P(i);
    const d = dirs[i % 8] as readonly [number, number];
    return g.traceBox({ x: p.x, y: p.y, z: p.z + 0.03125 }, { x: p.x + d[0] * 4, y: p.y + d[1] * 4, z: p.z + 0.03125 }).fraction;
  });
  time('traceBox 2 u down (ground check)', R, (i) => {
    const p = P(i);
    return g.traceBox({ x: p.x, y: p.y, z: p.z + 0.03125 }, { x: p.x, y: p.y, z: p.z - 2 }).fraction;
  });
  time('traceBox 18 u up (step up)', R, (i) => {
    const p = P(i);
    return g.traceBox({ x: p.x, y: p.y, z: p.z + 0.03125 }, { x: p.x, y: p.y, z: p.z + 18 }).fraction;
  });
  time('traceBox 4 u + 12 u fall (air move)', R, (i) => {
    const p = P(i);
    const d = dirs[i % 8] as readonly [number, number];
    return g.traceBox({ x: p.x, y: p.y, z: p.z + 12 }, { x: p.x + d[0] * 4, y: p.y + d[1] * 4, z: p.z }).fraction;
  });
  // Eye-to-eye lines between pawns at the same moment (as vision would ask), standing eyes.
  const pairs: [number, number][] = [];
  for (let k = 0; k + 1 < pos.length; k += 7) pairs.push([k, (k * 31 + 17) % pos.length]);
  time('lineBlocked eye to eye (recorded pairs)', 20000, (i) => {
    const [a, b] = pairs[i % pairs.length] as [number, number];
    const pa = P(a);
    const pb = P(b);
    return g.lineBlocked({ x: pa.x, y: pa.y, z: pa.z + 64 }, { x: pb.x, y: pb.y, z: pb.z + 64 }) ? 1 : 0;
  });
  const clear = pairs.filter(([a, b]) => !g.lineBlocked({ x: P(a).x, y: P(a).y, z: P(a).z + 64 }, { x: P(b).x, y: P(b).y, z: P(b).z + 64 }));
  let clearLen = 0;
  for (const [a, b] of clear) clearLen += Math.hypot(P(a).x - P(b).x, P(a).y - P(b).y);
  time(`lineBlocked eye to eye, clear lines only (${clear.length} of ${pairs.length}, mean ${(clearLen / Math.max(1, clear.length)).toFixed(0)} u)`, 20000, (i) => {
    const [a, b] = clear[i % clear.length] as [number, number];
    const pa = P(a);
    const pb = P(b);
    return g.lineBlocked({ x: pa.x, y: pa.y, z: pa.z + 64 }, { x: pb.x, y: pb.y, z: pb.z + 64 }) ? 1 : 0;
  });
  let len = 0;
  for (const [a, b] of pairs) len += Math.hypot(P(a).x - P(b).x, P(a).y - P(b).y);
  console.log(`decode + broad phase: ${loadMs.toFixed(1)} ms (${g.triangleCount} triangles); ${pos.length} positions; mean pair length ${(len / pairs.length).toFixed(0)} u`);
  console.log('| query | µs per call |', '\n| --- | ---: |');
  for (const [n, us] of rows) console.log(`| ${n} | ${us.toFixed(2)} |`);
}

export { areaZ, NavMesh, navOptionsFromTuning, parseTuning };
export type { NavArea };

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
