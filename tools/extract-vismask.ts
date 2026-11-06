/**
 * Build the sight-blocking mask (C4 / A5) from the Mirage radar: data/mirage-radar.jpg → data/mirage-vismask.json.
 *
 *   npx tsx tools/extract-vismask.ts            # writes data/mirage-vismask.json and logs/vismask-debug.png
 *   npx tsx tools/extract-vismask.ts --check    # rebuilds in memory and fails if the committed file differs
 *
 * On the radar, playable space is coloured (blue-grey floors, tan rooms, teal stairs, white props) and walls and
 * out-of-map space are black or near-black. Steps (parameters in PARAMS, written into the file's `params`):
 *
 * 1. Classify each pixel (luminance L = 0.299 R + 0.587 G + 0.114 B, chroma C = max − min):
 *    open if L ≥ lumOpen, or if L ≥ lumTeal and C ≥ chromaTeal and the hue is blue-green (G ≥ R and B ≥ R; the dark
 *    teal stairs). Everything else is wall: black walls, the dark-grey grid lines and labels drawn in the
 *    background (L ≤ 60, C ≤ 6), and dark JPEG ringing next to tan rooms (reddish hue).
 * 2. Close the walls (dilate, then erode, by `closeRadius` with a square element): fills open cracks up to
 *    2 × closeRadius cells wide in a wall, so a lighter JPEG pixel can't open a hole through a thin wall. No
 *    doorway is that narrow (a player is 32 units = 6.4 cells wide).
 * 3. Remove open specks: 8-connected open components smaller than `minOpenArea` cells become wall (labels, ringing).
 * 4. Remove wall specks: 4-connected wall components smaller than `minWallArea` cells that don't touch the image
 *    border become open (dark JPEG noise on floors); pillars and wall stubs are larger.
 *
 * The output is run-length encoded per row (wall, open, wall, …), one row per line, at the radar's 5 units per
 * cell, with the radar transform. Same image in, same bytes out. jpeg-js is a devDependency (tools only).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import jpeg from 'jpeg-js';
import { VISMASK_FORMAT, encodeRow } from '../src/sim2d/vision';
import { encodePng } from './png';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RADAR_PATH = 'data/mirage-radar.jpg';
export const MASK_PATH = 'data/mirage-vismask.json';

/** Classification and cleanup parameters (docs/vision.md explains how they were tuned). */
export const PARAMS = {
  /** Luminance at or above which a pixel is open, whatever its colour. Grid lines peak at ≈ 60. */
  lumOpen: 72,
  /** Darker pixels are open only if blue-green (teal stairs, CT spawn shading) with at least this luminance… */
  lumTeal: 28,
  /** …and this chroma (max − min of R, G, B). Grid lines and JPEG noise on black have C ≤ 6. */
  chromaTeal: 12,
  /** Wall closing radius (cells, square element). */
  closeRadius: 1,
  /** Open components smaller than this (cells, 8-connected) become wall. */
  minOpenArea: 64,
  /** Wall components smaller than this (cells, 4-connected, not touching the border) become open. */
  minWallArea: 6,
} as const;

/** The radar transform (docs/conventions.md): px = (x + 3230) / 5, py = (1713 − y) / 5. */
const TRANSFORM = { unitsPerPx: 5, originX: -3230, originY: 1713 } as const;

export interface BuiltMask {
  readonly width: number;
  readonly height: number;
  /** 1 = wall. */
  readonly cells: Uint8Array;
  /** The raw classification before cleanup (1 = wall), for the debug image. */
  readonly raw: Uint8Array;
  /** Decoded radar, RGBA. */
  readonly rgba: Uint8Array;
  readonly stats: Record<string, number>;
}

/** Classify and clean the radar image. */
export function buildMask(jpg: Uint8Array): BuiltMask {
  const img = jpeg.decode(jpg, { useTArray: true, formatAsRGBA: true });
  const { width, height } = img;
  const rgba = new Uint8Array(img.data);
  const raw = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4] as number;
    const g = rgba[i * 4 + 1] as number;
    const b = rgba[i * 4 + 2] as number;
    raw[i] = isOpenColor(r, g, b) ? 0 : 1;
  }
  const stats: Record<string, number> = { rawWall: count(raw) };
  let cells = closeWalls(raw, width, height, PARAMS.closeRadius);
  stats['closed'] = count(cells) - stats['rawWall'];
  const openRemoved = removeSmall(cells, width, height, 0, PARAMS.minOpenArea, 8, false);
  stats['openSpecksRemoved'] = openRemoved.components;
  stats['openSpeckCells'] = openRemoved.cells;
  const wallRemoved = removeSmall(cells, width, height, 1, PARAMS.minWallArea, 4, true);
  stats['wallSpecksRemoved'] = wallRemoved.components;
  stats['wallSpeckCells'] = wallRemoved.cells;
  cells = new Uint8Array(cells);
  stats['wall'] = count(cells);
  stats['open'] = width * height - stats['wall'];
  return { width, height, cells, raw, rgba, stats };
}

/** Step 1: is this colour playable space? */
export function isOpenColor(r: number, g: number, b: number): boolean {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum >= PARAMS.lumOpen) return true;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  return lum >= PARAMS.lumTeal && chroma >= PARAMS.chromaTeal && g >= r && b >= r;
}

function count(cells: Uint8Array): number {
  let n = 0;
  for (const c of cells) n += c;
  return n;
}

/** Step 2: morphological closing of the wall set with a (2r+1)² square (outside the image counts as wall). */
function closeWalls(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return new Uint8Array(src);
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let j = -r; j <= r && v === 0; j++) {
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          const yy = y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || src[yy * w + xx] === 1) {
            v = 1;
            break;
          }
        }
      }
      dil[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let j = -r; j <= r && v === 1; j++) {
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          const yy = y + j;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && dil[yy * w + xx] === 0) {
            v = 0;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Steps 3–4: flip connected components of `value` smaller than `minArea` (in place). `keepBorder`: components
 * touching the image border are never flipped. Components are found in scan order (deterministic).
 */
function removeSmall(cells: Uint8Array, w: number, h: number, value: 0 | 1, minArea: number, conn: 4 | 8, keepBorder: boolean): { components: number; cells: number } {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const comp: number[] = [];
  let components = 0;
  let flipped = 0;
  const nb4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const nb8 = [...nb4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const nbs = conn === 8 ? nb8 : nb4;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] === 1 || cells[start] !== value) continue;
    comp.length = 0;
    stack.push(start);
    seen[start] = 1;
    let border = false;
    while (stack.length > 0) {
      const k = stack.pop() as number;
      comp.push(k);
      const x = k % w;
      const y = (k - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (const [dx, dy] of nbs) {
        const xx = x + (dx as number);
        const yy = y + (dy as number);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const kk = yy * w + xx;
        if (seen[kk] === 1 || cells[kk] !== value) continue;
        seen[kk] = 1;
        stack.push(kk);
      }
    }
    if (comp.length < minArea && !(keepBorder && border)) {
      components++;
      flipped += comp.length;
      for (const k of comp) cells[k] = value === 1 ? 0 : 1;
    }
  }
  return { components, cells: flipped };
}

/** The JSON text: fixed key order, one row per line, trailing newline. */
export function maskJsonText(m: BuiltMask, sha256: string): string {
  const head = {
    format: VISMASK_FORMAT,
    note: 'Sight-blocking mask of Mirage (C4). Cell (i, j) covers px in [i, i+1), py in [j, j+1) with px = (x - originX) / unitsPerPx, py = (originY - y) / unitsPerPx; rows top to bottom; each row lists run lengths alternating wall, open, wall, ... starting with wall (the first may be 0). Built by tools/extract-vismask.ts; see docs/vision.md.',
    width: m.width,
    height: m.height,
    unitsPerPx: TRANSFORM.unitsPerPx,
    originX: TRANSFORM.originX,
    originY: TRANSFORM.originY,
    source: { file: RADAR_PATH, sha256 },
    params: PARAMS,
    stats: m.stats,
  };
  const lines = JSON.stringify(head, null, 2).split('\n');
  lines.pop(); // closing brace
  const last = lines.length - 1;
  lines[last] = `${lines[last] as string},`;
  lines.push('  "rows": [');
  for (let y = 0; y < m.height; y++) {
    const runs = encodeRow(m.cells, y * m.width, m.width);
    lines.push(`    [${runs.join(',')}]${y === m.height - 1 ? '' : ','}`);
  }
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n') + '\n';
}

/** Debug overlay: walls tinted red, cells the cleanup changed in yellow (closed) or cyan (removed specks). */
export function debugImage(m: BuiltMask): Uint8Array {
  const out = new Uint8Array(m.rgba);
  for (let i = 0; i < m.width * m.height; i++) {
    const wall = m.cells[i] === 1;
    const rawWall = m.raw[i] === 1;
    let tint: [number, number, number] | null = null;
    let a = 0;
    if (wall && !rawWall) {
      tint = [255, 220, 0];
      a = 0.9;
    } else if (!wall && rawWall) {
      tint = [0, 230, 255];
      a = 0.9;
    } else if (wall) {
      tint = [160, 0, 0];
      a = 0.55;
    }
    if (tint !== null) for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round((out[i * 4 + c] as number) * (1 - a) + tint[c] * a);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function main(): void {
  const check = process.argv.includes('--check');
  const jpg = readFileSync(resolve(ROOT, RADAR_PATH));
  const sha = createHash('sha256').update(jpg).digest('hex');
  const m = buildMask(new Uint8Array(jpg));
  const text = maskJsonText(m, sha);
  const outPath = resolve(ROOT, MASK_PATH);
  if (check) {
    const have = readFileSync(outPath, 'utf8');
    if (have !== text) {
      console.error(`${MASK_PATH} is stale: run npx tsx tools/extract-vismask.ts`);
      process.exit(1);
    }
    console.log(`${MASK_PATH} is up to date`);
    return;
  }
  writeFileSync(outPath, text, 'utf8');
  const png = resolve(ROOT, 'logs/vismask-debug.png');
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png, encodePng(m.width, m.height, debugImage(m)));
  console.log(`${m.width}×${m.height}: ${JSON.stringify(m.stats)}`);
  console.log(`wrote ${outPath} (${text.length} bytes) and ${png}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
