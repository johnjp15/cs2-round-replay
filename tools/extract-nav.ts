/**
 * Extract the Mirage nav mesh from the old single-file replay page into data/mirage-nav.json.
 *
 *   npx tsx tools/extract-nav.ts <path/to/web-apps/cs2/mirage-round-replay/index.html> [out.json] [--no-patches]
 *
 * The page embeds `<script id="data" type="application/json">` whose JSON has
 *   nav:    [x1, y1, x2, y2, z1, z2, placeIndex][]  (903 axis-aligned rectangles, Source units)
 *   places: string[]                                (27 names, index 0 is "")
 *   tracks: { [player]: [t, x, y, z, flag][] }      (recorded positions, 10 Hz)
 *
 * Source rows become areas 0..N-1 in source order. Unless --no-patches is given, 25×25 "patch"
 * cells are appended for holes in the exported mesh where recorded players actually stood or
 * walked (see docs/nav.md). Output is deterministic 2-space JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Area {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z1: number;
  z2: number;
  place: number;
}

const CELL = 25;
/** Consecutive track samples further apart than this are treated as a jump/teleport (not rasterised). */
const MAX_STEP = 60;
/** Sampling step along the chord between consecutive track samples. */
const RASTER_STEP = 5;

function main(): void {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const noPatches = process.argv.includes('--no-patches');
  const src = args[0];
  const out = args[1] ?? new URL('../data/mirage-nav.json', import.meta.url).pathname;
  if (src === undefined) {
    console.error('usage: npx tsx tools/extract-nav.ts <index.html> [out.json] [--no-patches]');
    process.exit(2);
  }
  const html = readFileSync(src, 'utf8');
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (m?.[1] === undefined) throw new Error('no <script id="data"> block found');
  const data = JSON.parse(m[1]) as { nav: unknown; places: unknown; tracks: unknown };

  const places = parsePlaces(data.places);
  const areas = parseNav(data.nav, places.length);
  const sourceCount = areas.length;
  if (!noPatches) {
    for (const p of buildPatches(areas, parseTracks(data.tracks))) areas.push(p);
  }

  const doc = { meta: { sourceAreas: sourceCount, patchAreas: areas.length - sourceCount, patchCell: CELL }, places, areas };
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`places ${places.length}, source areas ${sourceCount}, patch areas ${areas.length - sourceCount} -> ${out}`);
}

function parsePlaces(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new Error('places: expected string[]');
  return v as string[];
}

function parseNav(v: unknown, placeCount: number): Area[] {
  if (!Array.isArray(v)) throw new Error('nav: expected array');
  return v.map((row: unknown, id) => {
    if (!Array.isArray(row) || row.length !== 7 || !row.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`nav[${id}]: expected 7 numbers`);
    }
    const [x1, y1, x2, y2, z1, z2, place] = row as number[] as [number, number, number, number, number, number, number];
    if (!(x1 < x2) || !(y1 < y2)) throw new Error(`nav[${id}]: expected x1<x2 and y1<y2`);
    if (!Number.isInteger(place) || place < 0 || place >= placeCount) throw new Error(`nav[${id}]: bad place ${place}`);
    return { id, x1, y1, x2, y2, z1, z2, place };
  });
}

type Sample = [number, number, number]; // x, y, z

function parseTracks(v: unknown): Sample[][] {
  if (typeof v !== 'object' || v === null) throw new Error('tracks: expected object');
  const obj = v as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .map((id) => {
      const rows = obj[id];
      if (!Array.isArray(rows)) throw new Error(`tracks.${id}: expected array`);
      return rows.map((r: unknown): Sample => {
        const a = r as number[];
        return [Number(a[1]), Number(a[2]), Number(a[3])];
      });
    });
}

function inside(a: Area, x: number, y: number): boolean {
  return x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2;
}

/**
 * Cells (CELL×CELL, grid-aligned like the export) that contain a recorded position, or a point on
 * the chord between two consecutive positions, that no source area covers.
 */
function buildPatches(areas: Area[], tracks: Sample[][]): Area[] {
  const cells = new Map<string, { cx: number; cy: number; zs: number[] }>();
  const mark = (x: number, y: number, z: number): void => {
    if (areas.some((a) => inside(a, x, y))) return;
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    const key = `${cx},${cy}`;
    let c = cells.get(key);
    if (c === undefined) {
      c = { cx, cy, zs: [] };
      cells.set(key, c);
    }
    c.zs.push(z);
  };
  for (const tr of tracks) {
    for (let i = 0; i < tr.length; i++) {
      const s = tr[i] as Sample;
      mark(s[0], s[1], s[2]);
      if (i === 0) continue;
      const p = tr[i - 1] as Sample;
      const len = Math.hypot(s[0] - p[0], s[1] - p[1]);
      if (len > MAX_STEP) continue;
      const n = Math.ceil(len / RASTER_STEP);
      for (let k = 1; k < n; k++) {
        const f = k / n;
        mark(p[0] + (s[0] - p[0]) * f, p[1] + (s[1] - p[1]) * f, p[2] + (s[2] - p[2]) * f);
      }
    }
  }
  const sorted = [...cells.values()].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  let nextId = areas.length;
  return sorted.map((c) => {
    const zs = [...c.zs].sort((a, b) => a - b);
    const z = Math.round(zs[(zs.length - 1) >> 1] as number);
    const x1 = c.cx * CELL;
    const y1 = c.cy * CELL;
    return { id: nextId++, x1, y1, x2: x1 + CELL, y2: y1 + CELL, z1: z, z2: z, place: nearestPlace(areas, x1 + CELL / 2, y1 + CELL / 2, z) };
  });
}

/** Place of the nearest source area (2D distance to the rectangle plus |dz|), ties to the lower id. */
function nearestPlace(areas: Area[], x: number, y: number, z: number): number {
  let best = Infinity;
  let place = 0;
  for (const a of areas) {
    const dx = Math.max(a.x1 - x, 0, x - a.x2);
    const dy = Math.max(a.y1 - y, 0, y - a.y2);
    const d = Math.hypot(dx, dy) + Math.abs((a.z1 + a.z2) / 2 - z);
    if (d < best) {
      best = d;
      place = a.place;
    }
  }
  return place;
}

main();
