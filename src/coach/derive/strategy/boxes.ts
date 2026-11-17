/**
 * K8 table `strategy.place_boxes`: an x/y box per place name, for drawing lanes, sites and zones on the 2D replay
 * (`zone` annotations, round boards). From the map's `places.json` (docs/coach/maps.md "Place names") when the
 * repo has one, else from this demo's own samples (the same rule: the bounds of every living player's position under
 * that name). A place with neither gets no box and is not drawn.
 */
import mirage from '../../../../data/coach/maps/de_mirage/places.json';
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { STRAT_GRID } from './grid';

export interface PlaceBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
}

interface PlacesFile {
  map: string;
  places: { name: string; centroid: { x: number; y: number }; bounds: { minX: number; minY: number; maxX: number; maxY: number } }[];
}

const FILES: Readonly<Record<string, PlacesFile>> = { de_mirage: mirage as PlacesFile };

export function buildPlaceBoxes(ctx: AnalysisContext): Map<string, PlaceBox> {
  const out = new Map<string, PlaceBox>();
  const file = FILES[ctx.match.meta.map];
  if (file !== undefined) {
    for (const p of file.places) out.set(p.name, { ...p.bounds, cx: p.centroid.x, cy: p.centroid.y });
  }
  // Fill the rest from the demo's samples.
  const grid = ctx.table(STRAT_GRID);
  const P = ctx.P;
  const acc = new Map<number, { minX: number; minY: number; maxX: number; maxY: number; sx: number; sy: number; n: number }>();
  for (const g of grid.rounds) {
    for (let k = 0; k < g.ticks.length; k++) {
      const row = g.rows[k] ?? 0;
      for (let p = 0; p < P; p++) {
        if ((g.zone[k * P + p] ?? -9) === -9) continue;
        const place = ctx.raw.ticks.place[row * P + p] ?? 0;
        if (place === 0) continue;
        const x = g.x[k * P + p] ?? 0;
        const y = g.y[k * P + p] ?? 0;
        const a = acc.get(place);
        if (a === undefined) acc.set(place, { minX: x, minY: y, maxX: x, maxY: y, sx: x, sy: y, n: 1 });
        else {
          a.minX = Math.min(a.minX, x); a.minY = Math.min(a.minY, y); a.maxX = Math.max(a.maxX, x); a.maxY = Math.max(a.maxY, y);
          a.sx += x; a.sy += y; a.n++;
        }
      }
    }
  }
  for (const [id, a] of [...acc.entries()].sort((x, y) => x[0] - y[0])) {
    const name = ctx.raw.names.places[id] ?? '';
    if (name === '' || out.has(name)) continue;
    out.set(name, { minX: Math.round(a.minX), minY: Math.round(a.minY), maxX: Math.round(a.maxX), maxY: Math.round(a.maxY), cx: Math.round(a.sx / a.n), cy: Math.round(a.sy / a.n) });
  }
  return out;
}

export const PLACE_BOXES: TableDef<Map<string, PlaceBox>> = { id: 'strategy.place_boxes', build: buildPlaceBoxes };

/** The box as a closed polygon (x, y), counter-clockwise. */
export function boxPolygon(b: PlaceBox): [number, number][] {
  return [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
}
