/**
 * H1: the CS2 world mesh as flat-shaded, vertex-coloured triangles for the 3D view (pure: no DOM, no Three.js;
 * tested in Node). docs/app3d.md "World colours".
 *
 * Input: the world mesh (`MapGeometry` of data/geometry/mirage-geometry.bin, no player clips) and the CS2 radar image
 * (data/source/cs2/de_mirage.png as RGBA) with its transform. Output: per tile of the map (TILE units square, so the
 * renderer can cull what is off screen) a position array (Three.js frame, src/app3d/coords.ts) and an RGB colour
 * array, three vertices per triangle, no sharing (flat shading).
 *
 * Colours. The mesh's winding is inconsistent (docs/geometry.md), so up and down are decided by space, not by the
 * normal's sign: a near-horizontal triangle (|nz| ≥ 0.7) is a **floor** if a short vertical segment above its centre
 * is free, else a **ceiling / underside** if the space below is free, else buried (dark).
 * - Floors take the radar's colour under their centre (the radar is CS2's own top-down art, so the sand, the
 *   tiles, the wooden crates and the blue doors come out in their colours), darkened when something solid is above
 *   within COVER_UNITS (interiors: Apartments, Connector, the underpass) and slightly by slope.
 * - Walls (|nz| < 0.7) are a sandstone palette, darker low and lighter high, shaded by how much they face the sun
 *   (two-sided: |n · sun| in the horizontal plane), tinted toward the colour of the radar just outside the wall
 *   (the floor in front of it), so walls next to blue doors or dark interiors pick that up.
 * - Undersides are dark. Outside the radar's playable area (alpha 0) the sand base colour stands in.
 * Every colour is a deterministic function of the data.
 */
import type { MapGeometry } from '../sim2d/index';
import { radarPx, toThree, type RadarTransform } from './coords';
import type { RenderMesh } from './render-package';

/** An RGBA image (ImageData-like). */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** Tile size for culling (units). */
export const TILE = 1024;
/** How far above (and below) a horizontal triangle space is probed to call it a floor (a ceiling). */
const PROBE_UNITS = 24;
/** A floor with something solid this far above it is indoors (darker). */
const COVER_UNITS = 256;
const WALKABLE_NZ = 0.7;

/** Mirage's sandstone walls, from low (shadowed base) to high (sunlit top), sRGB 0..1. */
export const SANDSTONE_LOW: readonly [number, number, number] = [0.55, 0.45, 0.33];
export const SANDSTONE_HIGH: readonly [number, number, number] = [0.86, 0.75, 0.57];
/** Floors outside the radar's art. */
export const SAND: readonly [number, number, number] = [0.78, 0.68, 0.52];
export const UNDERSIDE: readonly [number, number, number] = [0.16, 0.14, 0.12];
/** A wall's foot is this bright relative to its colour, rising to full over WALL_AO_UNITS. */
const WALL_FOOT = 0.72;
const WALL_AO_UNITS = 72;

/** ±3 % brightness per triangle from its index (a deterministic hash), so big flat walls show their facets. */
function grain(t: number): number {
  const h = Math.imul(t ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return ((h % 1000) / 1000 - 0.5) * 0.06;
}

/** Horizontal sun direction for wall shading (unit, Source x/y): from the south-west, as the radar's shadows fall. */
const SUN: readonly [number, number] = [-0.6, -0.8];
/** Wall heights mapped from low to high colour (Source z). */
const Z_LOW = -380;
const Z_HIGH = 200;

/** One tile's triangles: the radar-textured floors and the rest (vertex colour only). */
export interface WorldTile {
  readonly key: string;
  /** Floors with radar art: Three.js positions (9 per triangle), radar UVs (6 per triangle, 0..1, v down the image: row 0 is v 0) and a shade (RGB 0..1, multiplies the radar). */
  readonly floor: { readonly positions: Float32Array; readonly uvs: Float32Array; readonly colors: Float32Array; readonly triangles: number };
  /** Walls, undersides and floors outside the radar art: positions and sRGB colours (9 per triangle each). */
  readonly plain: { readonly positions: Float32Array; readonly colors: Float32Array; readonly triangles: number };
}

export interface WorldMeshStats {
  readonly triangles: number;
  readonly floors: number;
  readonly walls: number;
  readonly undersides: number;
  readonly indoorFloors: number;
  readonly tiles: number;
}

/** Mirage's floors (packed sand, flagstones), sRGB 0..1: the base the radar art is mapped onto. */
export const FLOOR_SAND: readonly [number, number, number] = [0.8, 0.7, 0.54];

/**
 * The floor texture made from the radar (pure, per pixel). The CS2 radar is stylized art: blue-grey and teal for the
 * lower levels, grey for the middle, brown for the upper ones, light grey boxes, coloured site outlines. Taken
 * literally the streets would be teal, so each pixel becomes Mirage's sand, lightened or darkened by the radar's
 * brightness (boxes and steps stay visible) and nudged 30 % toward the radar's hue (the levels stay apart, the
 * site outlines and the wooden / tiled areas keep a tint). Outside the playable area (alpha < 128): plain sand.
 */
export function floorArt(img: RgbaImage): { width: number; height: number; data: Uint8ClampedArray } {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  const d = img.data;
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    const a = d[o + 3] as number;
    let r = FLOOR_SAND[0];
    let g = FLOOR_SAND[1];
    let b = FLOOR_SAND[2];
    if (a >= 128) {
      const rr = (d[o] as number) / 255;
      const gg = (d[o + 1] as number) / 255;
      const bb = (d[o + 2] as number) / 255;
      const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      const k = Math.max(0.55, Math.min(1.25, 0.8 + 1.1 * (lum - 0.3)));
      const hue = lum > 0 ? 0.3 : 0;
      // The radar's colour at the sand's brightness, for the hue nudge.
      const scaleTo = lum > 0 ? (0.7 * k) / Math.max(0.05, lum) : 0;
      r = FLOOR_SAND[0] * k * (1 - hue) + Math.min(1, rr * scaleTo) * hue;
      g = FLOOR_SAND[1] * k * (1 - hue) + Math.min(1, gg * scaleTo) * hue;
      b = FLOOR_SAND[2] * k * (1 - hue) + Math.min(1, bb * scaleTo) * hue;
    }
    out[o] = Math.round(Math.min(1, r) * 255);
    out[o + 1] = Math.round(Math.min(1, g) * 255);
    out[o + 2] = Math.round(Math.min(1, b) * 255);
    out[o + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

export class RadarSampler {
  constructor(
    private readonly img: RgbaImage,
    private readonly t: RadarTransform,
  ) {}

  /** The radar colour at a Source point (sRGB 0..1), or null outside the image or its playable area (alpha < 128). */
  at(x: number, y: number): [number, number, number] | null {
    const { px, py } = radarPx(this.t, x, y);
    const i = Math.floor(px);
    const j = Math.floor(py);
    if (i < 0 || j < 0 || i >= this.img.width || j >= this.img.height) return null;
    const o = (j * this.img.width + i) * 4;
    const d = this.img.data;
    if ((d[o + 3] as number) < 128) return null;
    return [(d[o] as number) / 255, (d[o + 1] as number) / 255, (d[o + 2] as number) / 255];
  }
}

function mix(a: readonly number[], b: readonly number[], f: number): [number, number, number] {
  return [(a[0] as number) + ((b[0] as number) - (a[0] as number)) * f, (a[1] as number) + ((b[1] as number) - (a[1] as number)) * f, (a[2] as number) + ((b[2] as number) - (a[2] as number)) * f];
}

function scale(c: readonly number[], k: number): [number, number, number] {
  return [Math.min(1, (c[0] as number) * k), Math.min(1, (c[1] as number) * k), Math.min(1, (c[2] as number) * k)];
}

export type FaceKind = 'floor' | 'indoor' | 'wall' | 'underside';

/**
 * The kind and colour of one triangle (see the file comment). `textured`: a floor with radar art under its centre,
 * drawn with the radar as its texture; `rgb` is then the shade the texture is multiplied by.
 */
export function faceColor(g: MapGeometry, t: number, radar: RadarSampler): { kind: FaceKind; textured: boolean; rgb: [number, number, number] } {
  const v = g.triangle(t);
  const cx = ((v[0] as number) + (v[3] as number) + (v[6] as number)) / 3;
  const cy = ((v[1] as number) + (v[4] as number) + (v[7] as number)) / 3;
  const cz = ((v[2] as number) + (v[5] as number) + (v[8] as number)) / 3;
  const [nx, ny, nz] = g.triangleNormal(t);
  if (Math.abs(nz) >= WALKABLE_NZ) {
    const freeAbove = !g.lineBlocked({ x: cx, y: cy, z: cz + 0.5 }, { x: cx, y: cy, z: cz + PROBE_UNITS });
    if (freeAbove) {
      const art = radar.at(cx, cy);
      const covered = g.lineBlocked({ x: cx, y: cy, z: cz + PROBE_UNITS }, { x: cx, y: cy, z: cz + COVER_UNITS });
      const slope = 0.85 + 0.15 * Math.abs(nz);
      const k = (covered ? 0.62 : 1) * slope;
      if (art !== null) return { kind: covered ? 'indoor' : 'floor', textured: true, rgb: covered ? scale(mix([1, 1, 1], [0.85, 0.78, 0.7], 0.5), k) : [k, k, k] };
      return { kind: covered ? 'indoor' : 'floor', textured: false, rgb: scale(SAND, k) };
    }
    return { kind: 'underside', textured: false, rgb: [UNDERSIDE[0], UNDERSIDE[1], UNDERSIDE[2]] };
  }
  const h = Math.min(1, Math.max(0, (cz - Z_LOW) / (Z_HIGH - Z_LOW)));
  const sand = mix(SANDSTONE_LOW, SANDSTONE_HIGH, h);
  // The floor just in front of the wall (either side: the normal's sign is arbitrary), for a tint.
  const hl = Math.sqrt(nx * nx + ny * ny) || 1;
  const fx = nx / hl;
  const fy = ny / hl;
  const near = radar.at(cx + fx * 24, cy + fy * 24) ?? radar.at(cx - fx * 24, cy - fy * 24);
  const tinted = near === null ? sand : mix(sand, near, 0.3);
  const sun = Math.abs(fx * (SUN[0] as number) + fy * (SUN[1] as number));
  return { kind: 'wall', textured: false, rgb: scale(tinted, 0.58 + 0.5 * sun) };
}

/** Every triangle of the world mesh, coloured, grouped by tile (tiles in key order). */
export function buildWorldTiles(g: MapGeometry, radar: RadarSampler, transform: RadarTransform, radarSize: { readonly width: number; readonly height: number }): { tiles: WorldTile[]; stats: WorldMeshStats } {
  const n = g.triangleCount;
  const tileOf = new Int32Array(n);
  const textured = new Uint8Array(n);
  const wallTri = new Uint8Array(n);
  const keys = new Map<string, number>();
  const counts: { floor: number; plain: number }[] = [];
  const colors = new Float32Array(n * 3);
  let floors = 0;
  let walls = 0;
  let undersides = 0;
  let indoor = 0;
  for (let t = 0; t < n; t++) {
    const v = g.triangle(t);
    const cx = ((v[0] as number) + (v[3] as number) + (v[6] as number)) / 3;
    const cy = ((v[1] as number) + (v[4] as number) + (v[7] as number)) / 3;
    const key = `${Math.floor(cx / TILE)},${Math.floor(cy / TILE)}`;
    let k = keys.get(key);
    if (k === undefined) {
      k = counts.length;
      keys.set(key, k);
      counts.push({ floor: 0, plain: 0 });
    }
    tileOf[t] = k;
    const f = faceColor(g, t, radar);
    textured[t] = f.textured ? 1 : 0;
    wallTri[t] = f.kind === 'wall' ? 1 : 0;
    const c = counts[k] as { floor: number; plain: number };
    if (f.textured) c.floor++;
    else c.plain++;
    if (f.kind === 'floor') floors++;
    else if (f.kind === 'indoor') indoor++;
    else if (f.kind === 'wall') walls++;
    else undersides++;
    colors.set(f.rgb, t * 3);
  }
  const tiles = [...keys.entries()].map(([key, k]) => {
    const c = counts[k] as { floor: number; plain: number };
    return {
      key,
      floor: { positions: new Float32Array(c.floor * 9), uvs: new Float32Array(c.floor * 6), colors: new Float32Array(c.floor * 9), fill: 0 },
      plain: { positions: new Float32Array(c.plain * 9), colors: new Float32Array(c.plain * 9), fill: 0 },
    };
  });
  for (let t = 0; t < n; t++) {
    const tile = tiles[tileOf[t] as number] as (typeof tiles)[number];
    const v = g.triangle(t);
    const part = textured[t] === 1 ? tile.floor : tile.plain;
    const o = part.fill * 9;
    const zMin = Math.min(v[2] as number, v[5] as number, v[8] as number);
    const wall = wallTri[t] === 1;
    for (let c = 0; c < 3; c++) {
      const x = v[c * 3] as number;
      const y = v[c * 3 + 1] as number;
      const z = v[c * 3 + 2] as number;
      part.positions.set(toThree(x, y, z), o + c * 3);
      // Walls darken toward their foot (a cheap ambient occlusion along tall faces) and carry a faint per-face grain.
      const ao = wall ? (WALL_FOOT + (1 - WALL_FOOT) * Math.min(1, (z - zMin) / WALL_AO_UNITS)) * (1 + grain(t)) : 1;
      part.colors[o + c * 3] = Math.min(1, (colors[t * 3] as number) * ao);
      part.colors[o + c * 3 + 1] = Math.min(1, (colors[t * 3 + 1] as number) * ao);
      part.colors[o + c * 3 + 2] = Math.min(1, (colors[t * 3 + 2] as number) * ao);
      if (textured[t] === 1) {
        const { px, py } = radarPx(transform, x, y);
        tile.floor.uvs[part.fill * 6 + c * 2] = px / radarSize.width;
        tile.floor.uvs[part.fill * 6 + c * 2 + 1] = py / radarSize.height;
      }
    }
    part.fill++;
  }
  const out: WorldTile[] = tiles
    .map((x) => ({
      key: x.key,
      floor: { positions: x.floor.positions, uvs: x.floor.uvs, colors: x.floor.colors, triangles: x.floor.fill },
      plain: { positions: x.plain.positions, colors: x.plain.colors, triangles: x.plain.fill },
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { tiles: out, stats: { triangles: n, floors, walls, undersides, indoorFloors: indoor, tiles: out.length } };
}

/**
 * X1: a map package's render mesh (G2RM: the BSP's drawn faces, displacements and props with baked colours,
 * src/app3d/render-package.ts, docs/maps.md) as tiles for the renderer: every triangle goes to the `plain` part of the
 * tile under its centre, with its vertices' colours (sRGB bytes → 0..1). No radar art: the package has its own
 * materials and lightmaps.
 */
export function buildRenderTiles(m: RenderMesh): WorldTile[] {
  const nt = m.tris.length / 3;
  const q = m.quant;
  const tileOf = new Int32Array(nt);
  const keys = new Map<string, number>();
  const counts: number[] = [];
  for (let t = 0; t < nt; t++) {
    let cx = 0;
    let cy = 0;
    for (let c = 0; c < 3; c++) {
      const v = m.tris[t * 3 + c] as number;
      cx += (m.positions[v * 3] as number) / q / 3;
      cy += (m.positions[v * 3 + 1] as number) / q / 3;
    }
    const key = `${Math.floor(cx / TILE)},${Math.floor(cy / TILE)}`;
    let k = keys.get(key);
    if (k === undefined) {
      k = counts.length;
      keys.set(key, k);
      counts.push(0);
    }
    tileOf[t] = k;
    counts[k] = (counts[k] as number) + 1;
  }
  const parts = counts.map((c) => ({ positions: new Float32Array(c * 9), colors: new Float32Array(c * 9), fill: 0 }));
  for (let t = 0; t < nt; t++) {
    const part = parts[tileOf[t] as number] as (typeof parts)[number];
    const o = part.fill * 9;
    for (let c = 0; c < 3; c++) {
      const v = m.tris[t * 3 + c] as number;
      part.positions.set(toThree((m.positions[v * 3] as number) / q, (m.positions[v * 3 + 1] as number) / q, (m.positions[v * 3 + 2] as number) / q), o + c * 3);
      for (let k = 0; k < 3; k++) part.colors[o + c * 3 + k] = (m.colors[v * 3 + k] as number) / 255;
    }
    part.fill++;
  }
  return [...keys.entries()]
    .map(([key, k]) => {
      const p = parts[k] as (typeof parts)[number];
      return { key, floor: { positions: new Float32Array(0), uvs: new Float32Array(0), colors: new Float32Array(0), triangles: 0 }, plain: { positions: p.positions, colors: p.colors, triangles: p.fill } };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
